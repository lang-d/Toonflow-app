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

before(async () => {
  db = (await import("../src/utils/db")).db;
  service = await import("../src/services/agentRun");
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
