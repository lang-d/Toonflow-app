import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-agent-run-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let db: any;
let service: typeof import("../src/services/agentRun");
let lifecycleMigration: typeof import("../src/lib/migrations/agentRunLifecycleV1");

before(async () => {
  db = (await import("../src/utils/db")).db;
  service = await import("../src/services/agentRun");
  lifecycleMigration = await import("../src/lib/migrations/agentRunLifecycleV1");
  await db.schema.createTable("o_agentRun", (table: any) => {
    table.increments("id").primary();
    table.string("runId").notNullable().unique();
    table.string("agentKey").notNullable();
    table.integer("projectId").notNullable();
    table.integer("scriptId").notNullable();
    table.string("isolationKey").notNullable();
    table.string("messageId");
    table.string("status").notNullable();
    table.string("currentStage");
    table.string("currentSubAgent");
    table.text("reason");
    table.text("errorJson");
    table.text("resultJson");
    table.integer("heartbeatAt").notNullable();
    table.integer("startedAt").notNullable();
    table.integer("finishedAt");
    table.integer("createdAt").notNullable();
    table.integer("updatedAt").notNullable();
  });
  await db.schema.createTable("o_agentRunEvent", (table: any) => {
    table.increments("id").primary();
    table.string("runId").notNullable();
    table.string("eventType").notNullable();
    table.text("payloadJson");
    table.integer("createdAt").notNullable();
  });
  await db.raw(
    "CREATE UNIQUE INDEX uq_agent_run_running_scope ON o_agentRun(agentKey, projectId, scriptId) WHERE status = 'running'",
  );
});

after(async () => {
  await db?.destroy?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function scope(scriptId = 21) {
  return {
    agentKey: "productionAgent",
    projectId: 10,
    scriptId,
    isolationKey: `10:productionAgent:${scriptId}`,
  };
}

test("database recovery preserves the freshest duplicate active scope and interrupts the rest", async () => {
  await db.raw("DROP INDEX uq_agent_run_running_scope");
  const timestamp = Date.now();
  await db("o_agentRun").insert([
    {
      runId: "duplicate-stale",
      agentKey: "productionAgent",
      projectId: 10,
      scriptId: 49,
      isolationKey: "10:productionAgent:49",
      status: "running",
      heartbeatAt: timestamp - 10,
      startedAt: timestamp - 10,
      createdAt: timestamp - 10,
      updatedAt: timestamp - 10,
    },
    {
      runId: "duplicate-fresh",
      agentKey: "productionAgent",
      projectId: 10,
      scriptId: 49,
      isolationKey: "10:productionAgent:49",
      status: "running",
      heartbeatAt: timestamp,
      startedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ]);

  assert.equal(await lifecycleMigration.repairDuplicateRunningAgentRuns(db), 1);
  assert.equal((await db("o_agentRun").where({ runId: "duplicate-fresh" }).first()).status, "running");
  assert.equal((await db("o_agentRun").where({ runId: "duplicate-stale" }).first()).status, "interrupted");
  assert.equal((await db("o_agentRunEvent").where({ runId: "duplicate-stale" }).first()).eventType, "active_scope_deduplicated");
  await db.raw(
    "CREATE UNIQUE INDEX uq_agent_run_running_scope ON o_agentRun(agentKey, projectId, scriptId) WHERE status = 'running'",
  );
});

test("only one running agent run is allowed per project script agent scope", async () => {
  const first = await service.createAgentRun({ ...scope(), messageId: "message-a" });
  assert.equal(first.created, true);
  if (!first.created) return;

  const second = await service.createAgentRun({ ...scope(), messageId: "message-b" });
  assert.equal(second.created, false);
  if (second.created) return;
  assert.equal(second.activeRun.runId, first.run.runId);

  const otherScript = await service.createAgentRun({ ...scope(22), messageId: "message-c" });
  assert.equal(otherScript.created, true);
});

test("concurrent run creation is atomically limited to one exact scope", async () => {
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, index) => service.createAgentRun({ ...scope(51), messageId: `concurrent-${index}` })),
  );
  assert.equal(results.filter((result) => result.created).length, 1);
  const created = results.find((result) => result.created);
  if (!created?.created) return;
  for (const result of results.filter((result) => !result.created)) {
    assert.equal(result.activeRun.runId, created.run.runId);
  }
});

