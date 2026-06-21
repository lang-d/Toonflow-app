import { createLogger } from "@/logger";

export const AGENT_STREAM_IDLE_TIMEOUT_MS = Number(process.env.AGENT_STREAM_IDLE_TIMEOUT_MS || 120000);
export const AGENT_STREAM_IDLE_TIMEOUT_MESSAGE =
  "AI 输出超过 120 秒没有新内容，已自动结束本次任务，请检查模型服务或重试。";

const log = createLogger("agent-stream");

type TextStreamLike = {
  append(text: string): unknown;
  complete(finalData?: string): unknown;
  error(): unknown;
};

type ThinkingStreamLike = {
  append?(text: string): unknown;
  appendText?(text: string): unknown;
  updateTitle?(title: string): unknown;
  complete(finalData?: unknown): unknown;
};

export type AgentMessageLike = {
  id?: string;
  datetime?: string;
  text(): TextStreamLike;
  thinking(title?: string): ThinkingStreamLike;
  complete(): unknown;
  stop(): unknown;
  error(errorMsg?: string): unknown;
};

export type AgentStreamPhase = "model-streaming" | "tool-running";

export type ConsumeFullStreamOptions = {
  agentName: string;
  fullStream: AsyncIterable<any>;
  initialMsg: AgentMessageLike;
  syncMsg?: () => AgentMessageLike;
  userAbortSignal?: AbortSignal;
  abortModelStream?: () => void;
  idleTimeoutMs?: number;
  projectId?: number | string;
  scriptId?: number | string;
};

export type AgentModelStreamScope = {
  signal: AbortSignal;
  abort(): void;
  dispose(): void;
};

export class AgentStreamIdleTimeoutError extends Error {
  constructor(message = AGENT_STREAM_IDLE_TIMEOUT_MESSAGE) {
    super(message);
    this.name = "AgentStreamIdleTimeoutError";
  }
}

class AgentStreamAbortError extends Error {
  constructor() {
    super("Agent stream aborted");
    this.name = "AbortError";
  }
}

export function createAgentModelStreamScope(userAbortSignal?: AbortSignal): AgentModelStreamScope {
  const controller = new AbortController();
  const abortFromUser = () => controller.abort(userAbortSignal?.reason);

  if (userAbortSignal?.aborted) {
    abortFromUser();
  } else {
    userAbortSignal?.addEventListener("abort", abortFromUser, { once: true });
  }

  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    dispose: () => userAbortSignal?.removeEventListener("abort", abortFromUser),
  };
}

function isAbortError(error: unknown) {
  const err = error as { name?: string; code?: string } | undefined;
  return err?.name === "AbortError" || err?.code === "ABORT_ERR";
}

function appendThinking(thinking: ThinkingStreamLike | null, text: string) {
  if (!thinking || !text) return;
  if (typeof thinking.appendText === "function") thinking.appendText(text);
  else thinking.append?.(text);
}

function getToolCallId(chunk: any): string | undefined {
  return chunk?.toolCallId ?? chunk?.toolCall?.toolCallId;
}

function getToolName(chunk: any): string | undefined {
  return chunk?.toolName ?? chunk?.toolCall?.toolName;
}

async function nextChunk<T>(
  iterator: AsyncIterator<T>,
  options: {
    userAbortSignal?: AbortSignal;
    abortModelStream?: () => void;
    idleTimeoutMs: number;
    useIdleTimeout: boolean;
    markIdleTimeout: () => void;
  },
): Promise<IteratorResult<T>> {
  if (options.userAbortSignal?.aborted) throw new AgentStreamAbortError();

  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  const races: Promise<IteratorResult<T>>[] = [iterator.next()];

  if (options.useIdleTimeout) {
    races.push(
      new Promise<IteratorResult<T>>((_resolve, reject) => {
        timer = setTimeout(() => {
          options.markIdleTimeout();
          try {
            options.abortModelStream?.();
          } catch {
            // The timeout error remains authoritative if abort cleanup fails.
          }
          reject(new AgentStreamIdleTimeoutError());
        }, options.idleTimeoutMs);
      }),
    );
  }

  if (options.userAbortSignal) {
    races.push(
      new Promise<IteratorResult<T>>((_resolve, reject) => {
        abortHandler = () => reject(new AgentStreamAbortError());
        options.userAbortSignal?.addEventListener("abort", abortHandler, { once: true });
      }),
    );
  }

  try {
    return await Promise.race(races);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortHandler) options.userAbortSignal?.removeEventListener("abort", abortHandler);
  }
}

