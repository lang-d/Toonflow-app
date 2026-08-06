import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_STREAM_IDLE_TIMEOUT_MS,
  AgentStreamIdleTimeoutError,
  AgentStreamLimitError,
  agentTurnResultFromError,
  consumeAgentTurn,
  consumeFullStream,
  createAgentModelStreamScope,
} from "../src/agents/shared/streaming";

test("agent stream default idle timeout is five minutes", () => {
  assert.equal(AGENT_STREAM_IDLE_TIMEOUT_MS, 5 * 60 * 1000);
});

class FakeTextStream {
  data = "";
  status = "pending";

  append(text: string) {
    this.data += text;
    this.status = "streaming";
  }

  complete() {
    this.status = "complete";
  }

  error() {
    this.status = "error";
  }
}

class FakeThinkingStream {
  text = "";
  title = "";
  status = "pending";

  append(text: string) {
    this.text += text;
    this.status = "streaming";
  }

  appendText(text: string) {
    this.append(text);
  }

  updateTitle(title: string) {
    this.title = title;
    this.status = "streaming";
  }

  complete() {
    this.status = "complete";
  }
}

class FakeMessage {
  textStream = new FakeTextStream();
  thinkingStream: FakeThinkingStream | null = null;
  status = "pending";
  errorMessage = "";
  datetime = new Date().toISOString();

  text() {
    return this.textStream;
  }

  thinking(title = "") {
    this.thinkingStream = new FakeThinkingStream();
    this.thinkingStream.title = title;
    return this.thinkingStream;
  }

  complete() {
    this.status = "complete";
  }

  stop() {
    this.status = "stop";
  }

  error(errorMsg?: string) {
    this.status = "error";
    this.errorMessage = errorMsg || "";
  }
}

async function* streamChunks(chunks: any[]) {
  for (const chunk of chunks) yield chunk;
}

async function* delayedChunks(chunks: any[], delayMs: number) {
  for (const chunk of chunks) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield chunk;
  }
}