test("different agent keys can run concurrently in the same project and script", async () => {
  const production = await service.createAgentRun({ ...scope(52), messageId: "production" });
  const music = await service.createAgentRun({
    agentKey: "musicProductionAgent",
    projectId: 10,
    scriptId: 52,
    isolationKey: "musicProductionAgent:10:episode:52",
    messageId: "music",
  });
  assert.equal(production.created, true);
  assert.equal(music.created, true);
});

test("client detach and resume are observable events without changing a running status", async () => {
  const created = await service.createAgentRun({ ...scope(23), messageId: "message-detach" });
  assert.equal(created.created, true);
  if (!created.created) return;

  await service.recordAgentRunEvent(created.run.runId, "client_detached", { socketId: "socket-old" });
  await service.recordAgentRunEvent(created.run.runId, "client_resumed", { socketId: "socket-new" });
  const detail = await service.getAgentRunDetail(created.run.runId);

  assert.equal(detail.run?.status, "running");
  assert.deepEqual(
    detail.events.slice(0, 2).map((event: any) => event.eventType),
    ["client_resumed", "client_detached"],
  );
});

test("run detail returns a normalized timeline for storyboard-table recovery", async () => {
  const created = await service.createAgentRun({ ...scope(24), messageId: "message-timeline" });
  assert.equal(created.created, true);
  if (!created.created) return;

  await service.updateAgentRunStage(created.run.runId, {
    currentStage: "decision",
    currentSubAgent: "decisionAgent",
  });
  await service.updateAgentRunProgress(created.run.runId, {
    stage: "decision",
    subAgent: "decisionAgent",
    title: "Reading current production facts",
    phase: "read",
  });
  await service.updateAgentRunStage(created.run.runId, {
    currentStage: "storyboardTable",
    currentSubAgent: "storyboardTableAgent",
  });
  await service.recordAgentRunEvent(created.run.runId, "storyboard_prepare_started", {});
  await service.recordAgentRunEvent(created.run.runId, "storyboard_prepare_completed", {
    status: "ready",
    shotCount: 20,
  });
  await service.recordAgentRunEvent(created.run.runId, "storyboard_batch_appended", {
    startIndex: 0,
    accepted: 10,
  });
  await service.recordAgentRunEvent(created.run.runId, "storyboard_committed", {
    generationId: "generation-timeline",
  });
  await service.recordAgentRunEvent(created.run.runId, "storyboard_table_review_started", {});
  await service.recordAgentRunEvent(created.run.runId, "storyboard_table_review_recorded", {
    reviewedAt: Date.now(),
  });
  await service.finishAgentRun(created.run.runId, {
    status: "awaiting_user",
    reason: "review complete",
    currentStage: "supervisionStoryboardTable",
    currentSubAgent: "supervisionStoryboardTableAgent",
  });

  const detail = await service.getAgentRunDetail(created.run.runId);
  assert.deepEqual(
    detail.timeline.map((item: any) => item.kind),
    [
      "stage",
      "agent_progress",
      "stage",
      "storyboard_table_preflight_started",
      "storyboard_table_preflight_completed",
      "storyboard_table_batch_appended",
      "storyboard_table_committed",
      "storyboard_table_review_started",
      "storyboard_table_review_recorded",
      "finished",
    ],
  );
  assert.equal(detail.timeline.at(-1)?.status, "awaiting_user");
  assert.equal(detail.timeline.find((item: any) => item.kind === "agent_progress")?.payload.title, "Reading current production facts");
  assert.equal(detail.timeline.find((item: any) => item.kind === "storyboard_table_review_recorded")?.payload.reviewedAt > 0, true);
});

