import u from "@/utils";
import { getActiveAgentRun } from "@/services/agentRun";
import {
  deleteScriptContentAssets,
  readScriptContent,
  readWorkspaceStageText,
  replaceScriptContent,
  replaceWorkspaceStageText,
  scriptContentMetadata,
} from "@/services/scriptWorkspaceText";

export const SCRIPT_AGENT_KEY = "scriptAgent";
export const SCRIPT_AGENT_SCRIPT_ID = 0;
export const SCRIPT_AGENT_STAGES = ["storySkeleton", "adaptationStrategy"] as const;

export type ScriptAgentStage = (typeof SCRIPT_AGENT_STAGES)[number];

export class ScriptAgentWorkspaceError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ScriptAgentWorkspaceError";
    this.status = status;
  }
}

const workspaceCreationLocks = new WeakMap<object, Map<number, Promise<void>>>();

async function assertProject(projectId: number, database: any) {
  const project = await database("o_project").where({ id: projectId }).first("id");
  if (!project) throw new ScriptAgentWorkspaceError("Project not found", 404);
}

async function findWorkspaceRow(projectId: number, database: any) {
  return database("o_agentWorkData")
    .where({ projectId, key: SCRIPT_AGENT_KEY })
    .orderBy("id", "asc")
    .first();
}

function locksFor(database: object) {
  let locks = workspaceCreationLocks.get(database);
  if (!locks) {
    locks = new Map<number, Promise<void>>();
    workspaceCreationLocks.set(database, locks);
  }
  return locks;
}

async function withWorkspaceCreationLock<T>(projectId: number, database: object, operation: () => Promise<T>) {
  const locks = locksFor(database);
  const previous = locks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(projectId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(projectId) === tail) locks.delete(projectId);
  }
}

async function ensureWorkspaceRow(projectId: number, database: any) {
  const existing = await findWorkspaceRow(projectId, database);
  if (existing) return existing;

  return withWorkspaceCreationLock(projectId, database, async () => {
    let row = await findWorkspaceRow(projectId, database);
    if (row) return row;

    const [id] = await database("o_agentWorkData").insert({
      projectId,
      key: SCRIPT_AGENT_KEY,
      data: JSON.stringify({}),
    });
    row = await database("o_agentWorkData").where({ id }).first();
    if (!row) throw new ScriptAgentWorkspaceError("Failed to create Script Agent workspace", 500);
    return row;
  });
}

async function assertNoActiveRun(projectId: number, database: any) {
  const activeRun = await getActiveAgentRun(
    { agentKey: SCRIPT_AGENT_KEY, projectId, scriptId: SCRIPT_AGENT_SCRIPT_ID },
    database,
  );
  if (activeRun) {
    throw new ScriptAgentWorkspaceError("Script Agent is running; stop it or wait before editing the workspace", 409);
  }
}

export function scriptAgentIsolationKey(projectId: number) {
  return `${projectId}:${SCRIPT_AGENT_KEY}`;
}

export async function getScriptAgentWorkspace(
  projectId: number,
  database: any = u.db,
  options: { includeContent?: boolean; includeScriptContent?: boolean } = {},
) {
  await assertProject(projectId, database);
  await ensureWorkspaceRow(projectId, database);
  const row = await findWorkspaceRow(projectId, database);
  if (!row) throw new ScriptAgentWorkspaceError("Script Agent workspace was not found", 500);
  const scripts = await database("o_script")
    .where({ projectId })
    .orderBy("id", "asc")
    .select("id", "name", "projectId", "content", "contentTextAssetId");
  const includeContent = options.includeContent !== false;
  const includeScriptContent = options.includeScriptContent ?? includeContent;
  const [storySkeleton, adaptationStrategy, normalizedScripts] = await Promise.all([
    readWorkspaceStageText({ projectId, workspaceRow: row, stage: "storySkeleton" }, database),
    readWorkspaceStageText({ projectId, workspaceRow: row, stage: "adaptationStrategy" }, database),
    Promise.all(
      scripts.map(async (script: any) => ({
        id: Number(script.id),
        name: String(script.name || ""),
        ...(includeScriptContent ? { content: await readScriptContent(script, database) } : {}),
        contentAsset: await scriptContentMetadata(script, database),
      })),
    ),
  ]);
  return {
    workspaceId: Number(row.id),
    ...(includeContent
      ? { storySkeleton: storySkeleton.content, adaptationStrategy: adaptationStrategy.content }
      : {}),
    stageAssets: {
      storySkeleton: storySkeleton.asset,
      adaptationStrategy: adaptationStrategy.asset,
    },
    scripts: normalizedScripts,
  };
}

