import u from "@/utils";

export const AGENT_RUN_ACTIVE_STATUS = "running" as const;
export const AGENT_RUN_TERMINAL_STATUSES = [
  "awaiting_user",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type AgentRunStatus =
  | typeof AGENT_RUN_ACTIVE_STATUS
  | (typeof AGENT_RUN_TERMINAL_STATUSES)[number];

export type AgentRunTerminalIntent = {
  status: Extract<AgentRunStatus, "awaiting_user" | "failed">;
  stage?: string;
  subAgent?: string;
  reason: string;
  resultJson?: unknown;
  errorJson?: unknown;
};

export type AgentRunContext = {
  runId: string;
  terminalIntent?: AgentRunTerminalIntent;
  pendingDecision?: Omit<AgentRunTerminalIntent, "status">;
  abortReason?: "user_stop" | "socket_disconnect" | "terminal_stop" | "replaced" | "timeout";
  requestStop?: () => void;
  markStage(stage: string, subAgent?: string): void;
  setPendingDecision(input: Omit<AgentRunTerminalIntent, "status">): void;
  clearPendingDecision(): void;
  setAwaitingUser(input: Omit<AgentRunTerminalIntent, "status">): void;
  setFailed(input: Omit<AgentRunTerminalIntent, "status">): void;
  stopForTerminal(): void;
};

export const AGENT_RUN_HEARTBEAT_INTERVAL_MS = 10_000;
export const AGENT_RUN_LEASE_TIMEOUT_MS = 5 * 60_000;

type RunScope = {
  agentKey: string;
  projectId: number;
  scriptId: number;
  isolationKey: string;
};

type CreateRunInput = RunScope & {
  messageId?: string | null;
};

type FinishRunInput = {
  status: AgentRunStatus;
  reason?: string | null;
  errorJson?: unknown;
  resultJson?: unknown;
};

function now() {
  return Date.now();
}

function safeJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ message: String(value) });
  }
}

