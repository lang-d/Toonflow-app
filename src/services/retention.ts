import u from "@/utils";
import { deleteTextAssetRecords } from "@/services/textAsset";

export const GENERATION_CONTENT_TTL_MS = 24 * 60 * 60 * 1000;
export const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LAZY_RETENTION_MIN_INTERVAL_MS = 5 * 60 * 1000;

const EXPIRABLE_GENERATION_STATES = ["writing", "invalid", "failed", "committing", "superseded"];
const TERMINAL_GENERATION_STATES = ["committed", "expired", "superseded", "invalid", "failed"];

let activeCleanup: Promise<RetentionCleanupResult> | null = null;
let lastCleanupAt = 0;

function scriptWorkspaceTextReferences(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return [parsed.storySkeletonTextAssetId, parsed.adaptationStrategyTextAssetId]
      .map(Number)
      .filter((id) => Number.isFinite(id) && id > 0);
  } catch {
    return [];
  }
}

export interface RetentionCleanupResult {
  skipped: boolean;
  storyboardDraftRows: number;
  directorPlanChunks: number;
  generationDiagnostics: number;
  agentOutputs: number;
  agentOutputFailures: number;
  scriptWorkspaceAssets: number;
  scriptWorkspaceAssetFailures: number;
}

async function hasTables(database: any, names: string[]) {
  const result: Record<string, boolean> = {};
  for (const name of names) {
    const row = await database("sqlite_master").where({ type: "table", name }).first("name");
    result[name] = Boolean(row);
  }
  return result;
}

async function hasColumn(database: any, table: string, column: string) {
  try {
    const columns = await database(table).columnInfo();
    return Boolean(columns?.[column]);
  } catch {
    return false;
  }
}

async function cleanupGenerationContent(input: {
  database: any;
  generationTable: string;
  contentTable: string;
  cutoff: number;
}) {
  const rows = await input.database(input.generationTable)
    .where("updatedAt", "<", input.cutoff)
    .select("generationId", "state");
  const ids = rows.map((row: any) => String(row.generationId));
  if (!ids.length) return 0;
  let deleted = 0;
  await input.database.transaction(async (trx: any) => {
    const result = await trx(input.contentTable).whereIn("generationId", ids).delete();
    deleted = Number(result || 0);
    await trx(input.generationTable)
      .whereIn("generationId", ids)
      .whereIn("state", EXPIRABLE_GENERATION_STATES)
      .update({ state: "expired" });
  });
  return deleted;
}

async function cleanupGenerationDiagnostics(input: {
  database: any;
  generationTable: string;
  contentTable: string;
  cutoff: number;
}) {
  const rows = await input.database(input.generationTable)
    .where("updatedAt", "<", input.cutoff)
    .whereIn("state", TERMINAL_GENERATION_STATES)
    .select("generationId");
  const ids = rows.map((row: any) => String(row.generationId));
  if (!ids.length) return 0;
  await input.database.transaction(async (trx: any) => {
    await trx(input.contentTable).whereIn("generationId", ids).delete();
    await trx(input.generationTable).whereIn("generationId", ids).delete();
  });
  return ids.length;
}

