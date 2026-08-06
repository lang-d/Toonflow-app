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
  status: Extract<AgentRunStatus, "awaiting_user" | "completed" | "failed" | "interrupted">;
  stage?: string;
  subAgent?: string;
  reason: string;
  resultJson?: unknown;
  errorJson?: unknown;
};

export type AgentRunProgressInput = {
  stage: string;
  subAgent?: string | null;
  title: string;
  detail?: string | null;
  phase?: string | null;
};

export type AgentRunContext = {
  runId: string;
  terminalIntent?: AgentRunTerminalIntent;
  pendingDecision?: Omit<AgentRunTerminalIntent, "status">;
  contextOverflowCount: number;
  latestContextCheckpoint?: string;
  abortReason?: "user_stop" | "terminal_stop" | "replaced" | "timeout";
  requestStop?: () => void;
  markStage(stage: string, subAgent?: string): void;
  updateProgress(input: AgentRunProgressInput): Promise<void>;
  setPendingDecision(input: Omit<AgentRunTerminalIntent, "status">): void;
  clearPendingDecision(): void;
  setCompleted(input: Omit<AgentRunTerminalIntent, "status">): void;
  setAwaitingUser(input: Omit<AgentRunTerminalIntent, "status">): void;
  setFailed(input: Omit<AgentRunTerminalIntent, "status">): void;
  setInterrupted(input: Omit<AgentRunTerminalIntent, "status">): void;
  recordContextOverflow(): number;
  setContextCheckpoint(checkpoint: string): void;
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
  currentStage?: string | null;
  currentSubAgent?: string | null;
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

const AGENT_RUN_TIMELINE_KIND: Record<string, string> = {
  agent_progress: "agent_progress",
  agent_output_archived: "agent_output_archived",
  stage: "stage",
  storyboard_table_decision_received: "storyboard_table_decision",
  storyboard_prepare_started: "storyboard_table_preflight_started",
  storyboard_prepare_completed: "storyboard_table_preflight_completed",
  storyboard_prepare_failed: "storyboard_table_preflight_failed",
  storyboard_generation_started: "storyboard_table_generation_started",
  storyboard_batch_appended: "storyboard_table_batch_appended",
  storyboard_committed: "storyboard_table_committed",
  storyboard_table_review_started: "storyboard_table_review_started",
  storyboard_table_review_recorded: "storyboard_table_review_recorded",
  storyboard_table_review_failed: "storyboard_table_review_failed",
  interrupted: "interrupted",
  runtime_restarted: "runtime_restarted",
  active_scope_deduplicated: "active_scope_deduplicated",
  model_stream_finished: "model_stream_finished",
  agent_turn_started: "agent_turn_started",
  agent_turn_finished: "agent_turn_finished",
  agent_turn_interrupted: "agent_turn_interrupted",
  agent_turn_continued: "agent_turn_continued",
  agent_turn_context_boundary: "agent_turn_context_boundary",
  agent_tool_result: "agent_tool_result",
  agent_context_compacted: "agent_context_compacted",
  agent_context_compaction_failed: "agent_context_compaction_failed",
  agent_resumable_checkpoint: "agent_resumable_checkpoint",
  agent_run_resumed_from: "agent_run_resumed_from",
  agent_continuation_exhausted: "agent_continuation_exhausted",
  terminal_declaration_missing: "terminal_declaration_missing",
  finished: "finished",
};

function normalizeTimelineEvent(event: any) {
  const kind = AGENT_RUN_TIMELINE_KIND[event.eventType];
  if (!kind) return null;
  const payload = parseJson(event.payloadJson);
  const payloadObject = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, any>) : {};
  return {
    id: event.id,
    eventType: event.eventType,
    kind,
    createdAt: event.createdAt,
    stage: payloadObject.currentStage ?? payloadObject.stage ?? null,
    subAgent: payloadObject.currentSubAgent ?? payloadObject.subAgent ?? null,
    status: payloadObject.status ?? null,
    payload,
  };
}

