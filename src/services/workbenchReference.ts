import path from "node:path";
import { Knex } from "knex";
import u from "@/utils";
import { ReferenceList } from "@/utils/ai";
import { resolveDirectorAsset } from "@/services/directorAsset";

export type WorkbenchReferenceSource = "storyboard" | "assets" | "merged" | "directorAsset";

export interface WorkbenchReferenceInput {
  id: number;
  sources: WorkbenchReferenceSource;
}

export interface QueuedWorkbenchReference extends WorkbenchReferenceInput {
  order: number;
}

export interface StoredSourceReference extends WorkbenchReferenceInput {
  order: number;
  label?: string;
  category?: string;
  parentName?: string;
  name?: string;
  index?: number;
}

export interface ResolvedWorkbenchReference {
  id: number;
  sources: WorkbenchReferenceSource;
  filePath: string;
  fileType: "image" | "video" | "audio";
  name: string;
  prompt?: string;
  category?: string;
  parentName?: string;
  index?: number;
  sourceRefs?: StoredSourceReference[];
  videoDesc?: string;
  duration?: string | number;
  track?: string;
  shouldGenerateImage?: number;
  associateAssetsIds?: number[];
}

export interface ResolvedLocalWorkbenchReference extends ResolvedWorkbenchReference {
  localFilePath: string;
  order: number;
}

interface ResolveOptions {
  projectId?: number;
  scriptId?: number;
  trackId?: number;
  storyboardTrackId?: number;
  requireFile?: boolean;
  knex?: Knex | Knex.Transaction;
}

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg", ".tif", ".tiff"]);
const videoExtensions = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);
const audioExtensions = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".aiff"]);

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function detectFileType(type: unknown, filePath: string): "image" | "video" | "audio" {
  const normalizedType = String(type || "").toLowerCase();
  if (normalizedType === "audio") return "audio";
  if (normalizedType === "video" || normalizedType === "clip") {
    const ext = path.extname(filePath || "").toLowerCase();
    if (audioExtensions.has(ext)) return "audio";
    if (videoExtensions.has(ext)) return "video";
  }
  const ext = path.extname(filePath || "").toLowerCase();
  if (audioExtensions.has(ext)) return "audio";
  if (videoExtensions.has(ext)) return "video";
  if (imageExtensions.has(ext) || !ext) return "image";
  return "image";
}

function assertOwnership(value: unknown, expected: number | undefined, message: string) {
  if (expected != null && Number(value) !== expected) throw new Error(message);
}

