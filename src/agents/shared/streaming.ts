import { createLogger } from "@/logger";

export const AGENT_STREAM_IDLE_TIMEOUT_MS = Number(process.env.AGENT_STREAM_IDLE_TIMEOUT_MS || 5 * 60 * 1000);
export const AGENT_STREAM_MAX_DURATION_MS = Number(process.env.AGENT_STREAM_MAX_DURATION_MS || 30 * 60 * 1000);
export const AGENT_STREAM_MAX_TOOL_INPUT_BYTES = Number(process.env.AGENT_STREAM_MAX_TOOL_INPUT_BYTES || 2 * 1024 * 1024);
export const AGENT_STREAM_LIMIT_MESSAGE =
  "AI tool input exceeded the safety limit. The current agent run has been stopped; split the task or reduce one-shot output size.";
export const AGENT_STREAM_IDLE_TIMEOUT_MESSAGE =
  "AI 请求超过 5 分钟没有新活动，已停止本次任务。请检查模型服务或重试。";
export const AGENT_STREAM_MAX_DURATION_MESSAGE =
  "AI 请求超过 30 分钟绝对时限，已停止本次任务。请缩小任务范围或重试。";

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
  maxDurationMs?: number;
  maxToolInputBytes?: number;
  projectId?: number | string;
  scriptId?: number | string;
  completion?: Promise<AgentModelCompletion | null>;
  onToolStarted?: (input: { toolCallId: string | null; toolName: string | null }) => void | Promise<void>;
  onToolFinished?: (input: {
    toolCallId: string | null;
    toolName: string | null;
    success: boolean;
  }) => void | Promise<void>;
  onToolResultObserved?: (input: {
    toolCallId: string | null;
    toolName: string | null;
    success: boolean;
  }) => void;
};

export type AgentModelCompletion = {
  finishReason?: unknown;
  usage?: {
    inputTokens?: unknown;
    outputTokens?: unknown;
    totalTokens?: unknown;
  } | null;
};

export type AgentToolResult = {
  toolCallId: string | null;
  toolName: string | null;
  success: boolean;
  result: unknown;
};

export type AgentTurnResult = {
  text: string;
  state: "finished" | "interrupted" | "aborted" | "failed";
  finishReason: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
  toolCalls: Array<{ toolCallId: string | null; toolName: string | null }>;
  toolResults: AgentToolResult[];
};

export type AgentModelStreamScope = {
  signal: AbortSignal;
  abort(): void;
  dispose(): void;
};

export class AgentStreamIdleTimeoutError extends Error {
  readonly phase: AgentStreamPhase | "model_initializing";
  readonly activeTools: string[];
  readonly timeoutMs: number | null;

  constructor(
    message = AGENT_STREAM_IDLE_TIMEOUT_MESSAGE,
    input: {
      phase?: AgentStreamPhase | "model_initializing";
      activeTools?: string[];
      timeoutMs?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "AgentStreamIdleTimeoutError";
    this.phase = input.phase || "model-streaming";
    this.activeTools = input.activeTools || [];
    this.timeoutMs = input.timeoutMs ?? null;
  }
}

export class AgentStreamMaxDurationError extends Error {
  readonly phase: AgentStreamPhase | "model_initializing";
  readonly activeTools: string[];
  readonly timeoutMs: number | null;