function hangingAfterFirstChunk() {
  return {
    [Symbol.asyncIterator]() {
      let count = 0;
      return {
        next() {
          count += 1;
          if (count === 1) {
            return Promise.resolve({
              done: false,
              value: { type: "text-delta", text: "partial" },
            });
          }
          return new Promise<IteratorResult<any>>(() => undefined);
        },
        return() {
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  } as AsyncIterable<any>;
}

test("agent stream completes normal reasoning and text chunks", async () => {
  const msg = new FakeMessage();
  const response = await consumeFullStream({
    agentName: "testAgent",
    fullStream: streamChunks([
      { type: "reasoning-start" },
      { type: "reasoning-delta", text: "thinking" },
      { type: "reasoning-end" },
      { type: "text-delta", text: "hello" },
    ]),
    initialMsg: msg,
    idleTimeoutMs: 1000,
  });

  assert.equal(response, "hello");
  assert.equal(msg.status, "complete");
  assert.equal(msg.textStream.status, "complete");
  assert.equal(msg.textStream.data, "hello");
  assert.equal(msg.thinkingStream?.status, "complete");
});

test("structured agent turn preserves finish reason, usage, and objective tool results", async () => {
  const msg = new FakeMessage();
  const result = await consumeAgentTurn({
    agentName: "testAgent",
    fullStream: streamChunks([
      { type: "tool-call", toolCallId: "call-1", toolName: "readFacts" },
      { type: "tool-result", toolCallId: "call-1", toolName: "readFacts", output: { ok: true } },
      { type: "text-delta", text: "done" },
    ]),
    completion: Promise.resolve({
      finishReason: "length",
      usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
    }),
    initialMsg: msg,
    idleTimeoutMs: 1000,
  });

  assert.equal(result.text, "done");
  assert.equal(result.finishReason, "length");
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 40, totalTokens: 160 });
  assert.deepEqual(result.toolCalls, [{ toolCallId: "call-1", toolName: "readFacts" }]);
  assert.deepEqual(result.toolResults, [
    { toolCallId: "call-1", toolName: "readFacts", success: true, result: { ok: true } },
  ]);
});

test("agent stream idle timeout visibly errors and only aborts the model stream", async () => {
  const msg = new FakeMessage();
  const userController = new AbortController();
  let modelAborted = false;

  let captured: unknown;
  await assert.rejects(
    consumeAgentTurn({
      agentName: "testAgent",
      fullStream: hangingAfterFirstChunk(),
      initialMsg: msg,
      idleTimeoutMs: 10,
      userAbortSignal: userController.signal,
      abortModelStream: () => {
        modelAborted = true;
      },
    }).catch((error) => {
      captured = error;
      throw error;
    }),
    AgentStreamIdleTimeoutError,
  );

  const interrupted = agentTurnResultFromError(captured);
  assert.equal(interrupted?.state, "interrupted");
  assert.equal(interrupted?.finishReason, "idle-timeout");
  assert.equal(interrupted?.text, "partial");
  assert.equal(modelAborted, true);
  assert.equal(userController.signal.aborted, false);
  assert.equal(msg.status, "error");
  assert.equal(msg.textStream.status, "error");
  assert.match(msg.textStream.data, /AI 输出超过 5 分钟没有新内容/);
});

test("agent stream chunk error is surfaced to the message", async () => {
  const msg = new FakeMessage();

  await assert.rejects(
    consumeFullStream({
      agentName: "testAgent",
      fullStream: streamChunks([{ type: "error", error: new Error("provider failed") }]),
      initialMsg: msg,
      idleTimeoutMs: 1000,
    }),
    /provider failed/,
  );

  assert.equal(msg.status, "error");
  assert.equal(msg.errorMessage, "provider failed");
  assert.equal(msg.textStream.status, "error");
  assert.equal(msg.textStream.data, "provider failed");
});

test("agent stream user abort stops without idle timeout text", async () => {
  const msg = new FakeMessage();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    consumeFullStream({
      agentName: "testAgent",
      fullStream: hangingAfterFirstChunk(),
      initialMsg: msg,
      userAbortSignal: controller.signal,
      idleTimeoutMs: 1000,
    }),
    /Agent stream aborted/,
  );

  assert.equal(msg.status, "stop");
  assert.equal(msg.textStream.status, "complete");
  assert.doesNotMatch(msg.textStream.data, /AI 输出超过/);
});

test("tool input chunks keep the model stream active", async () => {
  const msg = new FakeMessage();
  const response = await consumeFullStream({
    agentName: "testAgent",
    fullStream: delayedChunks(
      [
        { type: "tool-input-start", id: "call-1", toolName: "childAgent" },
        { type: "tool-input-delta", id: "call-1", delta: "a" },
        { type: "tool-input-delta", id: "call-1", delta: "b" },
        { type: "tool-input-end", id: "call-1" },
        { type: "text-delta", text: "done" },
      ],
      25,
    ),
    initialMsg: msg,
    idleTimeoutMs: 80,
  });

  assert.equal(response, "done");
  assert.equal(msg.status, "complete");
});

test("many small tool input chunks do not trigger a chunk-count limit", async () => {
  const msg = new FakeMessage();

  async function* manySmallToolInputChunks() {
    yield { type: "tool-input-start", id: "call-1", toolName: "childAgent" };
    for (let index = 0; index < 20_000; index += 1) {
      yield { type: "tool-input-delta", id: "call-1", delta: "a" };
    }
    yield { type: "tool-input-end", id: "call-1" };
    yield { type: "text-delta", text: "done" };
  }

  const response = await consumeFullStream({
    agentName: "testAgent",
    fullStream: manySmallToolInputChunks(),
    initialMsg: msg,
    idleTimeoutMs: 1000,
  });

  assert.equal(response, "done");
  assert.equal(msg.status, "complete");
});