function buildAgentRunTimeline(events: any[]) {
  return events
    .slice()
    .reverse()
    .map(normalizeTimelineEvent)
    .filter(Boolean);
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

export async function recordAgentRunEvent(runId: string, eventType: string, payload?: unknown, knex = u.db) {
  await insertEvent(runId, eventType, payload, knex);
}

function compactModelUsage(value: unknown) {
  const usage = value as { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown } | null;
  const finite = (token: unknown) => {
    const parsed = Number(token);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  return {
    inputTokens: finite(usage?.inputTokens),
    outputTokens: finite(usage?.outputTokens),
    totalTokens: finite(usage?.totalTokens),
  };
}

export async function recordAgentModelStreamFinished(runId: string, completion: unknown, knex = u.db) {
  const result = completion as {
    finishReason?: unknown;
    usage?: unknown;
    totalUsage?: unknown;
    steps?: Array<{ usage?: unknown }>;
    toolCalls?: unknown;
    text?: unknown;
  };
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const stepInputTokens = steps
    .map((step) => compactModelUsage(step?.usage).inputTokens)
    .filter((token): token is number => token != null);
  await insertEvent(
    runId,
    "model_stream_finished",
    {
      finishReason: typeof result?.finishReason === "string" ? result.finishReason : null,
      stepCount: steps.length || null,
      toolCallCount: Array.isArray(result?.toolCalls) ? result.toolCalls.length : null,
      textLength: typeof result?.text === "string" ? result.text.length : 0,
      finalStepUsage: compactModelUsage(result?.usage),
      totalUsage: compactModelUsage(result?.totalUsage),
      maxStepInputTokens: stepInputTokens.length ? Math.max(...stepInputTokens) : null,
    },
    knex,
  );
}

function compactEventResult(value: unknown) {
  if (value == null) return value;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= 16_000) return value;
    const resource = value as Record<string, unknown>;
    if (typeof resource.resourceRef === "string") {
      return {
        resourceRef: resource.resourceRef,
        key: resource.key ?? null,
        version: resource.version ?? null,
        returnedRange: resource.returnedRange ?? null,
        nextCursor: resource.nextCursor ?? null,
        eof: resource.eof ?? null,
        omitted: true,
        size: serialized.length,
        reason: "resource_payload_archived_by_reference",
      };
    }
    return { omitted: true, size: serialized.length, reason: "agent_tool_result_too_large" };
  } catch {
    return { omitted: true, reason: "agent_tool_result_not_serializable" };
  }
}

export async function recordAgentTurnStarted(
  runId: string,
  input: {
    turnId: string;
    turnNumber: number;
    messageId?: string | null;
    stage?: string | null;
    subAgent?: string | null;
    continuedFrom?: string | null;
  },
  knex = u.db,
) {
  await insertEvent(runId, "agent_turn_started", input, knex);
}