  constructor(
    message = AGENT_STREAM_MAX_DURATION_MESSAGE,
    input: {
      phase?: AgentStreamPhase | "model_initializing";
      activeTools?: string[];
      timeoutMs?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "AgentStreamMaxDurationError";
    this.phase = input.phase || "model-streaming";
    this.activeTools = input.activeTools || [];
    this.timeoutMs = input.timeoutMs ?? null;
  }
}

export class AgentStreamLimitError extends Error {
  constructor(message = AGENT_STREAM_LIMIT_MESSAGE) {
    super(message);
    this.name = "AgentStreamLimitError";
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
    maxDurationMs: number;
    elapsedMs: number;
    idleTimeoutError: () => AgentStreamIdleTimeoutError;
    maxDurationError: () => AgentStreamMaxDurationError;
    markIdleTimeout: () => void;
    markMaxDuration: () => void;
  },
): Promise<IteratorResult<T>> {
  if (options.userAbortSignal?.aborted) throw new AgentStreamAbortError();

  let timer: NodeJS.Timeout | undefined;
  let maxDurationTimer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  const races: Promise<IteratorResult<T>>[] = [iterator.next()];

  races.push(
    new Promise<IteratorResult<T>>((_resolve, reject) => {
      timer = setTimeout(() => {
        options.markIdleTimeout();
        try {
          options.abortModelStream?.();
        } catch {
          // The timeout error remains authoritative if abort cleanup fails.
        }
        reject(options.idleTimeoutError());
      }, options.idleTimeoutMs);
    }),
  );

  const remainingDurationMs = Math.max(0, options.maxDurationMs - options.elapsedMs);
  races.push(
    new Promise<IteratorResult<T>>((_resolve, reject) => {
      maxDurationTimer = setTimeout(() => {
        options.markMaxDuration();
        try {
          options.abortModelStream?.();
        } catch {
          // The timeout error remains authoritative if abort cleanup fails.
        }
        reject(options.maxDurationError());
      }, remainingDurationMs);
    }),
  );

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
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    if (abortHandler) options.userAbortSignal?.removeEventListener("abort", abortHandler);
  }
}

function finiteToken(value: unknown) {
  const token = Number(value);
  return Number.isFinite(token) && token >= 0 ? token : null;
}

function turnResult(input: {
  text: string;
  state: AgentTurnResult["state"];
  completion?: AgentModelCompletion | null;
  toolCalls: AgentTurnResult["toolCalls"];
  toolResults: AgentToolResult[];
}): AgentTurnResult {
  const usage = input.completion?.usage;
  return {
    text: input.text,
    state: input.state,
    finishReason:
      typeof input.completion?.finishReason === "string"
        ? input.completion.finishReason
        : input.state === "finished"
          ? "unknown"
          : input.state,
    usage: {
      inputTokens: finiteToken(usage?.inputTokens),
      outputTokens: finiteToken(usage?.outputTokens),
      totalTokens: finiteToken(usage?.totalTokens),
    },
    toolCalls: input.toolCalls,
    toolResults: input.toolResults,
  };
}

function attachTurnResult(error: unknown, result: AgentTurnResult) {
  if (error && typeof error === "object") {
    Object.defineProperty(error, "agentTurnResult", { value: result, configurable: true });
  }
}

export function agentTurnResultFromError(error: unknown): AgentTurnResult | null {
  const result = (error as { agentTurnResult?: unknown } | null)?.agentTurnResult;
  if (!result || typeof result !== "object") return null;
  return result as AgentTurnResult;
}

export async function consumeAgentTurn(options: ConsumeFullStreamOptions): Promise<AgentTurnResult> {
  const idleTimeoutMs = options.idleTimeoutMs ?? AGENT_STREAM_IDLE_TIMEOUT_MS;
  const maxDurationMs = options.maxDurationMs ?? AGENT_STREAM_MAX_DURATION_MS;
  const maxToolInputBytes = options.maxToolInputBytes ?? AGENT_STREAM_MAX_TOOL_INPUT_BYTES;
  const iterator = options.fullStream[Symbol.asyncIterator]();
  const activeToolCallIds = new Set<string>();
  const activeToolNames = new Map<string, string>();
  let phase: AgentStreamPhase = "model-streaming";
  let idleTimeoutTriggered = false;
  let maxDurationTriggered = false;
  let msg = options.initialMsg;
  let text = msg.text();
  let thinking: ThinkingStreamLike | null = null;
  let thinkTime = 0;
  let fullResponse = "";
  let chunkCount = 0;
  let toolInputChunkCount = 0;
  let toolInputBytes = 0;
  const toolCalls: AgentTurnResult["toolCalls"] = [];
  const toolResults: AgentToolResult[] = [];
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
        maxDurationMs,
        elapsedMs: Date.now() - startedAt,
        idleTimeoutError: () =>
          new AgentStreamIdleTimeoutError(AGENT_STREAM_IDLE_TIMEOUT_MESSAGE, {
            phase,
            activeTools: [...activeToolNames.values()],
            timeoutMs: idleTimeoutMs,
          }),
        maxDurationError: () =>
          new AgentStreamMaxDurationError(AGENT_STREAM_MAX_DURATION_MESSAGE, {
            phase,
            activeTools: [...activeToolNames.values()],
            timeoutMs: maxDurationMs,
          }),
        markIdleTimeout: () => {
          idleTimeoutTriggered = true;
        },
        markMaxDuration: () => {
          maxDurationTriggered = true;
        },
      });
      if (result.done) break;

      const chunk = result.value;
      chunkCount += 1;
      if (chunk?.type === "tool-input-delta") {
        toolInputChunkCount += 1;
        const delta = chunk?.text ?? chunk?.delta ?? chunk?.argsTextDelta ?? "";
        toolInputBytes += Buffer.byteLength(typeof delta === "string" ? delta : JSON.stringify(delta), "utf8");
        if (toolInputBytes > maxToolInputBytes) {
          options.abortModelStream?.();
          throw new AgentStreamLimitError();
        }
      }
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
        if (toolCallId) activeToolNames.set(toolCallId, getToolName(chunk) ?? "unknown");
        toolCalls.push({ toolCallId: toolCallId ?? null, toolName: getToolName(chunk) ?? null });
        setPhase("tool-running", chunk);
        void Promise.resolve(
          options.onToolStarted?.({ toolCallId: toolCallId ?? null, toolName: getToolName(chunk) ?? null }),
        ).catch((error) => {
          log.warn("Failed to record agent tool start", { event: "agent.tool-start.record-failed", ...logContext, error });
        });
      } else if (
        chunk.type === "tool-result" ||
        chunk.type === "tool-error" ||
        chunk.type === "tool-output-denied"
      ) {
        const toolCallId = getToolCallId(chunk);
        if (toolCallId) activeToolCallIds.delete(toolCallId);
        if (toolCallId) activeToolNames.delete(toolCallId);
        toolResults.push({
          toolCallId: toolCallId ?? null,
          toolName: getToolName(chunk) ?? null,
          success: chunk.type === "tool-result",
          result: chunk?.output ?? chunk?.result ?? chunk?.error ?? null,
        });
        void Promise.resolve(
          options.onToolFinished?.({
            toolCallId: toolCallId ?? null,
            toolName: getToolName(chunk) ?? null,
            success: chunk.type === "tool-result",
          }),
        ).catch((error) => {
          log.warn("Failed to record agent tool finish", { event: "agent.tool-finish.record-failed", ...logContext, error });
        });
        try {
          options.onToolResultObserved?.({
            toolCallId: toolCallId ?? null,
            toolName: getToolName(chunk) ?? null,
            success: chunk.type === "tool-result",
          });
        } catch (error) {
          log.warn("Failed to handle observed agent tool result", {
            event: "agent.tool-result.observer-failed",
            ...logContext,
            error,
          });
        }
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

    if (err instanceof AgentStreamLimitError) {
      Promise.resolve(iterator.return?.()).catch(() => undefined);
      text.append(err.message);
      text.error();
      msg.error(err.message);
      log.warn("Agent stream safety limit reached", {
        event: "agent.stream.limit",
        ...logContext,
        phase,
        activeToolCount: activeToolCallIds.size,
        chunkCount,
        toolInputChunkCount,
        toolInputBytes,
        durationMs: Date.now() - startedAt,
      });
      attachTurnResult(
        err,
        turnResult({ text: fullResponse, state: "interrupted", completion: { finishReason: "limit" }, toolCalls, toolResults }),
      );
      throw err;
    }

    if (
      err instanceof AgentStreamIdleTimeoutError ||
      err instanceof AgentStreamMaxDurationError ||
      ((idleTimeoutTriggered || maxDurationTriggered) && isAbortError(err) && !options.userAbortSignal?.aborted)
    ) {
      const timeoutError =
        err instanceof AgentStreamIdleTimeoutError || err instanceof AgentStreamMaxDurationError
          ? err
          : maxDurationTriggered
            ? new AgentStreamMaxDurationError(AGENT_STREAM_MAX_DURATION_MESSAGE, {
                phase,
                activeTools: [...activeToolNames.values()],
                timeoutMs: maxDurationMs,
              })
            : new AgentStreamIdleTimeoutError(AGENT_STREAM_IDLE_TIMEOUT_MESSAGE, {
                phase,
                activeTools: [...activeToolNames.values()],
                timeoutMs: idleTimeoutMs,
              });
      Promise.resolve(iterator.return?.()).catch(() => undefined);
      text.append(timeoutError.message);
      text.error();
      msg.error(timeoutError.message);
      const finishReason = timeoutError instanceof AgentStreamMaxDurationError ? "max-duration" : "idle-timeout";
      log.warn("Agent stream timeout", {
        event: `agent.stream.${finishReason}`,
        ...logContext,
        phase,
        activeTools: [...activeToolNames.values()],
        activeToolCount: activeToolCallIds.size,
        chunkCount,
        durationMs: Date.now() - startedAt,
      });
      attachTurnResult(
        timeoutError,
        turnResult({
          text: fullResponse,
          state: "interrupted",
          completion: { finishReason },
          toolCalls,
          toolResults,
        }),
      );
      throw timeoutError;
    }

    if (isAbortError(err) || options.userAbortSignal?.aborted) {
      Promise.resolve(iterator.return?.()).catch(() => undefined);
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
      attachTurnResult(
        err,
        turnResult({ text: fullResponse, state: "aborted", completion: { finishReason: "abort" }, toolCalls, toolResults }),
      );
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
    attachTurnResult(
      err,
      turnResult({ text: fullResponse, state: "failed", completion: { finishReason: "error" }, toolCalls, toolResults }),
    );
    throw err;
  }

  const completion = options.completion ? await options.completion.catch(() => null) : null;
  return turnResult({ text: fullResponse, state: "finished", completion, toolCalls, toolResults });
}

/**
 * Compatibility wrapper for agents that have not migrated to the structured
 * Production Agent turn loop yet.
 */
export async function consumeFullStream(options: ConsumeFullStreamOptions): Promise<string> {
  return (await consumeAgentTurn(options)).text;
}
