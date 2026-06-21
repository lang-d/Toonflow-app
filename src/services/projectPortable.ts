import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import db from "@/utils/db";
import {
  projectDirectory,
  projectMediaDirectory,
  storageMode,
  legacyDataRoot,
} from "@/services/storagePaths";

const FORMAT = "toonflow-project";
const VERSION = 1;
const ACTIVE_STATUSES = new Set(["pending", "queued", "submitting", "processing", "confirming", "capacity_wait"]);
const EXIT_SNAPSHOT_TIMEOUT_MS = 60_000;

type SnapshotTables = Record<string, any[]>;

export interface PortableProjectSnapshot {
  format: typeof FORMAT;
  version: number;
  exportedAt: number;
  projectId: number;
  revision: number;
  project: any;
  tables: SnapshotTables;
  media: Array<{ path: string; size: number; sha256: string }>;
}

function mediaRoot(projectId: number) {
  return storageMode() === "workspace"
    ? projectMediaDirectory(projectId)
    : path.join(legacyDataRoot(), "oss", String(projectId));
}

async function listFiles(root: string, current = root): Promise<string[]> {
  try {
    const entries = await fs.readdir(current, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...(await listFiles(root, fullPath)));
      else if (entry.isFile()) files.push(path.relative(root, fullPath).split(path.sep).join("/"));
    }
    return files;
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function fileDigest(filePath: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function atomicReplace(temporaryPath: string, targetPath: string) {
  try {
    await fs.rename(temporaryPath, targetPath);
    return;
  } catch (error: any) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
  }
  const backupPath = `${targetPath}.previous`;
  await fs.rm(backupPath, { force: true });
  await fs.rename(targetPath, backupPath);
  try {
    await fs.rename(temporaryPath, targetPath);
    await fs.rm(backupPath, { force: true });
  } catch (error) {
    await fs.rename(backupPath, targetPath).catch(() => {});
    throw error;
  }
}

async function collectProjectTables(database: any, projectId: number): Promise<SnapshotTables> {
  return database.transaction(async (trx: any) => {
    const tables: SnapshotTables = {};
    const read = async (table: string, apply: (query: any) => any = (query) => query) => {
      if (!(await trx.schema.hasTable(table))) return [];
      return apply(trx(table));
    };
    const directTables = [
      "o_novel",
      "o_script",
      "o_assets",
      "o_storyboard",
      "o_video",
      "o_videoTrack",
      "o_workbenchMergedReference",
      "o_directorAsset",
      "o_storyArtifact",
      "o_storyAnnotation",
      "o_storyRevisionMap",
      "o_productionReviewSuggestion",
      "o_productionReviewFeedback",
      "o_textAsset",
      "o_editImageTask",
    ];
    tables.o_project = await read("o_project", (query) => query.where("id", projectId));
    for (const table of directTables) {
      tables[table] = await read(table, (query) => query.where("projectId", projectId));
    }

    const ids = (table: string) => new Set((tables[table] || []).map((row) => Number(row.id)));
    const novelIds = [...ids("o_novel")];
    const scriptIds = [...ids("o_script")];
    const assetIds = [...ids("o_assets")];
    const storyboardIds = [...ids("o_storyboard")];
    const flowIds = [
      ...new Set(
        [...tables.o_assets, ...tables.o_storyboard, ...tables.o_directorAsset]
          .map((row) => Number(row.flowId))
          .filter((value) => Number.isFinite(value) && value > 0),
      ),
    ];
    tables.o_eventChapter = novelIds.length
      ? await read("o_eventChapter", (query) => query.whereIn("novelId", novelIds))
      : [];
    const eventIds = [...new Set(tables.o_eventChapter.map((row) => Number(row.eventId)))];
    tables.o_event = eventIds.length ? await read("o_event", (query) => query.whereIn("id", eventIds)) : [];
    tables.o_image = assetIds.length
      ? await read("o_image", (query) => query.whereIn("assetsId", assetIds))
      : [];
    tables.o_imageFlow = flowIds.length
      ? await read("o_imageFlow", (query) => query.whereIn("id", flowIds))
      : [];
    tables.o_assets2Storyboard = storyboardIds.length
      ? await read("o_assets2Storyboard", (query) => query.whereIn("storyboardId", storyboardIds))
      : [];
    tables.o_scriptAssets = scriptIds.length
      ? await read("o_scriptAssets", (query) => query.whereIn("scriptId", scriptIds))
      : [];
    tables.o_assetsRole2Audio = assetIds.length
      ? await read("o_assetsRole2Audio", (query) =>
          query.whereIn("assetsRoleId", assetIds).orWhereIn("assetsAudioId", assetIds),
        )
      : [];
    return tables;
  });
}

function sanitizeSnapshot(tables: SnapshotTables) {
  for (const row of tables.o_editImageTask || []) {
    row.reason = row.reason ? String(row.reason).slice(0, 4096) : row.reason;
  }
}

export async function generateProjectSnapshot(
  projectId: number,
  database: any = db,
  options: { workspaceRoot?: string; mediaRoot?: string } = {},
) {
  const project = await database("o_project").where("id", projectId).first();
  if (!project) throw new Error("Project does not exist");
  let storage = await database("o_projectStorage").where("projectId", projectId).first();
  if (!storage) {
    await database("o_projectStorage").insert({
      projectId,
      storageKey: String(projectId),
      revision: 1,
      snapshotRevision: 0,
      snapshotState: "stale",
    });
    storage = await database("o_projectStorage").where("projectId", projectId).first();
  }
  await database("o_projectStorage").where("projectId", projectId).update({
    snapshotState: "writing",
    errorReason: null,
  });
  try {
    const tables = await collectProjectTables(database, projectId);
    sanitizeSnapshot(tables);
    const root = options.mediaRoot || mediaRoot(projectId);
    const files = await listFiles(root);
    const media = [];
    for (const relativePath of files) {
      const fullPath = path.join(root, ...relativePath.split("/"));
      const stat = await fs.stat(fullPath);
      media.push({ path: relativePath, size: stat.size, sha256: await fileDigest(fullPath) });
    }
    const snapshot: PortableProjectSnapshot = {
      format: FORMAT,
      version: VERSION,
      exportedAt: Date.now(),
      projectId,
      revision: Number(storage.revision || 1),
      project,
      tables,
      media,
    };
    const directory = options.workspaceRoot
      ? path.join(options.workspaceRoot, "projects", String(storage.storageKey || projectId))
      : projectDirectory(storage.storageKey || projectId);
    await fs.mkdir(directory, { recursive: true });
    const snapshotPath = path.join(directory, "project.toonflow");
    const temporaryPath = `${snapshotPath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(snapshot), "utf8");
    JSON.parse(await fs.readFile(temporaryPath, "utf8"));
    await atomicReplace(temporaryPath, snapshotPath);
    const manifest = {
      format: FORMAT,
      version: VERSION,
      projectId,
      storageKey: storage.storageKey || String(projectId),
      name: project.name || "",
      revision: snapshot.revision,
      exportedAt: snapshot.exportedAt,
      mediaCount: media.length,
      mediaBytes: media.reduce((total, item) => total + item.size, 0),
    };
    const manifestPath = path.join(directory, "manifest.json");
    await fs.writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2), "utf8");
    await atomicReplace(`${manifestPath}.tmp`, manifestPath);
    const snapshotStat = await fs.stat(snapshotPath);
    await database("o_projectStorage").where("projectId", projectId).update({
      snapshotRevision: snapshot.revision,
      snapshotState: "ready",
      lastSnapshotAt: Date.now(),
      errorReason: null,
    });
    return {
      projectId,
      directory,
      snapshotPath,
      manifestPath,
      manifest,
      revision: snapshot.revision,
      snapshotRevision: snapshot.revision,
      mediaCount: media.length,
      mediaBytes: manifest.mediaBytes,
      size: snapshotStat.size,
    };
  } catch (error: any) {
    await database("o_projectStorage").where("projectId", projectId).update({
      snapshotState: "failed",
      errorReason: String(error?.message || error).slice(0, 4096),
    });
    throw error;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function generateStaleProjectSnapshotsOnExit(
  database: any = db,
  options: { timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? EXIT_SNAPSHOT_TIMEOUT_MS;
  const startedAt = Date.now();
  const stale = await database("o_projectStorage")
    .where("snapshotState", "stale")
    .whereRaw("revision > snapshotRevision")
    .orderBy("projectId");
  const results: Array<{ projectId: number; status: "completed" | "failed" | "skipped"; reason?: string }> = [];
  for (const item of stale) {
    const remaining = startedAt + timeoutMs - Date.now();
    const projectId = Number(item.projectId);
    if (remaining <= 0) {
      results.push({ projectId, status: "skipped", reason: "Exit snapshot timeout reached" });
      continue;
    }
    try {
      await withTimeout(
        generateProjectSnapshot(projectId, database),
        remaining,
        "Exit snapshot timeout reached",
      );
      results.push({ projectId, status: "completed" });
    } catch (error: any) {
      await database("o_projectStorage").where("projectId", projectId).update({
        snapshotState: "stale",
        errorReason: String(error?.message || error).slice(0, 4096),
      });
      results.push({ projectId, status: "failed", reason: String(error?.message || error) });
    }
  }
  return {
    scanned: stale.length,
    completed: results.filter((item) => item.status === "completed").length,
    failed: results.filter((item) => item.status === "failed").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    results,
  };
}

function nextIdFactory() {
  let value = Date.now() * 100;
  return () => ++value;
}

function rewritePath(value: unknown, oldProjectId: number, newProjectId: number) {
  if (typeof value !== "string") return value;
  return value
    .replace(
      new RegExp(`^(\\/?)${oldProjectId}(?=[/\\\\])`),
      (_match, slash) => `${slash}${newProjectId}`,
    )
    .replace(
      new RegExp(`^projects[/\\\\]${oldProjectId}(?=[/\\\\])`),
      `projects/${newProjectId}`,
    )
    .replace(
      new RegExp(`^textAssets[/\\\\]${oldProjectId}[/\\\\](.+)$`),
      (_match, rest) => `projects/${newProjectId}/text/${rest}`,
    );
}

export async function importPortableProject(sourceDirectory: string, database: any = db) {
  const snapshotPath = path.join(path.resolve(sourceDirectory), "project.toonflow");
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as PortableProjectSnapshot;
  if (snapshot.format !== FORMAT || snapshot.version !== VERSION || !snapshot.tables?.o_project?.[0]) {
    throw new Error("Invalid Toonflow portable project");
  }
  for (const media of snapshot.media || []) {
    const filePath = path.join(sourceDirectory, "media", ...media.path.split("/"));
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size !== Number(media.size) || (await fileDigest(filePath)) !== media.sha256) {
      throw new Error(`Portable project media validation failed: ${media.path}`);
    }
  }
  const oldProjectId = Number(snapshot.projectId);
  let newProjectId = oldProjectId;
  if (await database("o_project").where("id", newProjectId).first()) {
    newProjectId = Date.now();
    while (await database("o_project").where("id", newProjectId).first()) newProjectId += 1;
  }
  const nextId = nextIdFactory();
  const idTables = [
    "o_novel",
    "o_event",
    "o_eventChapter",
    "o_script",
    "o_assets",
    "o_image",
    "o_storyboard",
    "o_agentWorkData",
    "o_video",
    "o_videoTrack",
    "o_workbenchMergedReference",
    "o_directorAsset",
    "o_storyArtifact",
    "o_storyAnnotation",
    "o_storyRevisionMap",
    "o_productionReviewSuggestion",
    "o_productionReviewFeedback",
    "o_textAsset",
    "o_imageFlow",
    "o_editImageTask",
    "o_videoGenerationTask",
    "o_tasks",
    "o_taskEvent",
  ];
  const maps = new Map<string, Map<number, number>>();
  for (const table of idTables) {
    const map = new Map<number, number>();
    for (const row of snapshot.tables[table] || []) {
      if (row.id != null) map.set(Number(row.id), nextId());
    }
    maps.set(table, map);
  }
  const mapId = (table: string, value: unknown) =>
    value == null ? value : maps.get(table)?.get(Number(value)) ?? value;
  const taskIds = new Map<string, string>();
  for (const row of snapshot.tables.o_tasks || []) if (row.taskId) taskIds.set(row.taskId, randomUUID());
  const remapJsonValue = (value: any, key = "", parent: any = null): any => {
    if (Array.isArray(value)) return value.map((item) => remapJsonValue(item, "", value));
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        result[childKey] = remapJsonValue(childValue, childKey, value);
      }
      return result;
    }
    if (typeof value === "string") {
      if (taskIds.has(value)) return taskIds.get(value);
      return rewritePath(value, oldProjectId, newProjectId);
    }
    if (typeof value !== "number") return value;
    const direct: Record<string, string> = {
      projectId: "o_project",
      scriptId: "o_script",
      assetId: "o_assets",
      assetsId: "o_assets",
      imageId: "o_image",
      directorAssetId: "o_directorAsset",
      storyboardId: "o_storyboard",
      flowId: "o_imageFlow",
      trackId: "o_videoTrack",
      videoTrackId: "o_videoTrack",
      videoId: "o_video",
      taskCenterId: "o_tasks",
      legacyTaskId: "o_tasks",
    };
    if (key === "projectId") return newProjectId;
    if (direct[key]) return mapId(direct[key], value);
    if (key === "targetId") {
      return /storyboard/i.test(String(parent?.targetType))
        ? mapId("o_storyboard", value)
        : mapId("o_assets", value);
    }
    if (key === "sourceId" || key === "id") {
      const source = String(parent?.source || parent?.sources || parent?.type || "");
      if (/directorAsset/i.test(source)) return mapId("o_directorAsset", value);
      if (/storyboard/i.test(source)) return mapId("o_storyboard", value);
      if (/asset/i.test(source)) return mapId("o_assets", value);
      if (/merged/i.test(source)) return mapId("o_workbenchMergedReference", value);
    }
    return value;
  };

  const remapRow = (table: string, source: any) => {
    const row = structuredClone(source);
    if (table === "o_project") row.id = newProjectId;
    else if (table === "memories") row.id = randomUUID();
    else if (row.id != null && maps.has(table)) row.id = mapId(table, row.id);
    if ("projectId" in row) row.projectId = newProjectId;
    if (table === "memories" && typeof row.isolationKey === "string") {
      row.isolationKey = row.isolationKey.replace(new RegExp(`^${oldProjectId}:`), `${newProjectId}:`);
    }
    const fields: Array<[string, string]> = [
      ["novelId", "o_novel"],
      ["eventId", "o_event"],
      ["scriptId", "o_script"],
      ["assetId", "o_assets"],
      ["assetsId", "o_assets"],
      ["assetsRoleId", "o_assets"],
      ["assetsAudioId", "o_assets"],
      ["imageId", "o_image"],
      ["directorAssetId", "o_directorAsset"],
      ["artifactId", "o_storyArtifact"],
      ["sourceArtifactId", "o_storyArtifact"],
      ["newArtifactId", "o_storyArtifact"],
      ["suggestionId", "o_productionReviewSuggestion"],
      ["parentId", "o_productionReviewSuggestion"],
      ["storyboardId", "o_storyboard"],
      ["flowId", "o_imageFlow"],
      ["trackId", "o_videoTrack"],
      ["videoTrackId", "o_videoTrack"],
      ["videoId", "o_video"],
      ["selectVideoId", "o_video"],
      ["taskCenterId", "o_tasks"],
      ["legacyTaskId", "o_tasks"],
    ];
    for (const [field, targetTable] of fields) if (row[field] != null) row[field] = mapId(targetTable, row[field]);
    if (row.businessId != null) {
      const businessType = String(row.businessType || "");
      if (businessType === "video-generation") row.businessId = mapId("o_video", row.businessId);
      else if (businessType === "image-flow") row.businessId = mapId("o_editImageTask", row.businessId);
      else if (businessType.includes("asset")) row.businessId = mapId("o_assets", row.businessId);
      else if (businessType.includes("storyboard")) row.businessId = mapId("o_storyboard", row.businessId);
      else if (businessType === "video-track-prompt") row.businessId = mapId("o_videoTrack", row.businessId);
    }
    if (row.targetId != null) {
      if (table === "o_productionReviewSuggestion") {
        const targetType = String(row.targetType || "");
        if (targetType === "storyboard" || targetType === "storyboardImage") {
          row.targetId = mapId("o_storyboard", row.targetId);
        } else if (targetType === "asset" || targetType === "deriveAsset") {
          row.targetId = mapId("o_assets", row.targetId);
        } else if (targetType === "videoPrompt" || targetType === "storyboardGroup" || targetType === "bgmSuggestion") {
          const numeric = Number(row.targetId);
          row.targetId = Number.isFinite(numeric) ? mapId("o_videoTrack", numeric) : row.targetId;
        } else if (targetType === "videoResult") {
          row.targetId = mapId("o_video", row.targetId);
        }
      } else {
        row.targetId = /storyboard/i.test(String(row.targetType))
          ? mapId("o_storyboard", row.targetId)
          : mapId("o_assets", row.targetId);
      }
    }
    if (row.taskId && taskIds.has(row.taskId)) row.taskId = taskIds.get(row.taskId);
    if (row.filePath) row.filePath = rewritePath(row.filePath, oldProjectId, newProjectId);
    if (row.url) row.url = rewritePath(row.url, oldProjectId, newProjectId);
    for (const jsonField of [
      "flowData",
      "referenceImages",
      "sourceRefs",
      "musicPlanJson",
      "reviewIssuesJson",
      "contentJson",
      "annotationIds",
      "proposedPatch",
      "references",
      "requestJson",
      "payloadJson",
      "resultJson",
      "relatedObjects",
      "camera",
      "stageDraft",
    ]) {
      if (typeof row[jsonField] !== "string" || !row[jsonField]) continue;
      try {
        row[jsonField] = JSON.stringify(remapJsonValue(JSON.parse(row[jsonField])));
      } catch {
        row[jsonField] = rewritePath(row[jsonField], oldProjectId, newProjectId);
      }
    }
    const status = String(row.status || row.phase || "");
    if ((table === "o_tasks" || table === "o_videoGenerationTask" || table === "o_editImageTask") && ACTIVE_STATUSES.has(status)) {
      row.status = "failed";
      row.phase = "import-interrupted";
      row.state = "生成失败";
      row.reason = "Task was active when the project was exported";
      row.errorReason = "Task was active when the project was exported";
      row.finishTime = Date.now();
      row.submitId = null;
      row.officialTaskId = null;
      row.historyRecordId = null;
      row.providerTaskId = null;
      row.providerSubmittedAt = null;
      row.leaseOwner = null;
      row.leaseExpiresAt = null;
    }
    return row;
  };

  const insertOrder = [
    "o_project",
    "o_novel",
    "o_event",
    "o_eventChapter",
    "o_script",
    "o_imageFlow",
    "o_image",
    "o_assets",
    "o_directorAsset",
    "o_storyArtifact",
    "o_storyAnnotation",
    "o_storyRevisionMap",
    "o_productionReviewSuggestion",
    "o_productionReviewFeedback",
    "o_textAsset",
    "o_videoTrack",
    "o_storyboard",
    "o_video",
    "o_workbenchMergedReference",
    "o_agentWorkData",
    "o_tasks",
    "o_taskEvent",
    "o_editImageTask",
    "o_videoGenerationTask",
    "o_assets2Storyboard",
    "o_scriptAssets",
    "o_assetsRole2Audio",
    "memories",
  ];
  await database.transaction(async (trx: any) => {
    for (const table of insertOrder) {
      const rows = (snapshot.tables[table] || []).map((row) => remapRow(table, row));
      if (rows.length) await trx(table).insert(rows);
    }
    await trx("o_projectStorage").where("projectId", newProjectId).update({
      storageKey: String(newProjectId),
      snapshotRevision: 0,
      snapshotState: "stale",
    });
    const interruptedVideoIds = (snapshot.tables.o_videoGenerationTask || [])
      .filter((row) => ACTIVE_STATUSES.has(String(row.status || row.phase || "")))
      .map((row) => mapId("o_video", row.videoId))
      .filter(Boolean);
    if (interruptedVideoIds.length) {
      await trx("o_video").whereIn("id", interruptedVideoIds).update({
        state: "生成失败",
        errorReason: "导入时任务中断",
      });
    }
    const interruptedImageTasks = (snapshot.tables.o_editImageTask || []).filter((row) =>
      ACTIVE_STATUSES.has(String(row.status || row.phase || "")),
    );
    const storyboardIds = interruptedImageTasks
      .filter((row) => /storyboard/i.test(String(row.targetType)))
      .map((row) => mapId("o_storyboard", row.targetId))
      .filter(Boolean);
    if (storyboardIds.length) {
      await trx("o_storyboard").whereIn("id", storyboardIds).update({
        state: "生成失败",
        reason: "导入时任务中断",
      });
    }
    const assetIds = interruptedImageTasks
      .filter((row) => !/storyboard/i.test(String(row.targetType)))
      .map((row) => mapId("o_assets", row.targetId || row.deriveAssetId))
      .filter(Boolean);
    if (assetIds.length) {
      const imageIds = (await trx("o_assets").whereIn("id", assetIds).select("imageId"))
        .map((row: any) => row.imageId)
        .filter(Boolean);
      if (imageIds.length) {
        await trx("o_image").whereIn("id", imageIds).update({
          state: "生成失败",
          errorReason: "导入时任务中断",
        });
      }
    }
  });

  const sourceMedia = path.join(sourceDirectory, "media");
  const targetMedia = projectMediaDirectory(newProjectId);
  await fs.mkdir(path.dirname(targetMedia), { recursive: true });
  await fs.cp(sourceMedia, targetMedia, { recursive: true, force: false }).catch((error: any) => {
    if (error?.code !== "ENOENT") throw error;
  });
  const sourceText = path.join(sourceDirectory, "text");
  const targetText = path.join(projectDirectory(newProjectId), "text");
  await fs.mkdir(path.dirname(targetText), { recursive: true });
  await fs.cp(sourceText, targetText, { recursive: true, force: false }).catch((error: any) => {
    if (error?.code !== "ENOENT") throw error;
  });
  const result = await generateProjectSnapshot(newProjectId, database);
  const importedProject = await database("o_project").where("id", newProjectId).first();
  const vendorIds = [
    importedProject?.imageModel,
    importedProject?.videoModel,
  ]
    .filter(Boolean)
    .map((model: string) => String(model).split(":")[0])
    .filter(Boolean);
  const availableVendors = vendorIds.length
    ? await database("o_vendorConfig").whereIn("id", [...new Set(vendorIds)]).select("id")
    : [];
  const availableIds = new Set(availableVendors.map((item: any) => String(item.id)));
  const warnings = [...new Set(vendorIds)]
    .filter((vendorId) => !availableIds.has(vendorId))
    .map((vendorId) => `Missing model provider: ${vendorId}`);
  return {
    projectId: newProjectId,
    importedAsCopy: newProjectId !== oldProjectId,
    directory: result.directory,
    warnings,
  };
}