export async function recordAgentTurnResult(
  runId: string,
  input: {
    turnId: string;
    turnNumber: number;
    messageId?: string | null;
    stage?: string | null;
    subAgent?: string | null;
    state: string;
    finishReason: string;
    usage?: unknown;
    textLength: number;
    toolCalls?: Array<{ toolCallId: string | null; toolName: string | null }>;
    toolResults?: Array<{ toolCallId: string | null; toolName: string | null; success: boolean; result: unknown }>;
  },
  knex = u.db,
) {
  const eventType = input.state === "interrupted" ? "agent_turn_interrupted" : "agent_turn_finished";
  await insertEvent(
    runId,
    eventType,
    {
      ...input,
      toolResults: undefined,
      toolCallCount: input.toolCalls?.length ?? 0,
      toolResultCount: input.toolResults?.length ?? 0,
    },
    knex,
  );
  for (const result of input.toolResults || []) {
    await insertEvent(
      runId,
      "agent_tool_result",
      {
        turnId: input.turnId,
        turnNumber: input.turnNumber,
        messageId: input.messageId ?? null,
        stage: input.stage ?? null,
        subAgent: input.subAgent ?? null,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        success: result.success,
        result: compactEventResult(result.result),
      },
      knex,
    );
  }
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

export async function interruptAgentRunsForRuntimeRestart(knex = u.db) {
  if (!(await hasAgentRunTables(knex))) return 0;
  const timestamp = now();
  const rows = await knex("o_agentRun").where({ status: AGENT_RUN_ACTIVE_STATUS }).select("runId");
  if (!rows.length) return 0;

  const runIds = rows.map((row: any) => row.runId);
  await knex("o_agentRun").whereIn("runId", runIds).update({
    status: "interrupted",
    reason: "Agent run interrupted because the Agent runtime restarted.",
    finishedAt: timestamp,
    updatedAt: timestamp,
  });
  for (const runId of runIds) {
    await insertEvent(runId, "runtime_restarted", { reason: "agent_runtime_restarted" }, knex);
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

export async function getResumableAgentInterruption(
  scope: Pick<RunScope, "agentKey" | "projectId" | "scriptId" | "isolationKey">,
  knex = u.db,
) {
  if (!(await hasAgentRunTables(knex))) return null;
  const candidate = await knex("o_agentRun")
    .where({
      agentKey: scope.agentKey,
      projectId: scope.projectId,
      scriptId: scope.scriptId,
      isolationKey: scope.isolationKey,
    })
    .orderBy("startedAt", "desc")
    .first();
  if (!candidate || candidate.status !== "interrupted") return null;
  const error = parseJson(candidate.errorJson) as { code?: unknown } | null;
  if (error?.code !== "AGENT_CONTEXT_OVERFLOW_REPEATED") return null;
  const checkpointEvent = await knex("o_agentRunEvent")
    .where({ runId: candidate.runId, eventType: "agent_resumable_checkpoint" })
    .orderBy("id", "desc")
    .first();
  if (!checkpointEvent) return null;
  const checkpoint = parseJson(checkpointEvent.payloadJson) as { checkpoint?: unknown } | null;
  if (typeof checkpoint?.checkpoint !== "string" || !checkpoint.checkpoint.trim()) return null;
  return { run: normalizeRun(candidate)!, checkpoint };
}

export async function createAgentRun(input: CreateRunInput, knex = u.db) {
  if (!(await hasAgentRunTables(knex))) throw new Error("Agent run tables are not initialized");
  await interruptExpiredAgentRuns(knex);

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
    if (!isRunningScopeConflict(error)) throw error;
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

function isRunningScopeConflict(error: unknown) {
  const message = String((error as any)?.message || "");
  return (
    message.includes("uq_agent_run_running_scope") ||
    message.includes("UNIQUE constraint failed: o_agentRun.agentKey, o_agentRun.projectId, o_agentRun.scriptId")
  );
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

export async function updateAgentRunProgress(runId: string, input: AgentRunProgressInput, knex = u.db) {
  const timestamp = now();
  await knex("o_agentRun").where({ runId, status: AGENT_RUN_ACTIVE_STATUS }).update({
    currentStage: input.stage,
    currentSubAgent: input.subAgent ?? null,
    heartbeatAt: timestamp,
    updatedAt: timestamp,
  });
  await insertEvent(runId, "agent_progress", input, knex);
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
    currentStage: input.currentStage ?? row.currentStage ?? null,
    currentSubAgent: input.currentSubAgent ?? row.currentSubAgent ?? null,
    heartbeatAt: timestamp,
    finishedAt: timestamp,
    updatedAt: timestamp,
  });
  await insertEvent(runId, "finished", input, knex);
  return normalizeRun(await knex("o_agentRun").where({ runId }).first());
}

export async function getAgentRunDetail(runId: string, knex = u.db) {
  if (!(await hasAgentRunTables(knex))) return { run: null, events: [] as any[], timeline: [] as any[] };
  const run = normalizeRun(await knex("o_agentRun").where({ runId }).first());
  const events = await knex("o_agentRunEvent").where({ runId }).orderBy("id", "desc").limit(100);
  return { run, events, timeline: buildAgentRunTimeline(events) };
}

export function createAgentRunContext(runId: string): AgentRunContext {
  const context: AgentRunContext = {
    runId,
    contextOverflowCount: 0,
    markStage(stage, subAgent) {
      void updateAgentRunStage(runId, { currentStage: stage, currentSubAgent: subAgent }).catch((error) => {
        console.warn("[agentRun] failed to update stage", error);
      });
    },
    async updateProgress(input) {
      await updateAgentRunProgress(runId, input);
    },
    setPendingDecision(input) {
      context.pendingDecision = input;
    },
    clearPendingDecision() {
      context.pendingDecision = undefined;
    },
    setCompleted(input) {
      context.terminalIntent = { ...input, status: "completed" };
      context.pendingDecision = undefined;
    },
    setAwaitingUser(input) {
      context.terminalIntent = { ...input, status: "awaiting_user" };
      context.pendingDecision = undefined;
    },
    setFailed(input) {
      context.terminalIntent = { ...input, status: "failed" };
    },
    setInterrupted(input) {
      context.terminalIntent = { ...input, status: "interrupted" };
      context.pendingDecision = undefined;
    },
    recordContextOverflow() {
      context.contextOverflowCount += 1;
      return context.contextOverflowCount;
    },
    setContextCheckpoint(checkpoint) {
      context.latestContextCheckpoint = checkpoint;
    },
    stopForTerminal() {
      context.abortReason = "terminal_stop";
      context.requestStop?.();
    },
  };
  return context;
}
