import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-agent-context-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let context: typeof import("../src/services/agentContextCompaction");
let db: any;

before(async () => {
  context = await import("../src/services/agentContextCompaction");
  db = (await import("../src/utils/db")).db;
});

after(async () => {
  await db.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("unknown text models use one conservative fallback without requiring user catalog metadata", () => {
  assert.deepEqual(context.calculateAgentContextBudget({}), {
    contextWindowTokens: 32_768,
    maxOutputTokens: 8_192,
    safeInputTokens: 21_299,
    source: "fallback",
  });
});

test("known model capacity uses resolved metadata instead of an artificial model-size cap", () => {
  assert.deepEqual(
    context.calculateAgentContextBudget({ contextWindowTokens: 1_000_000, maxOutputTokens: 100_000 }),
    {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 100_000,
      safeInputTokens: 800_000,
      source: "resolved",
    },
  );
});

test("provider-neutral estimate is conservative for mixed Chinese task context", () => {
  assert.equal(context.estimateAgentTokens("执行分镜面板 review"), 6);
  assert.equal(context.estimateAgentTokens(""), 0);
});

test("checkpoint compaction is one separate non-streaming model call without schema repair", () => {
  const source = fs.readFileSync(path.resolve("src/services/agentContextCompaction.ts"), "utf8");
  assert.match(source, /\.invoke\(\{/);
  assert.match(source, /maxRetries: 0/);
  assert.match(source, /production-agent-checkpoint/);
  assert.doesNotMatch(source, /agentWorkingContextSchema|parseAiJsonWithSchema|Output\.object/);
  assert.doesNotMatch(source, /prepareStep/);
  assert.match(source, /only when the supplied toolCalls\/toolResults prove that claim/);
  assert.match(source, /mentioned only in assistantOutput is an unverified idea/);
});

test("turn continuation keeps assistant output and bounded objective tool facts", () => {
  const turn = {
    text: "Pass 1 complete; shots 0-10 were checked.",
    state: "interrupted" as const,
    finishReason: "length",
    usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
    toolCalls: [{ toolCallId: "call-1", toolName: "read_storyboard_generation" }],
    toolResults: [
      {
        toolCallId: "call-1",
        toolName: "read_storyboard_generation",
        success: true,
        result: { generationId: "generation-1", revision: 1 },
      },
    ],
  };
  const continuation = context.buildAgentTurnContinuationContext(turn);
  assert.match(continuation, /Pass 1 complete; shots 0-10 were checked/);
  assert.match(continuation, /read_storyboard_generation/);
  assert.match(continuation, /generation-1/);
  assert.doesNotMatch(continuation, /Re-read authoritative facts/);
});

test("large tool results preserve their beginning and end within per-result and per-turn limits", () => {
  const latest = `BEGIN-${"a".repeat(20_000)}-END`;
  const results = Array.from({ length: 8 }, (_, index) => ({
    toolCallId: `call-${index}`,
    toolName: "get_flowData",
    success: true,
    result: index === 7 ? latest : `${index}-${"b".repeat(10_000)}`,
  }));
  const bounded = context.boundAgentTurnToolResults(results);
  const latestResult = bounded.items.find((item) => item.toolCallId === "call-7")?.result as {
    truncated: boolean;
    head: string;
    tail: string;
  };
  assert.equal(latestResult.truncated, true);
  assert.match(latestResult.head, /BEGIN-/);
  assert.match(latestResult.tail, /-END/);
  assert.ok(JSON.stringify(latestResult).length <= context.MAX_AGENT_TOOL_RESULT_CHARS);
  assert.ok(JSON.stringify(bounded).length <= context.MAX_AGENT_TURN_TOOL_RESULTS_CHARS);
  assert.ok(bounded.items.some((item) => item.resultOmitted) || bounded.omittedMetadataCount > 0);
});

test("continuation payload prioritizes the newest tool result over earlier large reads", () => {
  const bounded = context.boundAgentTurnToolResults([
    { toolCallId: "old", toolName: "get_flowData", success: true, result: "o".repeat(30_000) },
    {
      toolCallId: "latest",
      toolName: "read_storyboard_generation",
      success: true,
      result: `LATEST-BEGIN-${"n".repeat(20_000)}-LATEST-END`,
    },
  ]);
  const latest = bounded.items.find((item) => item.toolCallId === "latest")?.result as {
    head: string;
    tail: string;
  };
  assert.match(latest.head, /LATEST-BEGIN/);
  assert.match(latest.tail, /LATEST-END/);
});

test("resource tool continuation preserves exact range and cursor without copying the payload", () => {
  const bounded = context.boundAgentTurnToolResults([
    {
      toolCallId: "resource-1",
      toolName: "resource_access",
      success: true,
      result: {
        resourceRef: "production-resource:ref",
        key: "storyboard",
        version: "v1",
        returnedRange: { unit: "item", start: 20, end: 30 },
        nextCursor: "production-cursor:next",
        eof: false,
        items: [{ prompt: "x".repeat(30_000) }],
      },
    },
  ]);
  const result = bounded.items[0]?.result as Record<string, unknown>;
  assert.deepEqual(result.returnedRange, { unit: "item", start: 20, end: 30 });
  assert.equal(result.nextCursor, "production-cursor:next");
  assert.equal(result.pendingConsumption, true);
  assert.equal(JSON.stringify(result).includes("x".repeat(100)), false);
});

test("forced compaction preserves bounded tool-result edges while the next production Turn stays bounded", () => {
  const result = `BEGIN-${"a".repeat(15_000)}-MIDDLE-RANGE-10-19-${"b".repeat(15_000)}-END`;
  const turn = {
    text: "Rows 0-9 were inspected.",
    state: "interrupted" as const,
    finishReason: "tool-calls",
    usage: { inputTokens: 10_000, outputTokens: 100, totalTokens: 10_100 },
    toolCalls: [{ toolCallId: "call-1", toolName: "read_storyboard_generation" }],
    toolResults: [
      {
        toolCallId: "call-1",
        toolName: "read_storyboard_generation",
        success: true,
        result,
      },
    ],
  };
  const compactionSource = context.buildAgentTurnCompactionContext(turn, "context_budget_boundary");
  assert.match(compactionSource, /BEGIN-/);
  assert.match(compactionSource, /-END/);
  assert.doesNotMatch(compactionSource, /MIDDLE-RANGE-10-19/);
  assert.ok(compactionSource.length <= context.MAX_AGENT_COMPACTION_TOOL_RESULTS_CHARS + 20_000);
  assert.ok(JSON.stringify(context.boundAgentTurnToolResults(turn.toolResults)).length <= context.MAX_AGENT_TURN_TOOL_RESULTS_CHARS);
});

test("consecutive length counting is independent of changing tool activity", () => {
  let count = 0;
  count = context.advanceConsecutiveLengthTurns(count, "length");
  count = context.advanceConsecutiveLengthTurns(count, "length");
  count = context.advanceConsecutiveLengthTurns(count, "length");
  count = context.advanceConsecutiveLengthTurns(count, "length");
  assert.equal(count, 4);
  assert.equal(context.advanceConsecutiveLengthTurns(count, "tool-calls"), 0);
});

function fakeToolStep(input: { inputTokens: number | null; content: unknown; responseMessages: unknown }) {
  return {
    finishReason: "tool-calls",
    usage: { inputTokens: input.inputTokens },
    content: input.content,
    response: { messages: input.responseMessages },
  } as any;
}

test("unknown models do not use a character-count Turn boundary after a large tool step", () => {
  const guard = context.createProductionAgentTurnInputGuardForBudget({
    budget: context.calculateAgentContextBudget({}),
  });
  const stopped = guard.stopWhen({
    steps: [
      fakeToolStep({
        inputTokens: 80_000,
        content: [{ type: "tool-result", output: "x".repeat(2_000) }],
        responseMessages: [{ role: "tool", content: "x".repeat(2_000) }],
      }),
    ],
  });
  assert.equal(stopped, false);
  assert.equal(guard.getBoundary(), null);
});

test("small incremental results do not create a Turn boundary for unknown models", () => {
  const guard = context.createProductionAgentTurnInputGuardForBudget({
    budget: context.calculateAgentContextBudget({}),
  });
  const stopped = guard.stopWhen({
    steps: [
      fakeToolStep({
        inputTokens: 80_000,
        content: [{ type: "tool-result", output: "ok" }],
        responseMessages: [{ role: "tool", content: "ok" }],
      }),
    ],
  });
  assert.equal(stopped, false);
  assert.equal(guard.getBoundary(), null);
});

test("resolved model capacity stops a projected over-budget next step before the incremental limit", () => {
  const guard = context.createProductionAgentTurnInputGuardForBudget({
    budget: context.calculateAgentContextBudget({ contextWindowTokens: 10_000, maxOutputTokens: 1_000 }),
  });
  const stopped = guard.stopWhen({
    steps: [
      fakeToolStep({
        inputTokens: 7_500,
        content: [{ type: "tool-result", output: "x".repeat(2_000) }],
        responseMessages: [{ role: "tool", content: "x".repeat(2_000) }],
      }),
    ],
  });
  assert.equal(stopped, true);
  assert.equal(guard.getBoundary()?.reason, "resolved_capacity");
  assert.ok((guard.getBoundary()?.estimatedNextInputTokens || 0) >= 8_000);
});

test("non-serializable tool response does not invent a boundary for an unknown-capacity model", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const guard = context.createProductionAgentTurnInputGuardForBudget({
    budget: context.calculateAgentContextBudget({}),
  });
  const stopped = guard.stopWhen({
    steps: [fakeToolStep({ inputTokens: 1_000, content: circular, responseMessages: circular })],
  });
  assert.equal(stopped, false);
  assert.equal(guard.getBoundary(), null);
});

test("provider context overflow detection uses explicit structured codes or diagnostic text", () => {
  assert.equal(context.isContextWindowOverflowError({ code: "context_length_exceeded" }), true);
  assert.equal(
    context.isContextWindowOverflowError({ error: { message: "This model's maximum context length was exceeded" } }),
    true,
  );
  assert.equal(context.isContextWindowOverflowError({ status: 429, message: "rate limit exceeded" }), false);
});

test("free-text checkpoint becomes the only next-Turn working context", () => {
  const checkpoint = context.parseProductionAgentCheckpoint(
    `${context.AGENT_CHECKPOINT_START}\n已完成：rows 0-19 reviewed\n待完成：review rows 20-32\n证据：generation-1\n${context.AGENT_CHECKPOINT_END}`,
  );
  assert.match(checkpoint.context, /rows 0-19 reviewed/);
  assert.match(checkpoint.context, /review rows 20-32/);
  assert.match(checkpoint.context, /Continue the same task from this checkpoint/);
  assert.match(checkpoint.context, /You may reread a specific fact when you judge its evidence missing or conflicting/);
  assert.match(checkpoint.context, /does not restrict tool choice in this Turn/);
  assert.match(checkpoint.context, /choose any currently provided tool/);
  assert.match(checkpoint.context, /does not require reuse/);
  assert.doesNotMatch(checkpoint.context, /production-agent-checkpoint/);
  assert.ok(checkpoint.context.length <= context.MAX_COMPACTED_AGENT_CONTEXT_CHARS);
});

test("checkpoint technical validation rejects incomplete, empty, length-limited and oversized output", () => {
  assert.throws(
    () => context.parseProductionAgentCheckpoint(`${context.AGENT_CHECKPOINT_START}\nincomplete`),
    /markers are incomplete/,
  );
  assert.throws(
    () =>
      context.parseProductionAgentCheckpoint(
        `${context.AGENT_CHECKPOINT_START}\n\n${context.AGENT_CHECKPOINT_END}`,
      ),
    /checkpoint is empty/,
  );
  assert.throws(
    () =>
      context.parseProductionAgentCheckpoint(
        `${context.AGENT_CHECKPOINT_START}\nstate\n${context.AGENT_CHECKPOINT_END}`,
        "length",
      ),
    /length limit/,
  );
  assert.throws(
    () =>
      context.parseProductionAgentCheckpoint(
        `${context.AGENT_CHECKPOINT_START}\n${"x".repeat(context.MAX_COMPACTED_AGENT_CONTEXT_CHARS)}\n${context.AGENT_CHECKPOINT_END}`,
      ),
    /checkpoint exceeded/,
  );
});