export async function saveScriptAgentStage(input: {
  projectId: number;
  stage: ScriptAgentStage;
  content: string;
  allowWhileRun?: boolean;
}, database: any = u.db) {
  await assertProject(input.projectId, database);
  if (!input.allowWhileRun) await assertNoActiveRun(input.projectId, database);
  const row = await ensureWorkspaceRow(input.projectId, database);
  const contentAsset = await replaceWorkspaceStageText(
    {
      projectId: input.projectId,
      workspaceId: Number(row.id),
      stage: input.stage,
      content: input.content,
      beforeCommit: input.allowWhileRun ? undefined : (trx) => assertNoActiveRun(input.projectId, trx),
    },
    database,
  );
  return { workspaceId: Number(row.id), stage: input.stage, contentAsset };
}

export async function upsertScriptAgentScript(input: {
  projectId: number;
  id?: number;
  name: string;
  content: string;
  allowWhileRun?: boolean;
}, database: any = u.db) {
  await assertProject(input.projectId, database);
  if (!input.allowWhileRun) await assertNoActiveRun(input.projectId, database);
  let scriptId = input.id == null ? null : Number(input.id);
  let created = false;
  if (scriptId != null) {
    const existing = await database("o_script").where({ id: scriptId, projectId: input.projectId }).first("id");
    if (!existing) throw new ScriptAgentWorkspaceError("Script does not belong to the current project", 404);
  } else {
    const [id] = await database("o_script").insert({
      projectId: input.projectId,
      name: input.name,
      content: "",
      createTime: Date.now(),
    });
    scriptId = Number(id);
    created = true;
  }
  try {
    const contentAsset = await replaceScriptContent(
      {
        projectId: input.projectId,
        scriptId,
        name: input.name,
        content: input.content,
        beforeCommit: input.allowWhileRun ? undefined : (trx) => assertNoActiveRun(input.projectId, trx),
      },
      database,
    );
    return { id: scriptId, name: input.name, contentAsset, created };
  } catch (error) {
    if (created) await database("o_script").where({ id: scriptId, projectId: input.projectId }).delete().catch(() => undefined);
    throw error;
  }
}

export async function deleteScriptAgentScript(input: {
  projectId: number;
  id: number;
  allowWhileRun?: boolean;
}, database: any = u.db) {
  await assertProject(input.projectId, database);
  if (!input.allowWhileRun) await assertNoActiveRun(input.projectId, database);
  const deleted = await database("o_script").where({ id: input.id, projectId: input.projectId }).delete();
  if (!deleted) throw new ScriptAgentWorkspaceError("Script does not belong to the current project", 404);
  await deleteScriptContentAssets({ projectId: input.projectId, scriptIds: [input.id] }, database);
  return { id: input.id, deleted: true };
}

export async function readScriptAgentScripts(input: { projectId: number; ids?: number[] }, database: any = u.db) {
  await assertProject(input.projectId, database);
  const query = database("o_script").where({ projectId: input.projectId }).orderBy("id", "asc");
  if (input.ids?.length) query.whereIn("id", input.ids);
  const scripts = await query.select("id", "name", "projectId", "content", "contentTextAssetId");
  if (input.ids?.length && scripts.length !== new Set(input.ids).size) {
    throw new ScriptAgentWorkspaceError("One or more scripts do not belong to the current project", 404);
  }
  return Promise.all(
    scripts.map(async (row: any) => ({
      id: Number(row.id),
      name: String(row.name || ""),
      content: await readScriptContent(row, database),
      contentAsset: await scriptContentMetadata(row, database),
    })),
  );
}