test("project-level music runs use the reserved script scope without colliding with episode runs", async () => {
  const projectRun = await service.createAgentRun({
    agentKey: "musicProductionAgent",
    projectId: 10,
    scriptId: 0,
    isolationKey: "musicProductionAgent:10:project",
    messageId: "music-project",
  });
  assert.equal(projectRun.created, true);

  const episodeRun = await service.createAgentRun({
    agentKey: "musicProductionAgent",
    projectId: 10,
    scriptId: 21,
    isolationKey: "musicProductionAgent:10:episode:21",
    messageId: "music-episode",
  });
  assert.equal(episodeRun.created, true);
});

test("pending decision does not become awaiting_user until explicitly finalized", () => {
  const context = service.createAgentRunContext("run-context-test");
  context.setPendingDecision({
    stage: "storyboardTable",
    subAgent: "storyboardTableAgent",
    reason: "Draft validation needs a decision",
    resultJson: { generationId: "generation-context" },
  });
  assert.equal(context.terminalIntent, undefined);
  assert.equal(context.pendingDecision?.reason, "Draft validation needs a decision");

  context.setAwaitingUser(context.pendingDecision!);
  assert.equal((context.terminalIntent as any)?.status, "awaiting_user");
  assert.equal(context.pendingDecision, undefined);
});

test("model-declared completion is a distinct terminal intent", () => {
  const context = service.createAgentRunContext("completed-context-test");
  context.setCompleted({
    stage: "analysis",
    subAgent: "decisionAgent",
    reason: "Read-only analysis is complete",
    resultJson: { kind: "agent_completed" },
  });

  assert.equal(context.terminalIntent?.status, "completed");
  assert.equal(context.terminalIntent?.stage, "analysis");
  assert.equal(context.terminalIntent?.reason, "Read-only analysis is complete");
});

test("context overflow counting is shared by every Turn and Subagent in one Run", () => {
  const context = service.createAgentRunContext("overflow-count-context");
  assert.equal(context.recordContextOverflow(), 1);
  assert.equal(context.recordContextOverflow(), 2);
  assert.equal(context.contextOverflowCount, 2);
});

test("repeated context overflow is the only interrupted Run eligible for a new Chat resume", async () => {
  const resumableRun = await service.createAgentRun({ ...scope(35), messageId: "message-overflow" });
  assert.equal(resumableRun.created, true);
  if (!resumableRun.created) return;
  await service.recordAgentRunEvent(resumableRun.run.runId, "agent_resumable_checkpoint", {
    checkpoint: "model-authored working checkpoint",
    sourceRunId: resumableRun.run.runId,
    stage: "supervisionStoryboardTable",
  });
  await service.finishAgentRun(resumableRun.run.runId, {
    status: "interrupted",
    reason: "context overflow twice",
    errorJson: { code: "AGENT_CONTEXT_OVERFLOW_REPEATED" },
    currentStage: "supervisionStoryboardTable",
    currentSubAgent: "supervisionStoryboardTableAgent",
  });

  const resumed = await service.getResumableAgentInterruption(scope(35));
  assert.equal(resumed?.run.runId, resumableRun.run.runId);
  assert.equal(resumed?.checkpoint.checkpoint, "model-authored working checkpoint");

  const completedAfterResume = await service.createAgentRun({ ...scope(35), messageId: "message-after-resume" });
  assert.equal(completedAfterResume.created, true);
  if (!completedAfterResume.created) return;
  await service.finishAgentRun(completedAfterResume.run.runId, { status: "completed", reason: "resumed work completed" });
  assert.equal(await service.getResumableAgentInterruption(scope(35)), null);

  const ordinaryRun = await service.createAgentRun({ ...scope(36), messageId: "message-ordinary-interrupt" });
  assert.equal(ordinaryRun.created, true);
  if (!ordinaryRun.created) return;
  await service.finishAgentRun(ordinaryRun.run.runId, {
    status: "interrupted",
    reason: "runtime restarted",
    errorJson: { code: "RUNTIME_RESTARTED" },
  });
  assert.equal(await service.getResumableAgentInterruption(scope(36)), null);
});