export async function consumeFullStream(options: ConsumeFullStreamOptions): Promise<string> {
  const idleTimeoutMs = options.idleTimeoutMs ?? AGENT_STREAM_IDLE_TIMEOUT_MS;
  const iterator = options.fullStream[Symbol.asyncIterator]();
  const activeToolCallIds = new Set<string>();
  let phase: AgentStreamPhase = "model-streaming";
  let idleTimeoutTriggered = false;
  let msg = options.initialMsg;
  let text = msg.text();
  let thinking: ThinkingStreamLike | null = null;
  let thinkTime = 0;
  let fullResponse = "";
  let chunkCount = 0;
  const startedAt = Date.now();

  const logContext = {
    agentName: options.agentName,
    projectId: options.projectId,
    scriptId: options.scriptId,
  };

  const setPhase = (nextPhase: AgentStreamPhase, chunk: any) => {
    if (nextPhase === phase) return;
    const previousPhase = phase;
    phase = nextPhase;
    log.info("Agent stream phase changed", {
      event: "agent.stream.phase",
      ...logContext,
      previousPhase,
      phase,
      toolName: getToolName(chunk),
      activeToolCount: activeToolCallIds.size,
      durationMs: Date.now() - startedAt,
    });
  };

  log.info("Agent stream started", {
    event: "agent.stream.start",
    ...logContext,
    idleTimeoutMs,
  });

  try {
    while (true) {
      const result = await nextChunk(iterator, {
        userAbortSignal: options.userAbortSignal,
        abortModelStream: options.abortModelStream,
        idleTimeoutMs,
        useIdleTimeout: phase === "model-streaming",
        markIdleTimeout: () => {
          idleTimeoutTriggered = true;
        },
      });
      if (result.done) break;

      const chunk = result.value;
      chunkCount += 1;
      if (chunkCount === 1 || chunkCount % 50 === 0 || chunk?.type === "error") {
        log.debug("Agent stream chunk", {
          event: "agent.stream.chunk",
          ...logContext,
          phase,
          chunkType: chunk?.type,
          chunkCount,
          durationMs: Date.now() - startedAt,
        });
      }

      if (options.syncMsg) {
        const newMsg = options.syncMsg();
        if (newMsg !== msg) {
          msg = newMsg;
          text = msg.text();
        }
      }

      if (chunk.type === "tool-call") {
        const toolCallId = getToolCallId(chunk);
        if (toolCallId) activeToolCallIds.add(toolCallId);
        setPhase("tool-running", chunk);
      } else if (
        chunk.type === "tool-result" ||
        chunk.type === "tool-error" ||
        chunk.type === "tool-output-denied"
      ) {
        const toolCallId = getToolCallId(chunk);
        if (toolCallId) activeToolCallIds.delete(toolCallId);
        if (activeToolCallIds.size === 0) setPhase("model-streaming", chunk);
      }

      if (chunk.type === "reasoning-start") {
        thinkTime = Date.now();
        thinking = msg.thinking("思考中...");
      } else if (chunk.type === "reasoning-delta") {
        appendThinking(thinking, chunk.text);
      } else if (chunk.type === "reasoning-end") {
        const elapsed = ((Date.now() - thinkTime) / 1000).toFixed(1);
        thinking?.updateTitle?.(`思考完毕（${elapsed} 秒）`);
        thinking?.complete();
        thinking = null;
      } else if (chunk.type === "text-delta") {
        text.append(chunk.text);
        fullResponse += chunk.text;
      } else if (chunk.type === "error") {
        throw chunk.error;
      }
    }

    text.complete();
    msg.complete();
    log.info("Agent stream finished", {
      event: "agent.stream.finish",
      ...logContext,
      phase,
      activeToolCount: activeToolCallIds.size,
      chunkCount,
      durationMs: Date.now() - startedAt,
    });
  } catch (err: any) {
    thinking?.complete();

    if (
      err instanceof AgentStreamIdleTimeoutError ||
      (idleTimeoutTriggered && isAbortError(err) && !options.userAbortSignal?.aborted)
    ) {
      const timeoutError =
        err instanceof AgentStreamIdleTimeoutError ? err : new AgentStreamIdleTimeoutError();
      Promise.resolve(iterator.return?.()).catch(() => undefined);
      text.append(timeoutError.message);
      text.error();
      msg.error(timeoutError.message);
      log.warn("Agent stream idle timeout", {
        event: "agent.stream.idle-timeout",
        ...logContext,
        phase,
        activeToolCount: activeToolCallIds.size,
        chunkCount,
        durationMs: Date.now() - startedAt,
      });
      throw timeoutError;
    }

    if (isAbortError(err) || options.userAbortSignal?.aborted) {
      text.complete();
      msg.stop();
      log.info("Agent stream aborted", {
        event: "agent.stream.abort",
        ...logContext,
        phase,
        activeToolCount: activeToolCallIds.size,
        chunkCount,
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }

    const errMsg = err?.message ?? String(err);
    text.append(errMsg);
    text.error();
    msg.error(errMsg);
    log.error("Agent stream failed", {
      event: "agent.stream.error",
      ...logContext,
      phase,
      activeToolCount: activeToolCallIds.size,
      chunkCount,
      durationMs: Date.now() - startedAt,
      error: err,
    });
    throw err;
  }

  return fullResponse;
}