test("tool input byte limit still aborts oversized input", async () => {
  const msg = new FakeMessage();
  let modelAborted = false;

  await assert.rejects(
    consumeFullStream({
      agentName: "testAgent",
      fullStream: streamChunks([
        { type: "tool-input-start", id: "call-1", toolName: "childAgent" },
        { type: "tool-input-delta", id: "call-1", delta: "ab" },
        { type: "tool-input-delta", id: "call-1", delta: "cd" },
      ]),
      initialMsg: msg,
      idleTimeoutMs: 1000,
      maxToolInputBytes: 3,
      abortModelStream: () => {
        modelAborted = true;
      },
    }),
    AgentStreamLimitError,
  );

  assert.equal(modelAborted, true);
  assert.equal(msg.status, "error");
});

test("tool execution suspends model idle timeout until its result arrives", async () => {
  const msg = new FakeMessage();

  async function* slowTool() {
    yield { type: "tool-call", toolCallId: "call-1", toolName: "childAgent" };
    await new Promise((resolve) => setTimeout(resolve, 120));
    yield { type: "tool-result", toolCallId: "call-1", toolName: "childAgent", output: "ok" };
    yield { type: "text-delta", text: "finished" };
  }

  const response = await consumeFullStream({
    agentName: "testAgent",
    fullStream: slowTool(),
    initialMsg: msg,
    idleTimeoutMs: 50,
  });

  assert.equal(response, "finished");
  assert.equal(msg.status, "complete");
});

test("model idle timeout resumes after the last tool result", async () => {
  const msg = new FakeMessage();
  let modelAborted = false;

  async function* resultThenHang() {
    yield { type: "tool-call", toolCallId: "call-1", toolName: "childAgent" };
    await new Promise((resolve) => setTimeout(resolve, 60));
    yield { type: "tool-result", toolCallId: "call-1", toolName: "childAgent", output: "ok" };
    await new Promise(() => undefined);
  }

  await assert.rejects(
    consumeFullStream({
      agentName: "testAgent",
      fullStream: resultThenHang(),
      initialMsg: msg,
      idleTimeoutMs: 30,
      abortModelStream: () => {
        modelAborted = true;
      },
    }),
    AgentStreamIdleTimeoutError,
  );

  assert.equal(modelAborted, true);
  assert.equal(msg.status, "error");
});

test("parallel tools keep idle timeout suspended until every result arrives", async () => {
  const msg = new FakeMessage();

  async function* parallelTools() {
    yield { type: "tool-call", toolCallId: "call-1", toolName: "firstTool" };
    yield { type: "tool-call", toolCallId: "call-2", toolName: "secondTool" };
    yield { type: "tool-result", toolCallId: "call-1", toolName: "firstTool", output: "first" };
    await new Promise((resolve) => setTimeout(resolve, 120));
    yield { type: "tool-result", toolCallId: "call-2", toolName: "secondTool", output: "second" };
    yield { type: "text-delta", text: "all done" };
  }

  const response = await consumeFullStream({
    agentName: "testAgent",
    fullStream: parallelTools(),
    initialMsg: msg,
    idleTimeoutMs: 50,
  });

  assert.equal(response, "all done");
  assert.equal(msg.status, "complete");
});

test("model stream abort scope does not abort the root user signal", () => {
  const userController = new AbortController();
  const modelScope = createAgentModelStreamScope(userController.signal);

  modelScope.abort();

  assert.equal(modelScope.signal.aborted, true);
  assert.equal(userController.signal.aborted, false);
  modelScope.dispose();
});

test("root user abort propagates to the model stream scope", () => {
  const userController = new AbortController();
  const modelScope = createAgentModelStreamScope(userController.signal);

  userController.abort();

  assert.equal(modelScope.signal.aborted, true);
  modelScope.dispose();
});