async function performRetentionCleanup(database: any, now: number): Promise<RetentionCleanupResult> {
  const tables = await hasTables(database, [
    "o_storyboardGeneration",
    "o_storyboardGenerationRow",
    "o_directorPlanGeneration",
    "o_directorPlanGenerationChunk",
    "o_textAsset",
    "o_script",
    "o_agentWorkData",
  ]);
  const contentCutoff = now - GENERATION_CONTENT_TTL_MS;
  const diagnosticCutoff = now - DIAGNOSTIC_RETENTION_MS;
  let storyboardDraftRows = 0;
  let directorPlanChunks = 0;
  let generationDiagnostics = 0;

  if (tables.o_storyboardGeneration && tables.o_storyboardGenerationRow) {
    storyboardDraftRows = await cleanupGenerationContent({
      database,
      generationTable: "o_storyboardGeneration",
      contentTable: "o_storyboardGenerationRow",
      cutoff: contentCutoff,
    });
    generationDiagnostics += await cleanupGenerationDiagnostics({
      database,
      generationTable: "o_storyboardGeneration",
      contentTable: "o_storyboardGenerationRow",
      cutoff: diagnosticCutoff,
    });
  }
  if (tables.o_directorPlanGeneration && tables.o_directorPlanGenerationChunk) {
    directorPlanChunks = await cleanupGenerationContent({
      database,
      generationTable: "o_directorPlanGeneration",
      contentTable: "o_directorPlanGenerationChunk",
      cutoff: contentCutoff,
    });
    generationDiagnostics += await cleanupGenerationDiagnostics({
      database,
      generationTable: "o_directorPlanGeneration",
      contentTable: "o_directorPlanGenerationChunk",
      cutoff: diagnosticCutoff,
    });
  }

  let agentOutputs = 0;
  let agentOutputFailures = 0;
  let scriptWorkspaceAssets = 0;
  let scriptWorkspaceAssetFailures = 0;
  if (tables.o_textAsset) {
    const rows = await database("o_textAsset")
      .where({ targetType: "agentOutput" })
      .andWhere("createTime", "<", diagnosticCutoff)
      .select("id", "filePath");
    const result = await deleteTextAssetRecords(rows, database);
    agentOutputs = result.deletedIds.length;
    agentOutputFailures = result.failedIds.length;

    const referencedIds = new Set<number>();
    if (
      tables.o_textAsset &&
      tables.o_script &&
      (await hasColumn(database, "o_script", "contentTextAssetId"))
    ) {
      const scripts = await database("o_script").whereNotNull("contentTextAssetId").select("contentTextAssetId");
      for (const script of scripts) {
        const id = Number(script.contentTextAssetId);
        if (Number.isFinite(id) && id > 0) referencedIds.add(id);
      }
    }
    if (tables.o_agentWorkData) {
      const workspaces = await database("o_agentWorkData")
        .where({ key: "scriptAgent" })
        .orderBy("projectId", "asc")
        .orderBy("id", "asc")
        .select("projectId", "data");
      const projects = new Set<number>();
      for (const workspace of workspaces) {
        const projectId = Number(workspace.projectId);
        if (projects.has(projectId)) continue;
        projects.add(projectId);
        for (const id of scriptWorkspaceTextReferences(workspace.data)) referencedIds.add(id);
      }
    }
    const staleQuery = database("o_textAsset")
      .whereIn("targetType", ["scriptContent", "scriptWorkspaceStage"])
      .andWhere("updateTime", "<", contentCutoff);
    if (referencedIds.size) staleQuery.whereNotIn("id", [...referencedIds]);
    const staleRows = await staleQuery.select("id", "filePath");
    const staleResult = await deleteTextAssetRecords(staleRows, database);
    scriptWorkspaceAssets = staleResult.deletedIds.length;
    scriptWorkspaceAssetFailures = staleResult.failedIds.length;
  }

  return {
    skipped: false,
    storyboardDraftRows,
    directorPlanChunks,
    generationDiagnostics,
    agentOutputs,
    agentOutputFailures,
    scriptWorkspaceAssets,
    scriptWorkspaceAssetFailures,
  };
}

export async function runLazyRetentionCleanup(input: {
  database?: any;
  now?: number;
  force?: boolean;
} = {}): Promise<RetentionCleanupResult> {
  const now = input.now ?? Date.now();
  if (!input.force && now - lastCleanupAt < LAZY_RETENTION_MIN_INTERVAL_MS) {
    return {
      skipped: true,
      storyboardDraftRows: 0,
      directorPlanChunks: 0,
      generationDiagnostics: 0,
      agentOutputs: 0,
      agentOutputFailures: 0,
      scriptWorkspaceAssets: 0,
      scriptWorkspaceAssetFailures: 0,
    };
  }
  if (activeCleanup) return activeCleanup;
  activeCleanup = performRetentionCleanup(input.database ?? u.db, now).finally(() => {
    lastCleanupAt = now;
    activeCleanup = null;
  });
  return activeCleanup;
}