async function resolveOne(input: WorkbenchReferenceInput, options: ResolveOptions): Promise<ResolvedWorkbenchReference> {
  const db = options.knex ?? u.db;
  if (input.sources === "directorAsset") return resolveDirectorAssetReference(input, options);
  if (input.sources === "storyboard") {
    const row = await db("o_storyboard").where("id", input.id).first();
    if (!row) throw new Error(`分镜引用不存在：${input.id}`);
    assertOwnership(row.projectId, options.projectId, `分镜 ${input.id} 不属于当前项目`);
    assertOwnership(row.scriptId, options.scriptId, `分镜 ${input.id} 不属于当前剧集`);
    if (options.storyboardTrackId != null && row.trackId != null) {
      assertOwnership(row.trackId, options.storyboardTrackId, `分镜 ${input.id} 不属于当前轨道`);
    }
    const associates = await db("o_assets2Storyboard").where("storyboardId", input.id).orderBy("rowid").select("assetId");
    return {
      id: input.id,
      sources: "storyboard",
      filePath: row.filePath || "",
      fileType: "image",
      name: `P${Number(row.index ?? 0) + 1}`,
      prompt: row.prompt || "",
      index: row.index ?? undefined,
      videoDesc: "",
      duration: row.duration ?? undefined,
      track: row.track || "",
      shouldGenerateImage: row.shouldGenerateImage ?? undefined,
      associateAssetsIds: associates.map((item: any) => Number(item.assetId)),
    };
  }

  if (input.sources === "assets") {
    const row = await db("o_assets")
      .leftJoin("o_image", "o_image.id", "o_assets.imageId")
      .leftJoin({ parentAsset: "o_assets" }, "parentAsset.id", "o_assets.assetsId")
      .where("o_assets.id", input.id)
      .select(
        "o_assets.id",
        "o_assets.projectId",
        "o_assets.name",
        "o_assets.prompt",
        "o_assets.type",
        "o_assets.assetsId",
        "o_image.filePath",
        "o_image.type as imageType",
        "parentAsset.name as parentName",
      )
      .first();
    if (!row) throw new Error(`资产引用不存在：${input.id}`);
    assertOwnership(row.projectId, options.projectId, `资产 ${input.id} 不属于当前项目`);
    return {
      id: input.id,
      sources: "assets",
      filePath: row.filePath || "",
      fileType: detectFileType(row.imageType || row.type, row.filePath || ""),
      name: row.name || `资产${input.id}`,
      prompt: row.prompt || "",
      category: row.type || "other",
      parentName: row.parentName || undefined,
    };
  }

  if (input.sources === "merged") {
    const row = await db("o_workbenchMergedReference").where({ id: input.id, state: "active" }).first();
    if (!row) throw new Error(`合图引用不存在：${input.id}`);
    assertOwnership(row.projectId, options.projectId, `合图 ${input.id} 不属于当前项目`);
    assertOwnership(row.scriptId, options.scriptId, `合图 ${input.id} 不属于当前剧集`);
    assertOwnership(row.trackId, options.trackId, `合图 ${input.id} 不属于当前轨道`);
    return {
      id: input.id,
      sources: "merged",
      filePath: row.filePath || "",
      fileType: "image",
      name: row.name || "合图引用",
      prompt: row.prompt || "",
      sourceRefs: parseJsonArray<StoredSourceReference>(row.sourceRefs),
    };
  }

  throw new Error(`不支持的引用来源：${(input as any).sources}`);
}

async function resolveDirectorAssetReference(input: WorkbenchReferenceInput, options: ResolveOptions) {
  const db = options.knex ?? u.db;
  const row = await resolveDirectorAsset(input.id, { projectId: options.projectId, knex: db });
  return {
    id: input.id,
    sources: "directorAsset" as const,
    filePath: u.mediaRef.normalizeMediaPath(row.filePath || ""),
    fileType: "image" as const,
    name: row.name || row.assetName || `Director asset ${input.id}`,
    prompt: row.promptFragment || "",
    category: row.assetType || "directorAsset",
    sourceRefs: parseJsonArray<StoredSourceReference>(row.sourceRefs),
  };
}

export async function resolveWorkbenchReferences(
  inputs: WorkbenchReferenceInput[],
  options: ResolveOptions = {},
): Promise<ResolvedWorkbenchReference[]> {
  const resolved: ResolvedWorkbenchReference[] = [];
  for (const input of inputs) {
    const item = await resolveOne(input, options);
    if (options.requireFile !== false && !item.filePath) {
      throw new Error(`${item.sources} 引用 ${item.id} 没有可用文件`);
    }
    resolved.push(item);
  }
  return resolved;
}

export async function referencesToAiInput(items: ResolvedWorkbenchReference[]): Promise<ReferenceList[]> {
  const result: ReferenceList[] = [];
  for (const item of items) {
    result.push({
      type: item.fileType,
      base64: await u.oss.getImageBase64(item.filePath),
    } as ReferenceList);
  }
  return result;
}

