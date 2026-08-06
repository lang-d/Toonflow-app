import crypto from "node:crypto";
import u from "@/utils";
import { createTextAsset, deleteTextAssetFiles, getFullTextAssetContent } from "@/services/textAsset";
import { runLazyRetentionCleanup } from "@/services/retention";

export const DIRECTOR_PLAN_SECTION_KEYS = [
  "inputCheck",
  "directorPrinciples",
  "visualScheme",
  "continuity",
  "rhythm",
  "sceneExecution",
  "soundBoundary",
  "transitions",
  "derivedAssets",
] as const;

export type DirectorPlanSectionKey = (typeof DIRECTOR_PLAN_SECTION_KEYS)[number];

export const DIRECTOR_PLAN_SECTION_TITLES: Record<DirectorPlanSectionKey, string> = {
  inputCheck: "输入核对",
  directorPrinciples: "① 当前集导演总原则",
  visualScheme: "② 整体视觉方案与画面基调",
  continuity: "③ 资产与连续性锁定",
  rhythm: "④ 段落与节奏规划",
  sceneExecution: "⑤ 分场景执行规划",
  soundBoundary: "⑥ 声音边界",
  transitions: "⑦ 转场与视觉连续性",
  derivedAssets: "⑧ 衍生资产预划清单",
};

const ACTIVE_STATES = ["writing", "invalid", "failed"];
const COMMIT_STALE_MS = 5 * 60 * 1000;
const activeCommits = new Map<string, Promise<CommitDirectorPlanResult>>();

export type CommitDirectorPlanResult =
  | { status: "committed"; generationId: string; textAssetId: number; version: number; sectionCount: number; videoStyle: string }
  | { status: "invalid"; issues: Array<{ sectionKey?: string; message: string }> }
  | { status: "failed"; error: { code?: string; message: string; retryable?: boolean } };

function hash(value: string) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeVideoStyle(value: unknown) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("director plan videoStyle cannot be empty");
  if (normalized.length > 400) throw new Error("director plan videoStyle must be 400 characters or fewer");
  return normalized;
}

