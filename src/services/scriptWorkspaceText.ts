import u from "@/utils";
import {
  createTextAsset,
  deleteTextAssetRecords,
  getFullTextAssetContent,
  toTextAssetReference,
  type TextAssetReference,
} from "@/services/textAsset";
import { runLazyRetentionCleanup } from "@/services/retention";

export const SCRIPT_CONTENT_TARGET = "scriptContent" as const;
export const SCRIPT_WORKSPACE_STAGE_TARGET = "scriptWorkspaceStage" as const;
export const SCRIPT_WORKSPACE_STAGES = ["storySkeleton", "adaptationStrategy"] as const;

export type ScriptWorkspaceTextStage = (typeof SCRIPT_WORKSPACE_STAGES)[number];

type WorkspaceData = Record<string, unknown> & {
  storySkeleton?: string;
  adaptationStrategy?: string;
  storySkeletonTextAssetId?: number | null;
  adaptationStrategyTextAssetId?: number | null;
};

export class ScriptWorkspaceTextError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "ScriptWorkspaceTextError";
    this.status = status;
  }
}

function parseWorkspaceData(value: unknown): WorkspaceData {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stageReferenceKey(stage: ScriptWorkspaceTextStage) {
  return `${stage}TextAssetId` as "storySkeletonTextAssetId" | "adaptationStrategyTextAssetId";
}

function numericId(value: unknown) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function hasTable(database: any, table: string) {
  const row = await database("sqlite_master").where({ type: "table", name: table }).first("name");
  return Boolean(row);
}

async function hasColumn(database: any, table: string, column: string) {
  try {
    const columns = await database(table).columnInfo();
    return Boolean(columns?.[column]);
  } catch {
    return false;
  }
}

function triggerRetention(database: any) {
  void runLazyRetentionCleanup({ database }).catch((error) => {
    console.warn("[scriptWorkspaceText] lazy retention failed:", u.error(error).message);
  });
}

async function getOwnedAsset(input: {
  id: number;
  projectId: number;
  targetType: typeof SCRIPT_CONTENT_TARGET | typeof SCRIPT_WORKSPACE_STAGE_TARGET;
  scriptId?: number | null;
  targetId?: string | null;
}, database: any) {
  const query = database("o_textAsset").where({
    id: input.id,
    projectId: input.projectId,
    targetType: input.targetType,
  });
  if (input.scriptId == null) query.whereNull("scriptId");
  else query.andWhere("scriptId", input.scriptId);
  if (input.targetId == null) query.whereNull("targetId");
  else query.andWhere("targetId", input.targetId);
  return query.first();
}

async function archiveAsset(id: number | null, database: any) {
  if (!id) return;
  await database("o_textAsset").where({ id }).update({ state: "archived", updateTime: Date.now() });
}

export async function getScriptContentAsset(
  input: { projectId: number; scriptId: number; assetId?: number | null },
  database: any = u.db,
) {
  const assetId = numericId(input.assetId);
  if (!assetId) return null;
  return getOwnedAsset(
    {
      id: assetId,
      projectId: input.projectId,
      targetType: SCRIPT_CONTENT_TARGET,
      scriptId: input.scriptId,
      targetId: "content",
    },
    database,
  );
}

export async function getWorkspaceStageAsset(
  input: { projectId: number; stage: ScriptWorkspaceTextStage; assetId?: number | null },
  database: any = u.db,
) {
  const assetId = numericId(input.assetId);
  if (!assetId) return null;
  return getOwnedAsset(
    {
      id: assetId,
      projectId: input.projectId,
      targetType: SCRIPT_WORKSPACE_STAGE_TARGET,
      scriptId: null,
      targetId: input.stage,
    },
    database,
  );
}

export async function replaceScriptContent(input: {
  projectId: number;
  scriptId: number;
  content: string;
  name?: string;
  scheduleRetention?: boolean;
  beforeCommit?: (database: any) => Promise<void>;
}, database: any = u.db): Promise<TextAssetReference> {
  const existing = await database("o_script")
    .where({ id: input.scriptId, projectId: input.projectId })
    .first("id", "contentTextAssetId");
  if (!existing) throw new ScriptWorkspaceTextError("Script does not belong to the current project", 404);

  const asset = await createTextAsset(
    {
      projectId: input.projectId,
      scriptId: input.scriptId,
      targetType: SCRIPT_CONTENT_TARGET,
      targetId: "content",
      content: input.content ?? "",
      summary: "",
      extension: "md",
      state: "complete",
    },
    database,
  );

  try {
    await database.transaction(async (trx: any) => {
      if (input.beforeCommit) await input.beforeCommit(trx);
      const current = await trx("o_script")
        .where({ id: input.scriptId, projectId: input.projectId })
        .first("id", "contentTextAssetId");
      if (!current) throw new ScriptWorkspaceTextError("Script does not belong to the current project", 404);
      const update: Record<string, unknown> = { contentTextAssetId: asset.id, content: "" };
      if (input.name !== undefined) update.name = input.name;
      await trx("o_script").where({ id: input.scriptId, projectId: input.projectId }).update(update);
      const oldId = numericId(current.contentTextAssetId);
      if (oldId && oldId !== asset.id) await archiveAsset(oldId, trx);
    });
  } catch (error) {
    await archiveAsset(asset.id, database).catch(() => undefined);
    if (input.scheduleRetention !== false) triggerRetention(database);
    throw error;
  }

  if (input.scheduleRetention !== false) triggerRetention(database);
  return toTextAssetReference(asset)!;
}

export async function createScriptWithContent(input: {
  projectId: number;
  name: string;
  content: string;
  createTime?: number;
}, database: any = u.db) {
  const [id] = await database("o_script").insert({
    projectId: input.projectId,
    name: input.name,
    content: "",
    createTime: input.createTime ?? Date.now(),
  });
  const scriptId = Number(id);
  try {
    const contentAsset = await replaceScriptContent(
      { projectId: input.projectId, scriptId, name: input.name, content: input.content },
      database,
    );
    return { id: scriptId, name: input.name, contentAsset };
  } catch (error) {
    await database("o_script").where({ id: scriptId, projectId: input.projectId }).delete().catch(() => undefined);
    throw error;
  }
}

export async function readScriptContent(rowOrInput: any, database: any = u.db): Promise<string> {
  const row = rowOrInput?.id && rowOrInput?.projectId != null
    ? rowOrInput
    : await database("o_script").where({ id: rowOrInput.scriptId, projectId: rowOrInput.projectId }).first();
  if (!row) throw new ScriptWorkspaceTextError("Script not found", 404);
  const projectId = Number(row.projectId);
  const scriptId = Number(row.id);
  const legacy = typeof row.content === "string" ? row.content : "";
  const assetId = numericId(row.contentTextAssetId);

  if (assetId) {
    const asset = await getScriptContentAsset({ projectId, scriptId, assetId }, database);
    if (asset) {
      try {
        return (await getFullTextAssetContent({ id: assetId, projectId }, database)).content;
      } catch (error) {
        if (!legacy) throw new ScriptWorkspaceTextError("Script content file is missing or unreadable", 500);
      }
    } else if (!legacy) {
      throw new ScriptWorkspaceTextError("Script content reference is invalid", 500);
    }
  }

  if (legacy) {
    await replaceScriptContent({ projectId, scriptId, content: legacy }, database).catch(() => undefined);
    return legacy;
  }
  return "";
}

export async function scriptContentMetadata(row: any, database: any = u.db): Promise<TextAssetReference | null> {
  const asset = await getScriptContentAsset(
    {
      projectId: Number(row.projectId),
      scriptId: Number(row.id),
      assetId: row.contentTextAssetId,
    },
    database,
  );
  return toTextAssetReference(asset);
}

export async function deleteScriptContentAssets(
  input: { projectId: number; scriptIds: number[] },
  database: any = u.db,
) {
  if (!input.scriptIds.length) return { deletedIds: [], failedIds: [] };
  const rows = await database("o_textAsset")
    .where({ projectId: input.projectId, targetType: SCRIPT_CONTENT_TARGET })
    .whereIn("scriptId", input.scriptIds)
    .select("id", "filePath");
  return deleteTextAssetRecords(rows, database);
}

export async function deleteScriptWorkspaceStageAssets(projectId: number, database: any = u.db) {
  const rows = await database("o_textAsset")
    .where({ projectId, targetType: SCRIPT_WORKSPACE_STAGE_TARGET })
    .select("id", "filePath");
  return deleteTextAssetRecords(rows, database);
}

export async function replaceWorkspaceStageText(input: {
  projectId: number;
  workspaceId: number;
  stage: ScriptWorkspaceTextStage;
  content: string;
  scheduleRetention?: boolean;
  beforeCommit?: (database: any) => Promise<void>;
}, database: any = u.db): Promise<TextAssetReference> {
  const asset = await createTextAsset(
    {
      projectId: input.projectId,
      scriptId: null,
      targetType: SCRIPT_WORKSPACE_STAGE_TARGET,
      targetId: input.stage,
      content: input.content ?? "",
      summary: "",
      extension: "md",
      state: "complete",
    },
    database,
  );

  try {
    await database.transaction(async (trx: any) => {
      if (input.beforeCommit) await input.beforeCommit(trx);
      const row = await trx("o_agentWorkData")
        .where({ id: input.workspaceId, projectId: input.projectId, key: "scriptAgent" })
        .first("id", "data");
      if (!row) throw new ScriptWorkspaceTextError("Script Agent workspace was not found", 404);
      const data = parseWorkspaceData(row.data);
      const refKey = stageReferenceKey(input.stage);
      const oldId = numericId(data[refKey]);
      delete data[input.stage];
      data[refKey] = asset.id;
      await trx("o_agentWorkData").where({ id: input.workspaceId }).update({ data: JSON.stringify(data), updateTime: Date.now() });
      if (oldId && oldId !== asset.id) await archiveAsset(oldId, trx);
    });
  } catch (error) {
    await archiveAsset(asset.id, database).catch(() => undefined);
    if (input.scheduleRetention !== false) triggerRetention(database);
    throw error;
  }

  if (input.scheduleRetention !== false) triggerRetention(database);
  return toTextAssetReference(asset)!;
}

export async function readWorkspaceStageText(input: {
  projectId: number;
  workspaceRow: any;
  stage: ScriptWorkspaceTextStage;
}, database: any = u.db): Promise<{ content: string; asset: TextAssetReference | null }> {
  const data = parseWorkspaceData(input.workspaceRow?.data);
  const refKey = stageReferenceKey(input.stage);
  const assetId = numericId(data[refKey]);
  const legacy = typeof data[input.stage] === "string" ? String(data[input.stage]) : "";

  if (assetId) {
    const row = await getWorkspaceStageAsset({ projectId: input.projectId, stage: input.stage, assetId }, database);
    if (row) {
      try {
        const content = (await getFullTextAssetContent({ id: assetId, projectId: input.projectId }, database)).content;
        return { content, asset: toTextAssetReference(row) };
      } catch (error) {
        if (!legacy) throw new ScriptWorkspaceTextError(`${input.stage} content file is missing or unreadable`, 500);
      }
    } else if (!legacy) {
      throw new ScriptWorkspaceTextError(`${input.stage} content reference is invalid`, 500);
    }
  }

  if (legacy) {
    const asset = await replaceWorkspaceStageText(
      {
        projectId: input.projectId,
        workspaceId: Number(input.workspaceRow.id),
        stage: input.stage,
        content: legacy,
      },
      database,
    ).catch(() => null);
    return { content: legacy, asset };
  }
  return { content: "", asset: null };
}

export async function migrateScriptWorkspaceTextStorage(database: any = u.db) {
  const result = { scriptsMigrated: 0, stagesMigrated: 0, skipped: 0, failed: 0 };
  if (!(await hasTable(database, "o_textAsset")) || !(await hasTable(database, "o_script"))) return result;
  const hasPointer = await hasColumn(database, "o_script", "contentTextAssetId");
  if (!hasPointer) return result;

  const scripts = await database("o_script").select("id", "projectId", "content", "contentTextAssetId");
  for (const row of scripts) {
    const legacy = typeof row.content === "string" ? row.content : "";
    try {
      const current = await getScriptContentAsset(
        { projectId: Number(row.projectId), scriptId: Number(row.id), assetId: row.contentTextAssetId },
        database,
      );
      if (current) {
        if (legacy) await database("o_script").where({ id: row.id }).update({ content: "" });
        result.skipped += 1;
      } else if (legacy) {
        await replaceScriptContent({ projectId: Number(row.projectId), scriptId: Number(row.id), content: legacy, scheduleRetention: false }, database);
        result.scriptsMigrated += 1;
      } else {
        result.skipped += 1;
      }
    } catch {
      result.failed += 1;
    }
  }

  if (await hasTable(database, "o_agentWorkData")) {
    const rows = await database("o_agentWorkData")
      .where({ key: "scriptAgent" })
      .orderBy("projectId", "asc")
      .orderBy("id", "asc")
      .select("id", "projectId", "data");
    const migratedProjects = new Set<number>();
    for (const original of rows) {
      const projectId = Number(original.projectId);
      if (migratedProjects.has(projectId)) {
        result.skipped += SCRIPT_WORKSPACE_STAGES.length;
        continue;
      }
      migratedProjects.add(projectId);
      let row = original;
      for (const stage of SCRIPT_WORKSPACE_STAGES) {
        const data = parseWorkspaceData(row.data);
        const legacy = typeof data[stage] === "string" ? String(data[stage]) : "";
        const refId = numericId(data[stageReferenceKey(stage)]);
        try {
          const current = await getWorkspaceStageAsset(
            { projectId, stage, assetId: refId },
            database,
          );
          if (current) {
            if (legacy) {
              delete data[stage];
              await database("o_agentWorkData").where({ id: row.id }).update({ data: JSON.stringify(data) });
            }
            result.skipped += 1;
          } else if (legacy) {
            await replaceWorkspaceStageText(
              { projectId, workspaceId: Number(row.id), stage, content: legacy, scheduleRetention: false },
              database,
            );
            result.stagesMigrated += 1;
          } else {
            result.skipped += 1;
          }
          row = await database("o_agentWorkData").where({ id: row.id }).first("id", "projectId", "data");
        } catch {
          result.failed += 1;
        }
      }
    }
  }

  await runLazyRetentionCleanup({ database }).catch(() => undefined);
  return result;
}
