import crypto from "node:crypto";
import u from "@/utils";
import {
  assetIdsFromStoryboardRow,
  StoryboardGroupPlanV2,
  StoryboardTableIssue,
  StoryboardTableRowV2,
  storyboardGroupPlanV2Schema,
  storyboardRowToDbPatch,
  storyboardTableRowV2Schema,
  validateStoryboardTableRows,
} from "@/services/storyboardTableContract";
import { syncVideoTracksForStoryboards } from "@/services/storyboardGroupPlanner";
import { getProjectDefaultVideoPolicy, VideoDurationPolicy } from "@/services/videoModelPolicy";

export const STORYBOARD_BATCH_SIZE = 10;
export const STORYBOARD_ROW_MAX_BYTES = 32 * 1024;
export const STORYBOARD_BATCH_MAX_BYTES = 256 * 1024;
export const STORYBOARD_GENERATION_TTL_MS = 24 * 60 * 60 * 1000;
export const STORYBOARD_FAILED_RETRY_COOLDOWN_MS = 30 * 1000;
export const STORYBOARD_COMMIT_STALE_MS = 5 * 60 * 1000;
const STORYBOARD_ACTIVE_GENERATION_STATES = ["writing", "invalid", "failed"] as const;
const STORYBOARD_EXPIRE_GENERATION_STATES = ["writing", "invalid", "failed", "committing", "superseded"] as const;

export interface BeginStoryboardGenerationInput {
  projectId: number;
  scriptId: number;
  expectedRowCount: number;
  groups: StoryboardGroupPlanV2[];
}

export interface AppendStoryboardRowsInput {
  generationId: string;
  startIndex: number;
  rows: StoryboardTableRowV2[];
}

export type StoryboardGenerationFailure = {
  message: string;
  code?: string;
  name?: string;
  stack?: string;
  retryable?: boolean;
};

export type CommitStoryboardGenerationResult =
  | { status: "committed"; rowCount: number; groupCount: number; revision: number }
  | { status: "invalid"; issues: StoryboardTableIssue[] }
  | { status: "failed"; error: StoryboardGenerationFailure };

const activeStoryboardCommits = new Map<string, Promise<void>>();

function storyboardCommitScopeKey(projectId: unknown, scriptId: unknown) {
  return `${Number(projectId)}:${Number(scriptId)}`;
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function rowHash(value: string) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function generationIssue(field: string, message: string): StoryboardTableIssue {
  return { index: -1, field, message };
}

function serializeGenerationError(error: unknown): StoryboardGenerationFailure {
  const anyError = error as any;
  const message = anyError?.message ? String(anyError.message) : String(error || "unknown storyboard commit error");
  return {
    message: message.slice(0, 2000),
    code: anyError?.code ? String(anyError.code).slice(0, 200) : undefined,
    name: anyError?.name ? String(anyError.name).slice(0, 200) : undefined,
    stack: anyError?.stack ? String(anyError.stack).slice(0, 4000) : undefined,
  };
}

function parseStoredGenerationError(value: unknown, fallback: string): StoryboardGenerationFailure {
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed?.message) return serializeGenerationError(parsed);
    } catch {
      return { message: value.slice(0, 2000) };
    }
  }
  return { message: fallback };
}

function validationIssuesJson(issues: StoryboardTableIssue[]) {
  return JSON.stringify({ message: "storyboard generation validation failed", issues });
}

function storedGenerationErrorCode(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const parsed = JSON.parse(value);
    return parsed?.code ? String(parsed.code) : "";
  } catch {
    return "";
  }
}

function failedRetryCoolingDown(generation: any) {
  if (storedGenerationErrorCode(generation?.errorJson) === "STALE_COMMIT_RECOVERED") return false;
  return (
    generation?.state === "failed" &&
    Number.isFinite(Number(generation.updatedAt)) &&
    Date.now() - Number(generation.updatedAt) < STORYBOARD_FAILED_RETRY_COOLDOWN_MS
  );
}

function commitInProgressError(): StoryboardGenerationFailure {
  return {
    code: "COMMIT_IN_PROGRESS",
    message: "storyboard generation commit is already in progress",
    retryable: true,
  };
}

