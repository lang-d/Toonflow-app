import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

// This test uses the same local Run persistence and stream cancellation services as
// the socket route, without requiring a provider key or a running Socket server.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-production-abort-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let db: any;
let agentRun: typeof import("../src/services/agentRun");
let runRegistry: typeof import("../src/services/productionAgentRunRegistry");
let streaming: typeof import("../src/agents/shared/streaming");

class FakeTextStream {
  status = "pending";

  append() {
    this.status = "streaming";
  }

  complete() {
    this.status = "complete";
  }

  error() {
    this.status = "error";
  }
}

class FakeMessage {
  readonly textStream = new FakeTextStream();
  status = "pending";

  text() {
    return this.textStream;
  }

  thinking() {
    return { complete() {} };
  }

  complete() {
    this.status = "complete";
  }

  stop() {
    this.status = "stop";
  }

  error() {
    this.status = "error";
  }
}

function blockedStream(onNext: () => void): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          onNext();
          return new Promise<IteratorResult<never>>(() => undefined);
        },
        return() {
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

function terminalToolThenBlockedStream(onReturn: () => void): AsyncIterable<any> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next() {
          if (index++ === 0) {
            return Promise.resolve({
              done: false,
              value: {
                type: "tool-result",
                toolCallId: "await-user-decision-1",
                toolName: "await_user_decision",
                output: { recorded: true },
              },
            });
          }
          return new Promise<IteratorResult<any>>(() => undefined);
        },
        return() {
          onReturn();
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

before(async () => {
  db = (await import("../src/utils/db")).db;
  agentRun = await import("../src/services/agentRun");
  runRegistry = await import("../src/services/productionAgentRunRegistry");
  streaming = await import("../src/agents/shared/streaming");

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

test("registered production abort stops the live model stream and persists a cancelled Run", async () => {
  const scope = {
    agentKey: "productionAgent",
    projectId: 801,
    scriptId: 802,
    isolationKey: "801:productionAgent:802",
  };
  const created = await agentRun.createAgentRun({ ...scope, messageId: "abort-lifecycle" });
  assert.equal(created.created, true);
  if (!created.created) return;

  const controller = new AbortController();
  const runContext = agentRun.createAgentRunContext(created.run.runId);
  const modelStreamScope = streaming.createAgentModelStreamScope(controller.signal);
  const message = new FakeMessage();
  let signalNextStarted!: () => void;
  const nextStarted = new Promise<void>((resolve) => {
    signalNextStarted = resolve;
  });

  runRegistry.registerProductionAgentRunControl(scope.isolationKey, {
    runId: created.run.runId,
    controller,
    runContext,
  });

  try {
    const streamResult = streaming.consumeFullStream({
      agentName: "productionAgent",
      fullStream: blockedStream(signalNextStarted),
      initialMsg: message,
      userAbortSignal: controller.signal,
      abortModelStream: modelStreamScope.abort,
      idleTimeoutMs: 30_000,
    });
    await nextStarted;

    assert.deepEqual(runRegistry.stopProductionAgentRunControl(scope.isolationKey, created.run.runId), {
      runId: created.run.runId,
    });
    assert.equal(runContext.abortReason, "user_stop");
    assert.equal(controller.signal.aborted, true);
    assert.equal(modelStreamScope.signal.aborted, true);
    await assert.rejects(streamResult, { name: "AbortError", message: "Agent stream aborted" });
    assert.equal(message.status, "stop");
    assert.equal(message.textStream.status, "complete");

    // This is the same terminal branch used by the production socket route.
    const finished = await agentRun.finishAgentRun(created.run.runId, {
      status: runContext.abortReason === "user_stop" ? "cancelled" : "failed",
      reason: runContext.abortReason === "user_stop" ? "用户已停止当前 Production Agent chat。" : "Unexpected stream failure.",
    });
    assert.equal(finished?.status, "cancelled");

    const detail = await agentRun.getAgentRunDetail(created.run.runId);
    assert.equal(detail.run?.status, "cancelled");
    assert.equal(detail.run?.reason, "用户已停止当前 Production Agent chat。");
    assert.equal(detail.timeline[0]?.eventType, "finished");
    assert.equal(detail.timeline[0]?.status, "cancelled");
  } finally {
    runRegistry.clearProductionAgentRunControl(scope.isolationKey, created.run.runId);
    modelStreamScope.dispose();
  }

  assert.equal(runRegistry.stopProductionAgentRunControl(scope.isolationKey, created.run.runId), null);
});

test("a successful terminal tool result stops a blocked parent stream and persists awaiting_user", async () => {
  const scope = {
    agentKey: "productionAgent",
    projectId: 811,
    scriptId: 812,
    isolationKey: "811:productionAgent:812",
  };
  const created = await agentRun.createAgentRun({ ...scope, messageId: "terminal-tool-lifecycle" });
  assert.equal(created.created, true);
  if (!created.created) return;

  const controller = new AbortController();
  const runContext = agentRun.createAgentRunContext(created.run.runId);
  const message = new FakeMessage();
  let observed = false;
  let iteratorReturned = false;
  runContext.bindRootStop(() => controller.abort());
  runContext.setAwaitingUser({ reason: "Need user confirmation." });

  await assert.rejects(
    streaming.consumeAgentTurn({
      agentName: "productionAgent",
      fullStream: terminalToolThenBlockedStream(() => {
        iteratorReturned = true;
      }),
      initialMsg: message,
      userAbortSignal: controller.signal,
      idleTimeoutMs: 30_000,
      onToolResultObserved: ({ success, toolName }: any) => {
        observed = success && toolName === "await_user_decision";
        if (observed && runContext.terminalIntent) runContext.stopForTerminal();
      },
    }),
    { name: "AbortError", message: "Agent stream aborted" },
  );

  assert.equal(observed, true);
  assert.equal(iteratorReturned, true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(runContext.abortReason, "terminal_stop");
  assert.equal(runContext.terminalIntent?.status, "awaiting_user");

  const finished = await agentRun.finishAgentRun(created.run.runId, {
    status: runContext.terminalIntent!.status,
    reason: runContext.terminalIntent!.reason,
    resultJson: runContext.terminalIntent!.resultJson,
  });
  assert.equal(finished?.status, "awaiting_user");

  const detail = await agentRun.getAgentRunDetail(created.run.runId);
  assert.equal(detail.run?.status, "awaiting_user");
  assert.equal(detail.timeline[0]?.eventType, "finished");
  assert.equal(detail.timeline[0]?.status, "awaiting_user");
});