function parseJson(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeRun(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.runId,
    agentKey: row.agentKey,
    projectId: row.projectId,
    scriptId: row.scriptId,
    isolationKey: row.isolationKey,
    messageId: row.messageId ?? null,
    status: row.status as AgentRunStatus,
    currentStage: row.currentStage ?? null,
    currentSubAgent: row.currentSubAgent ?? null,
    reason: row.reason ?? null,
    errorJson: row.errorJson ?? null,
    resultJson: row.resultJson ?? null,
    heartbeatAt: row.heartbeatAt ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

async function hasAgentRunTables(knex = u.db) {
  return (await knex.schema.hasTable("o_agentRun")) && (await knex.schema.hasTable("o_agentRunEvent"));
}

async function insertEvent(runId: string, eventType: string, payload?: unknown, knex = u.db) {
  if (!(await knex.schema.hasTable("o_agentRunEvent"))) return;
  const timestamp = now();
  await knex("o_agentRunEvent").insert({
    runId,
    eventType,
    payloadJson: safeJson(payload),
    createdAt: timestamp,
  });
}

export async function interruptExpiredAgentRuns(knex = u.db) {
  if (!(await hasAgentRunTables(knex))) return 0;
  const timestamp = now();
  const cutoff = timestamp - AGENT_RUN_LEASE_TIMEOUT_MS;
  const rows = await knex("o_agentRun")
    .where({ status: AGENT_RUN_ACTIVE_STATUS })
    .where("heartbeatAt", "<", cutoff)
    .select("runId");
  if (!rows.length) return 0;
  const runIds = rows.map((row: any) => row.runId);
  await knex("o_agentRun").whereIn("runId", runIds).update({
    status: "interrupted",
    reason: "Agent run heartbeat expired after backend restart or connection loss.",
    finishedAt: timestamp,
    updatedAt: timestamp,
  });
  for (const runId of runIds) {
    await insertEvent(runId, "interrupted", { reason: "heartbeat_expired" }, knex);
  }
  return runIds.length;
}

export async function getActiveAgentRun(scope: Pick<RunScope, "agentKey" | "projectId" | "scriptId">, knex = u.db) {
  if (!(await hasAgentRunTables(knex))) return null;
  await interruptExpiredAgentRuns(knex);
  const row = await knex("o_agentRun")
    .where({
      agentKey: scope.agentKey,
      projectId: scope.projectId,
      scriptId: scope.scriptId,
      status: AGENT_RUN_ACTIVE_STATUS,
    })
    .orderBy("startedAt", "desc")
    .first();
  return normalizeRun(row);
}

export async function getLatestAgentRun(scope: Pick<RunScope, "agentKey" | "projectId" | "scriptId">, knex = u.db) {
  if (!(await hasAgentRunTables(knex))) return null;
  const row = await knex("o_agentRun")
    .where({
      agentKey: scope.agentKey,
      projectId: scope.projectId,
      scriptId: scope.scriptId,
    })
    .orderBy("startedAt", "desc")
    .first();
  return normalizeRun(row);
}

export async function getUnresolvedAgentDecision(
  scope: Pick<RunScope, "agentKey" | "projectId" | "scriptId">,
  knex = u.db,
) {
  if (!(await hasAgentRunTables(knex))) return null;
  const candidates = await knex("o_agentRun")
    .where({
      agentKey: scope.agentKey,
      projectId: scope.projectId,
      scriptId: scope.scriptId,
      status: "awaiting_user",
    })
    .orderBy("startedAt", "desc");

  for (const candidate of candidates) {
    const resolved = await knex("o_agentRun")
      .where({
        agentKey: scope.agentKey,
        projectId: scope.projectId,
        scriptId: scope.scriptId,
        status: "completed",
        currentStage: candidate.currentStage,
        currentSubAgent: candidate.currentSubAgent,
      })
      .andWhere("startedAt", ">", Number(candidate.startedAt || 0))
      .first("runId");
    if (resolved) continue;
    const run = normalizeRun(candidate)!;
    return {
      run,
      decision: parseJson(run.resultJson),
    };
  }
  return null;
}

export async function createAgentRun(input: CreateRunInput, knex = u.db) {
  if (!(await hasAgentRunTables(knex))) throw new Error("Agent run tables are not initialized");
  await interruptExpiredAgentRuns(knex);
  const active = await getActiveAgentRun(input, knex);
  if (active) return { created: false as const, activeRun: active };

  const timestamp = now();
  const runId = u.uuid();
  try {
    await knex("o_agentRun").insert({
      runId,
      agentKey: input.agentKey,
      projectId: input.projectId,
      scriptId: input.scriptId,
      isolationKey: input.isolationKey,
      messageId: input.messageId ?? null,
      status: AGENT_RUN_ACTIVE_STATUS,
      heartbeatAt: timestamp,
      startedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  } catch (error: any) {
    const activeAfterRace = await getActiveAgentRun(input, knex);
    if (activeAfterRace) return { created: false as const, activeRun: activeAfterRace };
    throw error;
  }
  await insertEvent(runId, "created", input, knex);
  return {
    created: true as const,
    run: normalizeRun(await knex("o_agentRun").where({ runId }).first())!,
  };
}

export async function updateAgentRunHeartbeat(runId: string, knex = u.db) {
  const timestamp = now();
  await knex("o_agentRun").where({ runId, status: AGENT_RUN_ACTIVE_STATUS }).update({
    heartbeatAt: timestamp,
    updatedAt: timestamp,
  });
}

export async function updateAgentRunStage(
  runId: string,
  input: { currentStage?: string | null; currentSubAgent?: string | null },
  knex = u.db,
) {
  const timestamp = now();
  await knex("o_agentRun").where({ runId, status: AGENT_RUN_ACTIVE_STATUS }).update({
    currentStage: input.currentStage ?? null,
    currentSubAgent: input.currentSubAgent ?? null,
    heartbeatAt: timestamp,
    updatedAt: timestamp,
  });
  await insertEvent(runId, "stage", input, knex);
}

export async function finishAgentRun(runId: string, input: FinishRunInput, knex = u.db) {
  const timestamp = now();
  const row = await knex("o_agentRun").where({ runId }).first();
  if (!row) return null;
  if (row.status !== AGENT_RUN_ACTIVE_STATUS) return normalizeRun(row);
  await knex("o_agentRun").where({ runId }).update({
    status: input.status,
    reason: input.reason ?? null,
    errorJson: safeJson(input.errorJson),
    resultJson: safeJson(input.resultJson),
    heartbeatAt: timestamp,
    finishedAt: timestamp,
    updatedAt: timestamp,
  });
  await insertEvent(runId, "finished", input, knex);
  return normalizeRun(await knex("o_agentRun").where({ runId }).first());
}

export async function getAgentRunDetail(runId: string, knex = u.db) {
  if (!(await hasAgentRunTables(knex))) return { run: null, events: [] as any[] };
  const run = normalizeRun(await knex("o_agentRun").where({ runId }).first());
  const events = await knex("o_agentRunEvent").where({ runId }).orderBy("id", "desc").limit(100);
  return { run, events };
}

export function createAgentRunContext(runId: string): AgentRunContext {
  const context: AgentRunContext = {
    runId,
    markStage(stage, subAgent) {
      void updateAgentRunStage(runId, { currentStage: stage, currentSubAgent: subAgent }).catch((error) => {
        console.warn("[agentRun] failed to update stage", error);
      });
    },
    setPendingDecision(input) {
      context.pendingDecision = input;
    },
    clearPendingDecision() {
      context.pendingDecision = undefined;
    },
    setAwaitingUser(input) {
      context.terminalIntent = { ...input, status: "awaiting_user" };
      context.pendingDecision = undefined;
    },
    setFailed(input) {
      context.terminalIntent = { ...input, status: "failed" };
    },
    stopForTerminal() {
      context.abortReason = "terminal_stop";
      context.requestStop?.();
    },
  };
  return context;
}