function isStaleCommittingGeneration(generation: any) {
  if (generation?.state !== "committing") return false;
  const scopeKey = storyboardCommitScopeKey(generation.projectId, generation.scriptId);
  if (activeStoryboardCommits.has(scopeKey)) return false;
  const updatedAt = Number(generation.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt > STORYBOARD_COMMIT_STALE_MS;
}

async function recoverStaleCommittingGeneration(knex: any, generation: any) {
  if (!isStaleCommittingGeneration(generation)) return generation;
  const laterCommitted = await knex("o_storyboardGeneration")
    .where({ projectId: generation.projectId, scriptId: generation.scriptId, state: "committed" })
    .andWhere("updatedAt", ">", Number(generation.updatedAt || 0))
    .orderBy("updatedAt", "desc")
    .first("generationId");
  const errorJson = laterCommitted
    ? {
        message: "stale storyboard commit was superseded by a newer committed generation",
        code: "STALE_COMMIT_SUPERSEDED",
      }
    : {
        message: "stale storyboard commit was recovered after the process stopped while committing",
        code: "STALE_COMMIT_RECOVERED",
        retryable: true,
      };
  await knex("o_storyboardGeneration")
    .where({ generationId: generation.generationId, state: "committing" })
    .update({
      state: laterCommitted ? "superseded" : "failed",
      errorJson: JSON.stringify(errorJson),
      updatedAt: Date.now(),
    });
  return knex("o_storyboardGeneration").where({ generationId: generation.generationId }).first();
}

async function recoverStaleCommittingGenerationsForScope(knex: any, projectId: number, scriptId: number) {
  const committingRows = await knex("o_storyboardGeneration").where({ projectId, scriptId, state: "committing" });
  for (const generation of committingRows) {
    await recoverStaleCommittingGeneration(knex, generation);
  }
}

async function withStoryboardCommitLock<T extends CommitStoryboardGenerationResult>(
  scopeKey: string,
  task: () => Promise<T>,
): Promise<T | { status: "failed"; error: StoryboardGenerationFailure }> {
  if (activeStoryboardCommits.has(scopeKey)) {
    return {
      status: "failed",
      error: commitInProgressError(),
    };
  }
  let release!: () => void;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  activeStoryboardCommits.set(scopeKey, lock);
  try {
    return await task();
  } finally {
    if (activeStoryboardCommits.get(scopeKey) === lock) activeStoryboardCommits.delete(scopeKey);
    release();
  }
}

async function nextGenerationIndex(knex: any, generationId: string) {
  const rows = await knex("o_storyboardGenerationRow")
    .where({ generationId })
    .orderBy("rowIndex", "asc")
    .select("rowIndex");
  let nextIndex = 0;
  for (const row of rows) {
    if (Number(row.rowIndex) !== nextIndex) break;
    nextIndex += 1;
  }
  return nextIndex;
}

async function assertStoryboardGenerationScope(knex: any, projectId: number, scriptId: number) {
  if (!Number.isFinite(projectId) || !Number.isFinite(scriptId)) {
    throw new Error("storyboard generation scope is invalid");
  }
  const script = await knex("o_script").where({ id: scriptId, projectId }).first("id");
  if (!script) {
    throw new Error(`script ${scriptId} does not exist in project ${projectId}`);
  }
}

export async function cleanupExpiredStoryboardGenerations(knex: any = u.db) {
  const cutoff = Date.now() - STORYBOARD_GENERATION_TTL_MS;
  const expired = await knex("o_storyboardGeneration")
    .whereIn("state", STORYBOARD_EXPIRE_GENERATION_STATES)
    .andWhere("updatedAt", "<", cutoff)
    .select("generationId");
  const ids = expired.map((item: any) => String(item.generationId));
  if (!ids.length) return 0;
  await knex.transaction(async (trx: any) => {
    await trx("o_storyboardGenerationRow").whereIn("generationId", ids).del();
    await trx("o_storyboardGeneration").whereIn("generationId", ids).update({
      state: "expired",
      updatedAt: Date.now(),
    });
  });
  return ids.length;
}

export async function beginStoryboardGeneration(input: BeginStoryboardGenerationInput, knex: any = u.db) {
  const expectedRowCount = Number(input.expectedRowCount);
  if (!Number.isInteger(expectedRowCount) || expectedRowCount <= 0) {
    throw new Error("expectedRowCount must be a positive integer");
  }
  const groups = input.groups.map((group) => storyboardGroupPlanV2Schema.parse(group));
  const indexes = groups.flatMap((group) => group.storyboardIndexes);
  const uniqueIndexes = new Set(indexes);
  if (indexes.length !== expectedRowCount || uniqueIndexes.size !== expectedRowCount) {
    throw new Error("groups.storyboardIndexes must cover every storyboard index exactly once");
  }
  for (let index = 0; index < expectedRowCount; index += 1) {
    if (!uniqueIndexes.has(index)) throw new Error(`groups.storyboardIndexes is missing index ${index}`);
  }

  await assertStoryboardGenerationScope(knex, Number(input.projectId), Number(input.scriptId));
  await cleanupExpiredStoryboardGenerations(knex);
  await recoverStaleCommittingGenerationsForScope(knex, Number(input.projectId), Number(input.scriptId));
  const now = Date.now();
  const generationId = crypto.randomUUID();
  const committing = await knex("o_storyboardGeneration")
    .where({ projectId: input.projectId, scriptId: input.scriptId, state: "committing" })
    .first("generationId");
  if (committing) {
    throw new Error("storyboard generation commit is already in progress");
  }
  await knex.transaction(async (trx: any) => {
    await trx("o_storyboardGeneration")
      .where({ projectId: input.projectId, scriptId: input.scriptId })
      .whereIn("state", STORYBOARD_ACTIVE_GENERATION_STATES)
      .update({
        state: "superseded",
        errorJson: JSON.stringify({
          message: "storyboard generation was superseded by a newer generation",
          code: "GENERATION_SUPERSEDED",
        }),
        updatedAt: now,
      });
    await trx("o_storyboardGeneration").insert({
      generationId,
      projectId: input.projectId,
      scriptId: input.scriptId,
      expectedRowCount,
      groupPlanJson: JSON.stringify(groups),
      state: "writing",
      revision: null,
      errorJson: null,
      createdAt: now,
      updatedAt: now,
    });
  });
  return { generationId, nextIndex: 0, batchSize: STORYBOARD_BATCH_SIZE };
}

export async function appendStoryboardRows(input: AppendStoryboardRowsInput, knex: any = u.db) {
  if (!input.rows.length || input.rows.length > STORYBOARD_BATCH_SIZE) {
    throw new Error(`rows must contain between 1 and ${STORYBOARD_BATCH_SIZE} items`);
  }
  const generation = await knex("o_storyboardGeneration").where({ generationId: input.generationId }).first();
  if (!generation) throw new Error("storyboard generation does not exist");
  if (!["writing", "invalid"].includes(generation.state)) {
    throw new Error(`storyboard generation is ${generation.state}`);
  }

  const rows = input.rows.map((row) => storyboardTableRowV2Schema.parse(row));
  const issues = validateStoryboardTableRows(rows);
  const serialized = rows.map((row) => JSON.stringify(row));
  serialized.forEach((value, index) => {
    if (byteLength(value) > STORYBOARD_ROW_MAX_BYTES) {
      issues.push({
        index,
        field: "row",
        message: `row exceeds ${STORYBOARD_ROW_MAX_BYTES} bytes`,
      });
    }
  });
  if (serialized.reduce((sum, value) => sum + byteLength(value), 0) > STORYBOARD_BATCH_MAX_BYTES) {
    issues.push(generationIssue("rows", `batch exceeds ${STORYBOARD_BATCH_MAX_BYTES} bytes`));
  }
  const nextIndex = await nextGenerationIndex(knex, input.generationId);
  rows.forEach((row, index) => {
    if (row.index < 0 || row.index >= Number(generation.expectedRowCount)) {
      issues.push({
        index,
        field: "index",
        message: `index ${row.index} is outside expected range 0-${Number(generation.expectedRowCount) - 1}`,
      });
    }
  });
  const seenIndexes = new Set<number>();
  rows.forEach((row, index) => {
    if (seenIndexes.has(row.index)) issues.push({ index, field: "index", message: `duplicate row index ${row.index}` });
    seenIndexes.add(row.index);
  });
  if (issues.length) {
    await knex("o_storyboardGeneration").where({ generationId: input.generationId }).update({
      state: "invalid",
      errorJson: validationIssuesJson(issues),
      updatedAt: Date.now(),
    });
    return {
      accepted: 0,
      nextIndex,
      totalAccepted: nextIndex,
      expectedRowCount: Number(generation.expectedRowCount),
      issues,
    };
  }

  const existingRows = await knex("o_storyboardGenerationRow")
    .where({ generationId: input.generationId })
    .whereIn(
      "rowIndex",
      rows.map((row) => row.index),
    );
  const existingMap = new Map<number, any>(existingRows.map((row: any) => [Number(row.rowIndex), row]));
  const conflicts: StoryboardTableIssue[] = [];
  serialized.forEach((value, index) => {
    const rowIndex = rows[index].index;
    const existing = existingMap.get(rowIndex);
    if (existing && existing.rowHash !== rowHash(value)) {
      conflicts.push({ index, field: "index", message: `row ${rowIndex} was already written with different content` });
    }
  });
  if (conflicts.length) {
    return {
      accepted: 0,
      nextIndex,
      totalAccepted: nextIndex,
      expectedRowCount: Number(generation.expectedRowCount),
      issues: conflicts,
    };
  }

  let accepted = 0;
  await knex.transaction(async (trx: any) => {
    for (const [index, row] of rows.entries()) {
      if (existingMap.has(row.index)) continue;
      const value = serialized[index];
      await trx("o_storyboardGenerationRow").insert({
        generationId: input.generationId,
        rowIndex: row.index,
        rowJson: value,
        rowHash: rowHash(value),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      accepted += 1;
    }
    await trx("o_storyboardGeneration").where({ generationId: input.generationId }).update({
      state: "writing",
      errorJson: null,
      updatedAt: Date.now(),
    });
  });
  const updatedNextIndex = await nextGenerationIndex(knex, input.generationId);
  const totalRow = await knex("o_storyboardGenerationRow")
    .where({ generationId: input.generationId })
    .count({ count: "*" })
    .first();
  return {
    accepted,
    nextIndex: updatedNextIndex,
    totalAccepted: Number(totalRow?.count || 0),
    expectedRowCount: Number(generation.expectedRowCount),
    issues: [],
  };
}

async function validateAssets(knex: any, projectId: number, rows: StoryboardTableRowV2[]) {
  const ids = [...new Set(rows.flatMap(assetIdsFromStoryboardRow))];
  if (!ids.length) return [] as StoryboardTableIssue[];
  const assets = await knex("o_assets").whereIn("id", ids).select("id", "projectId");
  const valid = new Set(
    assets.filter((asset: any) => Number(asset.projectId) === projectId).map((asset: any) => Number(asset.id)),
  );
  return rows.flatMap((row, rowIndex) =>
    row.requiredAssets
      .filter((asset) => !valid.has(asset.assetId))
      .map((asset) => ({
        index: rowIndex,
        field: "requiredAssets",
        message: `asset ${asset.assetId} does not exist in project ${projectId}`,
      })),
  );
}

function validateGroups(
  rows: StoryboardTableRowV2[],
  groups: StoryboardGroupPlanV2[],
  durationPolicy?: VideoDurationPolicy,
) {
  const issues: StoryboardTableIssue[] = [];
  const groupMap = new Map(groups.map((group) => [group.groupKey, group]));
  const sortedRows = [...rows].sort((a, b) => a.index - b.index);
  rows.forEach((row, rowIndex) => {
    const group = groupMap.get(row.groupKey);
    if (!group) {
      issues.push({ index: rowIndex, field: "groupKey", message: `unknown groupKey ${row.groupKey}` });
      return;
    }
    if (!group.storyboardIndexes.includes(row.index)) {
      issues.push({
        index: rowIndex,
        field: "groupKey",
        message: `row index ${row.index} is not listed in group ${row.groupKey}`,
      });
    }
  });
  for (const group of groups) {
    const actual = sortedRows.filter((row) => row.groupKey === group.groupKey).map((row) => row.index);
    if (JSON.stringify(actual) !== JSON.stringify(group.storyboardIndexes)) {
      issues.push(generationIssue(`groups.${group.groupKey}`, "storyboard indexes do not match the submitted rows"));
    }
    const sortedIndexes = [...group.storyboardIndexes].sort((a, b) => a - b);
    for (let index = 1; index < sortedIndexes.length; index += 1) {
      if (sortedIndexes[index] !== sortedIndexes[index - 1] + 1) {
        issues.push(generationIssue(`groups.${group.groupKey}`, "storyboard indexes must be continuous"));
        break;
      }
    }
    if (JSON.stringify(sortedIndexes) !== JSON.stringify(group.storyboardIndexes)) {
      issues.push(generationIssue(`groups.${group.groupKey}`, "storyboard indexes must be in ascending order"));
    }
    const totalDuration = rows
      .filter((row) => row.groupKey === group.groupKey)
      .reduce((sum, row) => sum + (Number(row.durationSec) || 0), 0);
    if (
      durationPolicy?.canValidate &&
      Number.isFinite(totalDuration) &&
      totalDuration > Number(durationPolicy.maxDuration)
    ) {
      issues.push(
        generationIssue(
          `groups.${group.groupKey}.durationSec`,
          `group duration ${totalDuration}s exceeds ${durationPolicy.modelLabel} max duration ${durationPolicy.maxDuration}s`,
        ),
      );
    }
  }
  return issues;
}

function normalizeRowsWithGroupPlan(rows: StoryboardTableRowV2[], groups: StoryboardGroupPlanV2[]) {
  const groupMap = new Map(groups.map((group) => [group.groupKey, group]));
  return rows.map((row) => {
    const group = groupMap.get(row.groupKey);
    return group
      ? {
          ...row,
          groupName: group.groupName,
          groupIntent: group.groupIntent,
        }
      : row;
  });
}

export async function commitStoryboardGeneration(
  generationId: string,
  knex: any = u.db,
): Promise<CommitStoryboardGenerationResult> {
  let generation = await knex("o_storyboardGeneration").where({ generationId }).first();
  if (!generation) throw new Error("storyboard generation does not exist");

  const committedResult = (row: any) => ({
    status: "committed" as const,
    rowCount: Number(row.expectedRowCount),
    groupCount: JSON.parse(row.groupPlanJson || "[]").length,
    revision: Number(row.revision || 1),
  });

  const failedResult = (error: StoryboardGenerationFailure): CommitStoryboardGenerationResult => ({
    status: "failed",
    error,
  });

  if (generation.state === "committed") return committedResult(generation);
  if (generation.state === "superseded") {
    return failedResult({
      code: "GENERATION_SUPERSEDED",
      message: "storyboard generation was superseded by a newer generation",
    });
  }
  if (failedRetryCoolingDown(generation)) {
    return failedResult(parseStoredGenerationError(generation.errorJson, "storyboard generation commit failed"));
  }
  if (generation.state === "committing") {
    generation = await recoverStaleCommittingGeneration(knex, generation);
    if (generation.state === "superseded") {
      return failedResult({
        code: "GENERATION_SUPERSEDED",
        message: "storyboard generation was superseded by a newer generation",
      });
    }
    if (generation.state === "committing") return failedResult(commitInProgressError());
  }
  if (!["writing", "invalid", "failed"].includes(generation.state)) {
    return failedResult({ message: `storyboard generation is ${generation.state}` });
  }

  const scopeKey = `${generation.projectId}:${generation.scriptId}`;
  return withStoryboardCommitLock(scopeKey, async () => {
    generation = await knex("o_storyboardGeneration").where({ generationId }).first();
    if (!generation) throw new Error("storyboard generation does not exist");
    if (generation.state === "committed") return committedResult(generation);
    if (generation.state === "superseded") {
      return failedResult({
        code: "GENERATION_SUPERSEDED",
        message: "storyboard generation was superseded by a newer generation",
      });
    }
    if (failedRetryCoolingDown(generation)) {
      return failedResult(parseStoredGenerationError(generation.errorJson, "storyboard generation commit failed"));
    }
    if (generation.state === "committing") {
      generation = await recoverStaleCommittingGeneration(knex, generation);
      if (generation.state === "committed") return committedResult(generation);
      if (generation.state === "superseded") {
        return failedResult({
          code: "GENERATION_SUPERSEDED",
          message: "storyboard generation was superseded by a newer generation",
        });
      }
      if (generation.state === "committing") return failedResult(commitInProgressError());
    }
    if (!["writing", "invalid", "failed"].includes(generation.state)) {
      return failedResult({ message: `storyboard generation is ${generation.state}` });
    }

    try {
      await assertStoryboardGenerationScope(knex, Number(generation.projectId), Number(generation.scriptId));
    } catch (error) {
      const serialized = serializeGenerationError(error);
      await knex("o_storyboardGeneration").where({ generationId }).update({
        state: "failed",
        errorJson: JSON.stringify(serialized),
        updatedAt: Date.now(),
      });
      return failedResult(serialized);
    }

    const locked = await knex("o_storyboardGeneration")
      .where({ generationId })
      .whereIn("state", ["writing", "invalid", "failed"])
      .update({ state: "committing", errorJson: null, updatedAt: Date.now() });
    if (!locked) {
      generation = await knex("o_storyboardGeneration").where({ generationId }).first();
      return generation?.state === "committed"
        ? committedResult(generation)
        : failedResult(commitInProgressError());
    }

    try {
      generation = await knex("o_storyboardGeneration").where({ generationId }).first();
      const draftRows = await knex("o_storyboardGenerationRow").where({ generationId }).orderBy("rowIndex", "asc");
      let rows: StoryboardTableRowV2[] = [];
      const parseIssues: StoryboardTableIssue[] = [];
      for (const draft of draftRows) {
        try {
          rows.push(storyboardTableRowV2Schema.parse(JSON.parse(draft.rowJson)));
        } catch (error: any) {
          parseIssues.push(generationIssue(`row.${draft.rowIndex}`, error?.message || "invalid row JSON"));
        }
      }

      const groups = JSON.parse(generation.groupPlanJson || "[]").map((group: unknown) =>
        storyboardGroupPlanV2Schema.parse(group),
      );
      const durationPolicy = await getProjectDefaultVideoPolicy(Number(generation.projectId), { knex });
      const issues = [
        ...parseIssues,
        ...validateStoryboardTableRows(rows),
        ...validateGroups(rows, groups, durationPolicy),
        ...(await validateAssets(knex, Number(generation.projectId), rows)),
      ];
      if (rows.length !== Number(generation.expectedRowCount)) {
        issues.push(generationIssue("expectedRowCount", `expected ${generation.expectedRowCount}, got ${rows.length}`));
      }
      rows = rows.sort((a, b) => a.index - b.index);
      for (let index = 0; index < Number(generation.expectedRowCount); index += 1) {
        if (!rows[index] || rows[index].index !== index) {
          issues.push({ index, field: "index", message: `missing row index ${index}` });
        }
      }
      if (issues.length) {
        await knex("o_storyboardGeneration").where({ generationId }).update({
          state: "invalid",
          errorJson: validationIssuesJson(issues),
          updatedAt: Date.now(),
        });
        return { status: "invalid" as const, issues };
      }
      rows = normalizeRowsWithGroupPlan(rows, groups);

      const revisionRow = await knex("o_storyboard")
        .where({ projectId: generation.projectId, scriptId: generation.scriptId })
        .max({ revision: "factRevision" })
        .first();
      const revision = Number(revisionRow?.revision || 0) + 1;
      const existingIds = (
        await knex("o_storyboard").where({ projectId: generation.projectId, scriptId: generation.scriptId }).select("id")
      ).map((row: any) => Number(row.id));
      const hasArchivedColumn = await knex.schema.hasColumn("o_videoTrack", "archived");

      await knex.transaction(async (trx: any) => {
        if (existingIds.length) {
          await trx("o_assets2Storyboard").whereIn("storyboardId", existingIds).del();
          await trx("o_storyboard").whereIn("id", existingIds).del();
        }
        if (hasArchivedColumn) {
          await trx("o_videoTrack")
            .where({ projectId: generation.projectId, scriptId: generation.scriptId })
            .update({ archived: 1 });
        }

        for (const row of rows) {
          const [id] = await trx("o_storyboard").insert({
            ...storyboardRowToDbPatch(row, revision),
            projectId: generation.projectId,
            scriptId: generation.scriptId,
            index: row.index,
            prompt: "",
            filePath: "",
            state: "未生成",
            shouldGenerateImage: 0,
            referenceImages: "[]",
            createTime: Date.now(),
          });
          const assetIds = assetIdsFromStoryboardRow(row);
          if (assetIds.length) {
            await trx("o_assets2Storyboard").insert(assetIds.map((assetId) => ({ assetId, storyboardId: id })));
          }
        }

        const storyboards = await trx("o_storyboard")
          .where({ projectId: generation.projectId, scriptId: generation.scriptId })
          .orderBy("index", "asc");
        await syncVideoTracksForStoryboards(trx, {
          projectId: Number(generation.projectId),
          scriptId: Number(generation.scriptId),
          storyboards,
          durationPolicy,
        });
        const formalCountRow = await trx("o_storyboard")
          .where({ projectId: generation.projectId, scriptId: generation.scriptId })
          .count({ count: "*" })
          .first();
        if (Number(formalCountRow?.count || 0) !== Number(generation.expectedRowCount)) {
          throw new Error(
            `storyboard commit wrote ${formalCountRow?.count || 0} rows, expected ${generation.expectedRowCount}`,
          );
        }
        if (hasArchivedColumn) {
          const groupKeys = groups.map((group: StoryboardGroupPlanV2) => group.groupKey);
          const activeTrackCountRow = await trx("o_videoTrack")
            .where({ projectId: generation.projectId, scriptId: generation.scriptId, archived: 0 })
            .whereIn("groupKey", groupKeys)
            .count({ count: "*" })
            .first();
          if (Number(activeTrackCountRow?.count || 0) !== groups.length) {
            throw new Error(
              `storyboard commit produced ${activeTrackCountRow?.count || 0} active tracks, expected ${groups.length}`,
            );
          }
        }
        await trx("o_storyboardGeneration").where({ generationId }).update({
          state: "committed",
          revision,
          errorJson: null,
          updatedAt: Date.now(),
        });
        await trx("o_storyboardGeneration")
          .where({ projectId: generation.projectId, scriptId: generation.scriptId })
          .whereIn("state", STORYBOARD_ACTIVE_GENERATION_STATES)
          .whereNot({ generationId })
          .update({
            state: "superseded",
            errorJson: JSON.stringify({
              message: "storyboard generation was superseded by a committed generation",
              code: "GENERATION_SUPERSEDED",
            }),
            updatedAt: Date.now(),
          });
        await trx("o_storyboardGenerationRow").where({ generationId }).del();
      });

      return {
        status: "committed" as const,
        rowCount: rows.length,
        groupCount: groups.length,
        revision,
      };
    } catch (error) {
      const serialized = { ...serializeGenerationError(error), retryable: true };
      await knex("o_storyboardGeneration").where({ generationId }).update({
        state: "failed",
        errorJson: JSON.stringify(serialized),
        updatedAt: Date.now(),
      });
      return { status: "failed" as const, error: serialized };
    }
  });
}

async function commitStoryboardGenerationUnsafe(generationId: string, knex: any = u.db) {
  throw new Error("commitStoryboardGenerationUnsafe is disabled; use commitStoryboardGeneration");
  let generation = await knex("o_storyboardGeneration").where({ generationId }).first();
  if (!generation) throw new Error("storyboard generation does not exist");
  if (generation.state === "committed") {
    return {
      status: "committed" as const,
      rowCount: Number(generation.expectedRowCount),
      groupCount: JSON.parse(generation.groupPlanJson || "[]").length,
      revision: Number(generation.revision || 1),
    };
  }
  if (!["writing", "invalid"].includes(generation.state)) {
    throw new Error(`storyboard generation is ${generation.state}`);
  }
  const locked = await knex("o_storyboardGeneration")
    .where({ generationId })
    .whereIn("state", ["writing", "invalid"])
    .update({ state: "committing", updatedAt: Date.now() });
  if (!locked) {
    generation = await knex("o_storyboardGeneration").where({ generationId }).first();
    if (generation?.state === "committed") {
      return {
        status: "committed" as const,
        rowCount: Number(generation.expectedRowCount),
        groupCount: JSON.parse(generation.groupPlanJson || "[]").length,
        revision: Number(generation.revision || 1),
      };
    }
    throw new Error("storyboard generation commit is already in progress");
  }

  try {
  generation = await knex("o_storyboardGeneration").where({ generationId }).first();
  const draftRows = await knex("o_storyboardGenerationRow").where({ generationId }).orderBy("rowIndex", "asc");
  const rows: StoryboardTableRowV2[] = [];
  const parseIssues: StoryboardTableIssue[] = [];
  for (const draft of draftRows) {
    try {
      rows.push(storyboardTableRowV2Schema.parse(JSON.parse(draft.rowJson)));
    } catch (error: any) {
      parseIssues.push(generationIssue(`row.${draft.rowIndex}`, error?.message || "invalid row JSON"));
    }
  }
  const groups = JSON.parse(generation.groupPlanJson || "[]").map((group: unknown) =>
    storyboardGroupPlanV2Schema.parse(group),
  );
  const issues = [
    ...parseIssues,
    ...validateStoryboardTableRows(rows),
    ...validateGroups(rows, groups),
    ...(await validateAssets(knex, Number(generation.projectId), rows)),
  ];
  if (rows.length !== Number(generation.expectedRowCount)) {
    issues.push(generationIssue("expectedRowCount", `expected ${generation.expectedRowCount}, got ${rows.length}`));
  }
  rows.forEach((row, index) => {
    if (row.index !== index) issues.push({ index, field: "index", message: `expected continuous index ${index}` });
  });
  if (issues.length) {
    await knex("o_storyboardGeneration").where({ generationId }).update({ state: "invalid", updatedAt: Date.now() });
    return { status: "invalid" as const, issues };
  }

  const revisionRow = await knex("o_storyboard")
    .where({ projectId: generation.projectId, scriptId: generation.scriptId })
    .max({ revision: "factRevision" })
    .first();
  const revision = Number(revisionRow?.revision || 0) + 1;

  await knex.transaction(async (trx: any) => {
    const existing = await trx("o_storyboard")
      .where({ projectId: generation.projectId, scriptId: generation.scriptId })
      .select("id");
    const existingIds = existing.map((row: any) => Number(row.id));
    if (existingIds.length) {
      await trx("o_assets2Storyboard").whereIn("storyboardId", existingIds).del();
      await trx("o_storyboard").whereIn("id", existingIds).del();
    }
    if (await trx.schema.hasColumn("o_videoTrack", "archived")) {
      await trx("o_videoTrack")
        .where({ projectId: generation.projectId, scriptId: generation.scriptId })
        .update({ archived: 1 });
    }

    for (const row of rows) {
      const [id] = await trx("o_storyboard").insert({
        ...storyboardRowToDbPatch(row, revision),
        projectId: generation.projectId,
        scriptId: generation.scriptId,
        index: row.index,
        prompt: "",
        filePath: "",
        state: "未生成",
        shouldGenerateImage: 0,
        referenceImages: "[]",
        createTime: Date.now(),
      });
      const assetIds = assetIdsFromStoryboardRow(row);
      if (assetIds.length) {
        await trx("o_assets2Storyboard").insert(assetIds.map((assetId) => ({ assetId, storyboardId: id })));
      }
    }
    const storyboards = await trx("o_storyboard")
      .where({ projectId: generation.projectId, scriptId: generation.scriptId })
      .orderBy("index", "asc");
    await syncVideoTracksForStoryboards(trx, {
      projectId: Number(generation.projectId),
      scriptId: Number(generation.scriptId),
      storyboards,
    });
    await trx("o_storyboardGeneration").where({ generationId }).update({
      state: "committed",
      revision,
      updatedAt: Date.now(),
    });
    await trx("o_storyboardGenerationRow").where({ generationId }).del();
  });

  return {
    status: "committed" as const,
    rowCount: rows.length,
    groupCount: groups.length,
    revision,
  };
  } catch (error) {
    await knex("o_storyboardGeneration")
      .where({ generationId, state: "committing" })
      .update({ state: "invalid", updatedAt: Date.now() });
    throw error;
  }
}
