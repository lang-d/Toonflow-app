import u from "@/utils";
import { getActiveAgentRun } from "@/services/agentRun";

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

type WorkspaceData = {
  storySkeleton: string;
  adaptationStrategy: string;
};

const workspaceCreationLocks = new WeakMap<object, Map<number, Promise<void>>>();

function parseWorkspaceData(value: unknown): WorkspaceData {
  if (typeof value !== "string" || !value.trim()) {
    return { storySkeleton: "", adaptationStrategy: "" };
  }
  try {
    const parsed = JSON.parse(value) as Partial<WorkspaceData>;
    return {
      storySkeleton: typeof parsed.storySkeleton === "string" ? parsed.storySkeleton : "",
      adaptationStrategy: typeof parsed.adaptationStrategy === "string" ? parsed.adaptationStrategy : "",
    };
  } catch {
    return { storySkeleton: "", adaptationStrategy: "" };
  }
}

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
    data: JSON.stringify({ storySkeleton: "", adaptationStrategy: "" }),
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

function normalizeScript(row: any) {
  return {
    id: Number(row.id),
    name: String(row.name || ""),
    content: String(row.content || ""),
  };
}

export function scriptAgentIsolationKey(projectId: number) {
  return `${projectId}:${SCRIPT_AGENT_KEY}`;
}

export async function getScriptAgentWorkspace(projectId: number, database: any = u.db) {
  await assertProject(projectId, database);
  await ensureWorkspaceRow(projectId, database);
  return database.transaction(async (trx: any) => {
    await assertProject(projectId, trx);
    const row = await findWorkspaceRow(projectId, trx);
    if (!row) throw new ScriptAgentWorkspaceError("Script Agent workspace was not found", 500);
    const scripts = await trx("o_script").where({ projectId }).orderBy("id", "asc").select("id", "name", "content");
    return {
      workspaceId: Number(row.id),
      ...parseWorkspaceData(row.data),
      scripts: scripts.map(normalizeScript),
    };
  });
}

export async function saveScriptAgentStage(input: {
  projectId: number;
  stage: ScriptAgentStage;
  content: string;
  allowWhileRun?: boolean;
}, database: any = u.db) {
  await assertProject(input.projectId, database);
  if (!input.allowWhileRun) await assertNoActiveRun(input.projectId, database);
  await ensureWorkspaceRow(input.projectId, database);
  return database.transaction(async (trx: any) => {
    await assertProject(input.projectId, trx);
    if (!input.allowWhileRun) await assertNoActiveRun(input.projectId, trx);
    const row = await findWorkspaceRow(input.projectId, trx);
    if (!row) throw new ScriptAgentWorkspaceError("Script Agent workspace was not found", 500);
    const next = { ...parseWorkspaceData(row.data), [input.stage]: input.content };
    await trx("o_agentWorkData").where({ id: row.id, projectId: input.projectId, key: SCRIPT_AGENT_KEY }).update({
      data: JSON.stringify(next),
    });
    return { workspaceId: Number(row.id), stage: input.stage, content: input.content };
  });
}

export async function upsertScriptAgentScript(input: {
  projectId: number;
  id?: number;
  name: string;
  content: string;
  allowWhileRun?: boolean;
}, database: any = u.db) {
  return database.transaction(async (trx: any) => {
    await assertProject(input.projectId, trx);
    if (!input.allowWhileRun) await assertNoActiveRun(input.projectId, trx);

    if (input.id != null) {
      const existing = await trx("o_script").where({ id: input.id, projectId: input.projectId }).first("id");
      if (!existing) throw new ScriptAgentWorkspaceError("Script does not belong to the current project", 404);
      await trx("o_script").where({ id: input.id, projectId: input.projectId }).update({ name: input.name, content: input.content });
      return { id: input.id, name: input.name, content: input.content, created: false };
    }

    const [id] = await trx("o_script").insert({ projectId: input.projectId, name: input.name, content: input.content });
    return { id: Number(id), name: input.name, content: input.content, created: true };
  });
}

export async function deleteScriptAgentScript(input: {
  projectId: number;
  id: number;
  allowWhileRun?: boolean;
}, database: any = u.db) {
  return database.transaction(async (trx: any) => {
    await assertProject(input.projectId, trx);
    if (!input.allowWhileRun) await assertNoActiveRun(input.projectId, trx);
    const deleted = await trx("o_script").where({ id: input.id, projectId: input.projectId }).delete();
    if (!deleted) throw new ScriptAgentWorkspaceError("Script does not belong to the current project", 404);
    return { id: input.id, deleted: true };
  });
}

export async function readScriptAgentScripts(input: { projectId: number; ids?: number[] }, database: any = u.db) {
  await assertProject(input.projectId, database);
  const query = database("o_script").where({ projectId: input.projectId }).orderBy("id", "asc");
  if (input.ids?.length) query.whereIn("id", input.ids);
  const scripts = await query.select("id", "name", "content");
  if (input.ids?.length && scripts.length !== new Set(input.ids).size) {
    throw new ScriptAgentWorkspaceError("One or more scripts do not belong to the current project", 404);
  }
  return scripts.map(normalizeScript);
}