function normalizeDirectorPlanHeading(value: string) {
  return String(value || "")
    .replace(/^\s{0,3}#{1,6}\s*/, "")
    .replace(/^[>\s*_`~.-]+/, "")
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, "")
    .replace(/[：:|\s*_`~#-]/g, "")
    .trim();
}

function stripDuplicateSectionHeading(sectionKey: DirectorPlanSectionKey, content: string) {
  const trimmed = String(content || "").replace(/^\s+/, "");
  const match = /^([^\r\n]+)(?:\r?\n|$)([\s\S]*)$/.exec(trimmed);
  if (!match) return trimmed;
  const firstLine = match[1] || "";
  const rest = match[2] || "";
  if (normalizeDirectorPlanHeading(firstLine) === normalizeDirectorPlanHeading(DIRECTOR_PLAN_SECTION_TITLES[sectionKey])) {
    return rest.replace(/^\s+/, "");
  }
  return trimmed;
}

async function assertScope(database: any, projectId: number, scriptId: number) {
  const script = await database("o_script").where({ id: scriptId, projectId }).first("id");
  if (!script) throw new Error(`script ${scriptId} does not exist in project ${projectId}`);
}

export async function assertDirectorPlanGenerationScope(
  input: { generationId: string; projectId: number; scriptId: number },
  database: any = u.db,
) {
  const generation = await database("o_directorPlanGeneration").where({ generationId: input.generationId }).first();
  if (!generation) throw new Error("director plan generation does not exist");
  if (Number(generation.projectId) !== Number(input.projectId) || Number(generation.scriptId) !== Number(input.scriptId)) {
    throw new Error("director plan generation does not belong to current project/script");
  }
  return generation;
}

function serializeError(error: any) {
  return {
    code: String(error?.code || "DIRECTOR_PLAN_COMMIT_FAILED"),
    message: String(error?.message || error || "director plan commit failed"),
    retryable: true,
  };
}

async function nextChunkIndex(database: any, generationId: string, sectionKey: DirectorPlanSectionKey) {
  const rows = await database("o_directorPlanGenerationChunk")
    .where({ generationId, sectionKey })
    .orderBy("chunkIndex", "asc")
    .select("chunkIndex");
  let next = 0;
  for (const row of rows) {
    if (Number(row.chunkIndex) !== next) break;
    next += 1;
  }
  return next;
}

export async function beginDirectorPlanGeneration(input: { projectId: number; scriptId: number }, database: any = u.db) {
  await assertScope(database, input.projectId, input.scriptId);
  await runLazyRetentionCleanup({ database });
  const now = Date.now();
  const committing = await database("o_directorPlanGeneration")
    .where({ projectId: input.projectId, scriptId: input.scriptId, state: "committing" })
    .orderBy("updatedAt", "desc")
    .first();
  if (committing && Number(committing.updatedAt) >= now - COMMIT_STALE_MS) {
    throw new Error("director plan generation commit is already in progress");
  }
  if (committing) {
    await database("o_directorPlanGeneration").where({ generationId: committing.generationId }).update({
      state: "failed",
      errorJson: JSON.stringify({ code: "STALE_COMMIT", message: "stale director plan commit recovered" }),
      updatedAt: now,
    });
  }

  const generationId = crypto.randomUUID();
  await database.transaction(async (trx: any) => {
    await trx("o_directorPlanGeneration")
      .where({ projectId: input.projectId, scriptId: input.scriptId })
      .whereIn("state", ACTIVE_STATES)
      .update({
        state: "superseded",
        errorJson: JSON.stringify({
          code: "GENERATION_SUPERSEDED",
          message: "director plan generation was superseded by a newer generation",
        }),
        updatedAt: now,
      });
    await trx("o_directorPlanGeneration").insert({
      generationId,
      projectId: input.projectId,
      scriptId: input.scriptId,
      expectedSectionCount: DIRECTOR_PLAN_SECTION_KEYS.length,
      state: "writing",
      textAssetId: null,
      version: null,
      videoStyle: null,
      contentHash: null,
      errorJson: null,
      createdAt: now,
      updatedAt: now,
    });
  });
  return { generationId, sectionKeys: DIRECTOR_PLAN_SECTION_KEYS };
}

export async function appendDirectorPlanSection(input: {
  generationId: string;
  sectionKey: DirectorPlanSectionKey;
  chunkIndex: number;
  content: string;
}, database: any = u.db) {
  const content = String(input.content || "");
  if (!content.trim()) throw new Error("director plan section chunk cannot be empty");
  if (!DIRECTOR_PLAN_SECTION_KEYS.includes(input.sectionKey)) throw new Error(`invalid sectionKey: ${input.sectionKey}`);
  if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 0) throw new Error("chunkIndex must be non-negative");
  const generation = await database("o_directorPlanGeneration").where({ generationId: input.generationId }).first();
  if (!generation) throw new Error("director plan generation does not exist");
  if (!["writing", "invalid"].includes(generation.state)) {
    throw new Error(`director plan generation is ${generation.state}`);
  }

  const nextIndex = await nextChunkIndex(database, input.generationId, input.sectionKey);
  if (input.chunkIndex > nextIndex) {
    return { accepted: 0, nextChunkIndex: nextIndex, conflict: `missing chunk ${nextIndex}` };
  }
  const contentHash = hash(content);
  const existing = await database("o_directorPlanGenerationChunk")
    .where({ generationId: input.generationId, sectionKey: input.sectionKey, chunkIndex: input.chunkIndex })
    .first();
  if (existing) {
    if (String(existing.contentHash) !== contentHash) {
      return { accepted: 0, nextChunkIndex: nextIndex, conflict: `chunk ${input.chunkIndex} has different content` };
    }
    return { accepted: 0, nextChunkIndex: nextIndex, conflict: null };
  }
  if (input.chunkIndex !== nextIndex) {
    return { accepted: 0, nextChunkIndex: nextIndex, conflict: `expected chunk ${nextIndex}` };
  }

  const now = Date.now();
  await database.transaction(async (trx: any) => {
    await trx("o_directorPlanGenerationChunk").insert({
      generationId: input.generationId,
      sectionKey: input.sectionKey,
      chunkIndex: input.chunkIndex,
      content,
      contentHash,
      createdAt: now,
      updatedAt: now,
    });
    await trx("o_directorPlanGeneration").where({ generationId: input.generationId }).update({
      state: "writing",
      errorJson: null,
      updatedAt: now,
    });
  });
  return { accepted: 1, nextChunkIndex: input.chunkIndex + 1, conflict: null };
}

function assembleDirectorPlan(chunks: any[]) {
  const grouped = new Map<string, any[]>();
  for (const chunk of chunks) {
    const values = grouped.get(String(chunk.sectionKey)) || [];
    values.push(chunk);
    grouped.set(String(chunk.sectionKey), values);
  }
  const issues: Array<{ sectionKey?: string; message: string }> = [];
  const sections: string[] = [];
  for (const sectionKey of DIRECTOR_PLAN_SECTION_KEYS) {
    const values = (grouped.get(sectionKey) || []).sort((a, b) => Number(a.chunkIndex) - Number(b.chunkIndex));
    if (!values.length) {
      issues.push({ sectionKey, message: "required section is missing" });
      continue;
    }
    values.forEach((value, index) => {
      if (Number(value.chunkIndex) !== index) issues.push({ sectionKey, message: `missing chunk ${index}` });
      const content = String(value.content || "");
      if (String(value.contentHash || "") !== hash(content)) {
        issues.push({ sectionKey, message: `chunk ${index} hash mismatch` });
      }
    });
    const content = stripDuplicateSectionHeading(sectionKey, values.map((value) => String(value.content || "")).join("\n"));
    if (!content) issues.push({ sectionKey, message: "section content is empty" });
    sections.push(`## ${DIRECTOR_PLAN_SECTION_TITLES[sectionKey]}\n\n${content}`);
  }
  return { content: sections.join("\n\n---\n\n"), issues };
}

export async function commitDirectorPlanGeneration(
  generationId: string,
  videoStyle: string,
  database: any = u.db,
): Promise<CommitDirectorPlanResult> {
  const initial = await database("o_directorPlanGeneration").where({ generationId }).first();
  if (!initial) throw new Error("director plan generation does not exist");
  if (initial.state === "committed") {
    return {
      status: "committed",
      generationId,
      textAssetId: Number(initial.textAssetId),
      version: Number(initial.version),
      sectionCount: Number(initial.expectedSectionCount),
      videoStyle: String(initial.videoStyle || ""),
    };
  }
  if (initial.state === "superseded") {
    return { status: "failed", error: { code: "GENERATION_SUPERSEDED", message: "generation was superseded" } };
  }
  const normalizedVideoStyle = normalizeVideoStyle(videoStyle);
  const scopeKey = `${initial.projectId}:${initial.scriptId}`;
  const active = activeCommits.get(scopeKey);
  if (active) return { status: "failed", error: { code: "COMMIT_IN_PROGRESS", message: "commit is in progress" } };

  const promise = (async (): Promise<CommitDirectorPlanResult> => {
    const locked = await database("o_directorPlanGeneration")
      .where({ generationId })
      .whereIn("state", ["writing", "invalid", "failed"])
      .update({ state: "committing", errorJson: null, updatedAt: Date.now() });
    if (!locked) return { status: "failed", error: { code: "COMMIT_IN_PROGRESS", message: "commit is in progress" } };
    try {
      const generation = await database("o_directorPlanGeneration").where({ generationId }).first();
      await assertScope(database, Number(generation.projectId), Number(generation.scriptId));
      const chunks = await database("o_directorPlanGenerationChunk")
        .where({ generationId })
        .orderBy("sectionKey", "asc")
        .orderBy("chunkIndex", "asc");
      const assembled = assembleDirectorPlan(chunks);
      if (assembled.issues.length) {
        await database("o_directorPlanGeneration").where({ generationId }).update({
          state: "invalid",
          errorJson: JSON.stringify({ code: "VALIDATION_FAILED", issues: assembled.issues }),
          updatedAt: Date.now(),
        });
        return { status: "invalid", issues: assembled.issues };
      }

      const contentHash = hash(assembled.content);
      let asset = await database("o_textAsset")
        .where({
          projectId: generation.projectId,
          scriptId: generation.scriptId,
          targetType: "scriptPlan",
          targetId: "director-plan",
          state: "complete",
          hash: contentHash,
        })
        .andWhere("createTime", ">=", generation.createdAt)
        .orderBy("id", "desc")
        .first();

      let createdAssetForCleanup: any = null;
      try {
        await database.transaction(async (trx: any) => {
          if (!asset) {
            asset = await createTextAsset(
              {
                projectId: Number(generation.projectId),
                scriptId: Number(generation.scriptId),
                targetType: "scriptPlan",
                targetId: "director-plan",
                content: assembled.content,
                summary: "",
                state: "complete",
              },
              trx,
            );
            createdAssetForCleanup = asset;
          }

          await trx("o_directorPlanGeneration").where({ generationId }).update({
            state: "committed",
            textAssetId: Number(asset.id),
            version: Number(asset.version),
            videoStyle: normalizedVideoStyle,
            contentHash,
            errorJson: null,
            updatedAt: Date.now(),
          });
          await trx("o_directorPlanGeneration")
            .where({ projectId: generation.projectId, scriptId: generation.scriptId })
            .whereIn("state", ACTIVE_STATES)
            .whereNot({ generationId })
            .update({
              state: "superseded",
              errorJson: JSON.stringify({ code: "GENERATION_SUPERSEDED", message: "superseded by committed generation" }),
              updatedAt: Date.now(),
            });
        });
      } catch (error) {
        if (createdAssetForCleanup?.filePath) {
          await deleteTextAssetFiles([{ filePath: String(createdAssetForCleanup.filePath) }]).catch(() => undefined);
        }
        throw error;
      }
      return {
        status: "committed",
        generationId,
        textAssetId: Number(asset.id),
        version: Number(asset.version),
        sectionCount: DIRECTOR_PLAN_SECTION_KEYS.length,
        videoStyle: normalizedVideoStyle,
      };
    } catch (error) {
      const serialized = serializeError(error);
      await database("o_directorPlanGeneration").where({ generationId }).update({
        state: "failed",
        errorJson: JSON.stringify(serialized),
        updatedAt: Date.now(),
      });
      return { status: "failed", error: serialized };
    }
  })().finally(() => activeCommits.delete(scopeKey));
  activeCommits.set(scopeKey, promise);
  return promise;
}

export async function getCommittedDirectorPlanVideoStyle(
  input: { projectId: number; scriptId: number },
  database: any = u.db,
) {
  const generation = await database("o_directorPlanGeneration")
    .where({ projectId: input.projectId, scriptId: input.scriptId, state: "committed" })
    .orderBy("updatedAt", "desc")
    .orderBy("generationId", "desc")
    .first("videoStyle");
  return String(generation?.videoStyle || "").trim();
}

export async function getDirectorPlanGenerationState(projectId: number, scriptId: number, database: any = u.db) {
  let latest: any;
  let failure: any;
  try {
    latest = await database("o_directorPlanGeneration")
      .where({ projectId, scriptId })
      .orderBy("updatedAt", "desc")
      .first();
    failure = await database("o_directorPlanGeneration")
      .where({ projectId, scriptId })
      .whereIn("state", ["invalid", "failed"])
      .orderBy("updatedAt", "desc")
      .first();
  } catch (error: any) {
    if (
      error?.code === "SQLITE_ERROR" &&
      /no such table:\s*o_directorPlanGeneration/i.test(String(error?.message || error))
    ) {
      return { current: null, lastFailure: null };
    }
    throw error;
  }
  return {
    current: latest
      ? {
          generationId: latest.generationId,
          state: latest.state,
          textAssetId: latest.textAssetId,
          version: latest.version,
          updatedAt: latest.updatedAt,
        }
      : null,
    lastFailure: failure
      ? {
          generationId: failure.generationId,
          state: failure.state,
          errorJson: failure.errorJson,
          updatedAt: failure.updatedAt,
        }
      : null,
  };
}

export async function readDirectorPlanAsset(input: {
  projectId: number;
  scriptId: number;
  textAssetId?: number;
}, database: any = u.db) {
  let query = database("o_textAsset").where({
    projectId: input.projectId,
    scriptId: input.scriptId,
    targetType: "scriptPlan",
    state: "complete",
  });
  if (input.textAssetId != null) query = query.andWhere("id", input.textAssetId);
  const asset = await query.orderBy("version", "desc").orderBy("id", "desc").first();
  if (!asset) throw new Error("director plan text asset not found");
  const result = await getFullTextAssetContent({ id: Number(asset.id), projectId: input.projectId }, database);
  const generation = await database("o_directorPlanGeneration")
    .where({
      projectId: input.projectId,
      scriptId: input.scriptId,
      textAssetId: Number(asset.id),
      state: "committed",
    })
    .first("generationId", "videoStyle");
  return {
    id: Number(asset.id),
    version: Number(asset.version),
    generationId: generation?.generationId == null ? null : String(generation.generationId),
    videoStyle: generation?.videoStyle == null ? null : String(generation.videoStyle).trim(),
    content: result.content,
  };
}