test("Turn events retain the actual process message id", async () => {
  const created = await service.createAgentRun({ ...scope(37), messageId: "chat-initial-message" });
  assert.equal(created.created, true);
  if (!created.created) return;
  await service.recordAgentTurnStarted(created.run.runId, {
    turnId: "turn-1",
    turnNumber: 1,
    messageId: "process-message-1",
    stage: "decision",
  });
  await service.recordAgentTurnResult(created.run.runId, {
    turnId: "turn-1",
    turnNumber: 1,
    messageId: "process-message-1",
    stage: "decision",
    state: "complete",
    finishReason: "stop",
    textLength: 0,
  });
  const detail = await service.getAgentRunDetail(created.run.runId);
  const turnEvents = detail.events.filter((event: any) => event.eventType.startsWith("agent_turn_"));
  assert.equal(turnEvents.length, 2);
  assert.ok(turnEvents.every((event: any) => JSON.parse(event.payloadJson).messageId === "process-message-1"));
});

test("terminal diagnostics are normalized without storing model content", async () => {
  const created = await service.createAgentRun({ ...scope(29), messageId: "message-terminal-diagnostics" });
  assert.equal(created.created, true);
  if (!created.created) return;

  await service.recordAgentModelStreamFinished(created.run.runId, {
    finishReason: "stop",
    usage: { inputTokens: 120, outputTokens: 20, totalTokens: 140 },
    totalUsage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 },
    steps: [{ usage: { inputTokens: 80 } }, { usage: { inputTokens: 120 } }],
    toolCalls: [{}],
    text: "private response text",
  });
  await service.recordAgentRunEvent(created.run.runId, "agent_turn_context_boundary", {
    reason: "resolved_capacity",
  });
  await service.recordAgentRunEvent(created.run.runId, "terminal_declaration_missing", {
    code: "AGENT_TERMINAL_DECLARATION_MISSING",
  });
  await service.finishAgentRun(created.run.runId, {
    status: "failed",
    reason: "Agent stream ended without a terminal declaration.",
    errorJson: { code: "AGENT_TERMINAL_DECLARATION_MISSING" },
  });

  const detail = await service.getAgentRunDetail(created.run.runId);
  const stream = detail.timeline.find((item: any) => item.kind === "model_stream_finished");
  assert.deepEqual(stream?.payload, {
    finishReason: "stop",
    stepCount: 2,
    toolCallCount: 1,
    textLength: 21,
    finalStepUsage: { inputTokens: 120, outputTokens: 20, totalTokens: 140 },
    totalUsage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 },
    maxStepInputTokens: 120,
  });
  assert.equal(JSON.stringify(stream?.payload).includes("private response text"), false);
  assert.equal(detail.timeline.some((item: any) => item.kind === "agent_turn_context_boundary"), true);
  assert.equal(detail.timeline.some((item: any) => item.kind === "terminal_declaration_missing"), true);
  assert.deepEqual(detail.run?.errorJson, JSON.stringify({ code: "AGENT_TERMINAL_DECLARATION_MISSING" }));
});

test("terminal run status persists the caller-declared stage instead of a memory key", async () => {
  const created = await service.createAgentRun({ ...scope(28), messageId: "message-terminal-stage" });
  assert.equal(created.created, true);
  if (!created.created) return;

  const finished = await service.finishAgentRun(created.run.runId, {
    status: "awaiting_user",
    reason: "review complete",
    currentStage: "supervisionStoryboardTable",
    currentSubAgent: "supervisionStoryboardTableAgent",
  });

  assert.equal(finished?.currentStage, "supervisionStoryboardTable");
  assert.equal(finished?.currentSubAgent, "supervisionStoryboardTableAgent");
});