export async function resolveQueuedWorkbenchReferences(
  inputs: QueuedWorkbenchReference[],
  options: ResolveOptions = {},
): Promise<ResolvedLocalWorkbenchReference[]> {
  const ordered = [...inputs].sort((a, b) => a.order - b.order);
  const resolved = await resolveWorkbenchReferences(ordered, options);
  const result: ResolvedLocalWorkbenchReference[] = [];
  for (let index = 0; index < resolved.length; index += 1) {
    result.push({
      ...resolved[index],
      order: ordered[index].order,
      localFilePath: await u.oss.getLocalFilePath(resolved[index].filePath),
    });
  }
  return result;
}

export function validateReferenceLimits(items: ResolvedWorkbenchReference[], mode: unknown) {
  let normalizedMode: unknown = mode;
  if (typeof mode === "string" && mode.trim().startsWith("[")) {
    try {
      normalizedMode = JSON.parse(mode);
    } catch {}
  }
  const counts = items.reduce(
    (result, item) => {
      result[item.fileType] += 1;
      return result;
    },
    { image: 0, video: 0, audio: 0 },
  );
  if (normalizedMode === "text" && items.length) throw new Error("纯文本模式不接受引用素材");
  if (normalizedMode === "singleImage") {
    if (counts.image > 1 || counts.video || counts.audio) throw new Error("单图模式只允许 1 张图片");
    return;
  }
  if (["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(normalizedMode))) {
    if (counts.image > 2 || counts.video || counts.audio) throw new Error("首尾帧模式最多允许 2 张图片");
    return;
  }
  if (!Array.isArray(normalizedMode)) return;
  const limits = { image: 0, video: 0, audio: 0 };
  for (const entry of normalizedMode) {
    if (typeof entry !== "string") continue;
    const [key, rawLimit] = entry.split(":");
    const limit = Number(rawLimit);
    if (!Number.isFinite(limit)) continue;
    if (key === "imageReference") limits.image = limit;
    if (key === "videoReference") limits.video = limit;
    if (key === "audioReference") limits.audio = limit;
  }
  for (const type of ["image", "video", "audio"] as const) {
    if (counts[type] > limits[type]) {
      throw new Error(`${type} 引用数量 ${counts[type]} 超过模型限制 ${limits[type]}`);
    }
  }
}

export async function resolveReferenceUrls(
  inputs: WorkbenchReferenceInput[],
): Promise<Record<string, Awaited<ReturnType<typeof u.mediaRef.toMediaRef>> | null>> {
  const result: Record<string, Awaited<ReturnType<typeof u.mediaRef.toMediaRef>> | null> = {};
  for (const input of inputs) {
    try {
      const [item] = await resolveWorkbenchReferences([input], { requireFile: false });
      result[`${input.id}:${input.sources}`] = item.filePath
        ? await u.mediaRef.toMediaRef(item.filePath, { source: input.sources, sourceId: input.id })
        : null;
    } catch {
      result[`${input.id}:${input.sources}`] = null;
    }
  }
  return result;
}

export async function archiveMergedReferencesForTrack(trackId: number, knex: Knex | Knex.Transaction = u.db) {
  await knex("o_workbenchMergedReference").where({ trackId, state: "active" }).update({
    state: "archived",
    updateTime: Date.now(),
  });
}

export async function deleteMergedReferences(
  filters: { projectId?: number; scriptIds?: number[]; trackIds?: number[] },
  knex: Knex | Knex.Transaction = u.db,
) {
  let query = knex("o_workbenchMergedReference").select("id", "filePath");
  if (filters.projectId != null) query = query.where("projectId", filters.projectId);
  if (filters.scriptIds?.length) query = query.whereIn("scriptId", filters.scriptIds);
  if (filters.trackIds?.length) query = query.whereIn("trackId", filters.trackIds);
  const rows = await query;
  if (!rows.length) return;
  await knex("o_workbenchMergedReference").whereIn(
    "id",
    rows.map((item: any) => item.id),
  ).delete();
  await Promise.all(
    rows.map(async (item: any) => {
      if (!item.filePath) return;
      try {
        await u.oss.deleteFile(item.filePath);
      } catch {}
    }),
  );
}