test("finished and expired agent runs no longer block new chats", async () => {
  const created = await service.createAgentRun({ ...scope(31), messageId: "message-d" });
  assert.equal(created.created, true);
  if (!created.created) return;
  await service.finishAgentRun(created.run.runId, { status: "awaiting_user", reason: "needs user" });

  const next = await service.createAgentRun({ ...scope(31), messageId: "message-e" });
  assert.equal(next.created, true);
  if (!next.created) return;

  await db("o_agentRun")
    .where({ runId: next.run.runId })
    .update({ heartbeatAt: Date.now() - service.AGENT_RUN_LEASE_TIMEOUT_MS - 1000 });
  const interrupted = await service.interruptExpiredAgentRuns();
  assert.equal(interrupted >= 1, true);

  const recovered = await db("o_agentRun").where({ runId: next.run.runId }).first();
  assert.equal(recovered.status, "interrupted");

  const afterExpiry = await service.createAgentRun({ ...scope(31), messageId: "message-f" });
  assert.equal(afterExpiry.created, true);
});

test("runtime restart immediately interrupts all stale active runs and records timeline facts", async () => {
  const created = await service.createAgentRun({ ...scope(32), messageId: "restart" });
  assert.equal(created.created, true);
  if (!created.created) return;

  const interrupted = await service.interruptAgentRunsForRuntimeRestart();
  assert.equal(interrupted >= 1, true);
  const detail = await service.getAgentRunDetail(created.run.runId);
  assert.equal(detail.run?.status, "interrupted");
  assert.equal(detail.run?.reason, "Agent run interrupted because the Agent runtime restarted.");
  assert.equal(detail.timeline.some((item: any) => item.kind === "runtime_restarted"), true);
});

test("latest run can be restored after there is no active run", async () => {
  const created = await service.createAgentRun({ ...scope(35), messageId: "message-latest" });
  assert.equal(created.created, true);
  if (!created.created) return;

  await service.finishAgentRun(created.run.runId, {
    status: "awaiting_user",
    reason: "Panel review is ready for user decision",
    currentStage: "supervisionStoryboardPanel",
    currentSubAgent: "supervisionStoryboardPanelAgent",
  });

  assert.equal(await service.getActiveAgentRun(scope(35)), null);
  const latest = await service.getLatestAgentRun(scope(35));
  assert.equal(latest?.runId, created.run.runId);
  assert.equal(latest?.status, "awaiting_user");
  assert.equal(latest?.currentStage, "supervisionStoryboardPanel");
});

test("awaiting user decision survives ordinary decision replies until the same stage completes", async () => {
  const pending = await service.createAgentRun({ ...scope(42), messageId: "message-pending" });
  assert.equal(pending.created, true);
  if (!pending.created) return;
  await service.updateAgentRunStage(pending.run.runId, {
    currentStage: "execution",
    currentSubAgent: "storyboardTableAgent",
  });
  await service.finishAgentRun(pending.run.runId, {
    status: "awaiting_user",
    reason: "Adjust the failed storyboard draft?",
    resultJson: { kind: "storyboard_validation_decision", generationId: "generation-a" },
  });

  await new Promise((resolve) => setTimeout(resolve, 2));
  const decisionReply = await service.createAgentRun({ ...scope(42), messageId: "message-decision" });
  assert.equal(decisionReply.created, true);
  if (!decisionReply.created) return;
  await service.updateAgentRunStage(decisionReply.run.runId, {
    currentStage: "decision",
    currentSubAgent: "decisionAgent",
  });
  await service.finishAgentRun(decisionReply.run.runId, { status: "completed" });

  const stillPending = await service.getUnresolvedAgentDecision(scope(42));
  assert.equal(stillPending?.run.runId, pending.run.runId);
  assert.deepEqual(stillPending?.decision, {
    kind: "storyboard_validation_decision",
    generationId: "generation-a",
  });

  await new Promise((resolve) => setTimeout(resolve, 2));
  const revised = await service.createAgentRun({ ...scope(42), messageId: "message-revised" });
  assert.equal(revised.created, true);
  if (!revised.created) return;
  await service.updateAgentRunStage(revised.run.runId, {
    currentStage: "execution",
    currentSubAgent: "storyboardTableAgent",
  });
  await service.finishAgentRun(revised.run.runId, { status: "completed" });

  assert.equal(await service.getUnresolvedAgentDecision(scope(42)), null);
});
