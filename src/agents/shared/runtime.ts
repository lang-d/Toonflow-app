import u from "@/utils";
import {
  AGENT_STREAM_IDLE_TIMEOUT_MESSAGE,
  AGENT_STREAM_IDLE_TIMEOUT_MS,
  AGENT_STREAM_MAX_DURATION_MESSAGE,
  AGENT_STREAM_MAX_DURATION_MS,
  AgentStreamIdleTimeoutError,
  AgentStreamMaxDurationError,
  agentTurnResultFromError,
  consumeAgentTurn,
  createAgentModelStreamScope,
  type AgentModelCompletion,
  type AgentTurnResult,
} from "@/agents/shared/streaming";
import {
  recordAgentModelStreamFinished,
  recordAgentRunEvent,
  recordAgentTurnResult,
  recordAgentTurnStarted,
  type AgentRunContext,
} from "@/services/agentRun";
import {
  advanceConsecutiveLengthTurns,
  boundAgentTurnToolResults,
  compactProductionAgentContextIfNeeded,
  continueProductionAgentContext,
  createProductionAgentTurnInputGuard,
  isContextWindowOverflowError,
} from "@/services/agentContextCompaction";

export type SharedAgentRuntimeInput = {
  agentName: string;
  agentLabel: string;
  modelKey: Parameters<typeof u.Ai.Text>[0];
  stableInstructions: string;
  objective: string;
  initialContext: string;
  fixedContext?: string;
  stage: string;
  subAgent: string;
  projectId: number;
  scriptId?: number | null;
  think?: boolean;
  thinkLevel?: 0 | 1 | 2 | 3;
  abortSignal?: AbortSignal;
  runContext?: AgentRunContext;
  message: {
    get(): any;
    set(message: any): void;
    create(): any;
  };
  buildTools(): Promise<Record<string, any>> | Record<string, any>;
  archiveFailure?: (content: string) => Promise<number | undefined>;
  onRepeatedContextOverflow?: () => void;
  requireTerminalIntent?: boolean;
  onTurnStarted?: (input: { turnNumber: number; messageId: string | number | null }) => void | Promise<void>;
  onTurnFinished?: (input: { turnNumber: number; turn: AgentTurnResult }) => void | Promise<void>;
  maxInactiveTurns?: number;
  maxConsecutiveLengthTurns?: number;
  turnIdleTimeoutMs?: number;
  turnMaxDurationMs?: number;
  terminalCorrection?: {
    buildTools(): Promise<Record<string, any>> | Record<string, any>;
    maxAttempts?: number;
  };
};

export type SharedAgentRuntimeResult = {
  lastTurn: AgentTurnResult | null;
  transcript: string[];
  toolResults: AgentTurnResult["toolResults"];
  interruptionCount: number;
};

function completionLatch() {
  let resolve!: (value: AgentModelCompletion | null) => void;
  const promise = new Promise<AgentModelCompletion | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function isAbortError(error: unknown) {
  const candidate = error as { name?: unknown; code?: unknown } | null;
  return candidate?.name === "AbortError" || candidate?.code === "ABORT_ERR";
}

function isRetryableTransportError(error: unknown) {
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown } | null;
  const status = Number(candidate?.statusCode ?? candidate?.status);
  const code = String(candidate?.code || "").toUpperCase();
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599) ||
    ["ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "EPIPE", "UND_ERR_CONNECT_TIMEOUT"].includes(code)
  );
}

function isRecoverableTurn(turn: AgentTurnResult) {
  return turn.state === "interrupted" || ["length", "tool-calls"].includes(turn.finishReason);
}

function isTurnTimeoutError(error: unknown): error is AgentStreamIdleTimeoutError | AgentStreamMaxDurationError {
  return error instanceof AgentStreamIdleTimeoutError || error instanceof AgentStreamMaxDurationError;
}

async function awaitModelInitialization<T>(input: {
  operation: Promise<T>;
  idleTimeoutMs: number;
  maxDurationMs: number;
  abort: () => void;
}) {
  const timeoutMs = Math.min(input.idleTimeoutMs, input.maxDurationMs);
  const timeoutIsAbsolute = input.maxDurationMs <= input.idleTimeoutMs;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      input.operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          input.abort();
          reject(
            timeoutIsAbsolute
              ? new AgentStreamMaxDurationError(AGENT_STREAM_MAX_DURATION_MESSAGE, {
                  phase: "model_initializing",
                  timeoutMs,
                })
              : new AgentStreamIdleTimeoutError(AGENT_STREAM_IDLE_TIMEOUT_MESSAGE, {
                  phase: "model_initializing",
                  timeoutMs,
                }),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const TERMINAL_CORRECTION_INSTRUCTIONS = `You are closing the current Agent Chat after the prior model Turn ended without a terminal tool call. Do not continue business work, read more facts, or introduce a new proposal. Based on the prior assistant output and tool facts, call exactly one available terminal tool now. Use await_user_decision when the prior conclusion requires the user to answer a question. Use complete_agent_run only when the requested work or task submission is already complete.`;

function turnActivitySignature(turn: AgentTurnResult) {
  if (!turn.toolCalls.length && !turn.toolResults.length) return "";
  return JSON.stringify({
    calls: turn.toolCalls.map((item) => item.toolName),
    results: boundAgentTurnToolResults(turn.toolResults).items.map((item) => ({
      toolName: item.toolName,
      success: item.success,
      result: item.result,
    })),
  });
}

function resourceDeliveryStates(turn: AgentTurnResult, presentedToModel: boolean) {
  return turn.toolResults.flatMap((toolResult) => {
    if (!toolResult.success || toolResult.toolName !== "resource_access") return [];
    const result = toolResult.result as Record<string, unknown> | null;
    if (!result || typeof result.resourceRef !== "string") return [];
    return [
      {
        resourceRef: result.resourceRef,
        version: result.version ?? null,
        returnedRange: result.returnedRange ?? null,
        nextCursor: result.nextCursor ?? null,
        eof: result.eof ?? null,
        presentedToModel,
        pendingConsumption: true,
      },
    ];
  });
}

function continuationReason(input: {
  providerContextOverflow: boolean;
  contextBoundary: unknown;
  turn: AgentTurnResult;
}) {
  if (input.providerContextOverflow) return "provider_context_overflow";
  if (input.contextBoundary) return "context_budget_boundary";
  if (isRecoverableTurn(input.turn)) return "recoverable_interruption";
  return "missing_terminal_state";
}

/**
 * Provider-neutral multi-Turn runtime shared by domain Agents.
 * Domain instructions, tools and facts are supplied by the caller; this
 * function owns only technical lifecycle, continuation and diagnostics.
 */
export async function runAgentRuntime(input: SharedAgentRuntimeInput) {
  const maxInactiveTurns = input.maxInactiveTurns ?? 3;
  const maxConsecutiveLengthTurns = input.maxConsecutiveLengthTurns ?? 4;
  const fixedContext = `${input.stableInstructions}\n${input.fixedContext || ""}\n${input.objective}`;
  const prepared = await compactProductionAgentContextIfNeeded({
    runId: input.runContext?.runId,
    modelKey: input.modelKey,
    think: input.think,
    thinkLevel: input.thinkLevel,
    objective: input.objective,
    context: input.initialContext,
    fixedContext,
    stage: input.stage,
    subAgent: input.subAgent,
  });
  let workingContext = prepared.context;
  if (prepared.compacted) input.runContext?.setContextCheckpoint(prepared.context);

  let turnNumber = 0;
  let inactiveTurns = 0;
  let consecutiveLengthTurns = 0;
  let contextOverflowCount = input.runContext?.contextOverflowCount ?? 0;
  let lastActivitySignature = "";
  let lastTurn: AgentTurnResult | null = null;
  let interruptionCount = 0;
  let terminalCorrectionAttempts = 0;
  let terminalCorrectionContext = "";
  let terminalCorrectionPending = false;
  const transcript: string[] = [];
  const toolResults: AgentTurnResult["toolResults"] = [];

  while (!input.runContext?.terminalIntent) {
    turnNumber += 1;
    const terminalCorrectionTurn = terminalCorrectionPending;
    terminalCorrectionPending = false;
    const turnId = u.uuid();
    const turnMessage = input.message.get();
    const turnMessageId = turnMessage?.id ?? null;
    const turnInputGuard = await createProductionAgentTurnInputGuard({ modelKey: input.modelKey });
    const modelStreamScope = createAgentModelStreamScope(input.abortSignal);
    const completion = completionLatch();
    const previousStop = input.runContext?.requestStop;
    await input.onTurnStarted?.({ turnNumber, messageId: turnMessageId });

    if (input.runContext) {
      input.runContext.requestStop = () => modelStreamScope.abort();
      input.runContext.markStage(input.stage, input.subAgent);
      await recordAgentTurnStarted(input.runContext.runId, {
        turnId,
        turnNumber,
        messageId: turnMessageId,
        stage: input.stage,
        subAgent: input.subAgent,
        continuedFrom: turnNumber > 1 ? "previous_turn" : null,
      });
    }

    let turn: AgentTurnResult;
    let providerContextOverflow = false;
    let turnTimedOut = false;
    const turnStartedAt = Date.now();
    const turnIdleTimeoutMs = input.turnIdleTimeoutMs ?? AGENT_STREAM_IDLE_TIMEOUT_MS;
    const turnMaxDurationMs = input.turnMaxDurationMs ?? AGENT_STREAM_MAX_DURATION_MS;
    try {
      if (input.runContext) {
        await recordAgentRunEvent(input.runContext.runId, "agent_turn_phase", {
          turnId,
          turnNumber,
          messageId: turnMessageId,
          stage: input.stage,
          subAgent: input.subAgent,
          phase: "model_initializing",
          terminalCorrection: terminalCorrectionTurn,
        });
      }
      const streamResult = await awaitModelInitialization({
        idleTimeoutMs: turnIdleTimeoutMs,
        maxDurationMs: turnMaxDurationMs,
        abort: modelStreamScope.abort,
        operation: (async () => {
          const tools = terminalCorrectionTurn ? await input.terminalCorrection!.buildTools() : await input.buildTools();
          const stopWhen = input.runContext
            ? [turnInputGuard.stopWhen, () => Boolean(input.runContext?.terminalIntent)]
            : turnInputGuard.stopWhen;
          return u.Ai.Text(input.modelKey, input.think ?? false, input.thinkLevel ?? 0).stream({
            messages: terminalCorrectionTurn
              ? [
                  { role: "system", content: TERMINAL_CORRECTION_INSTRUCTIONS },
                  { role: "assistant", content: terminalCorrectionContext },
                  { role: "user", content: "Close the current Chat with exactly one available terminal tool." },
                ]
              : [
                  { role: "system", content: input.stableInstructions },
                  { role: "assistant", content: `${workingContext}\n${input.fixedContext || ""}` },
                  { role: "user", content: input.objective },
                ],
            stopWhen,
            abortSignal: modelStreamScope.signal,
            tools,
            ...(terminalCorrectionTurn ? { toolChoice: "required" as const } : {}),
            onFinish: async (result) => {
              completion.resolve(result);
              if (input.runContext) {
                await recordAgentModelStreamFinished(input.runContext.runId, result).catch((error) => {
                  console.warn(`[${input.agentName}] failed to record model stream completion:`, u.error(error).message);
                });
              }
            },
          });
        })(),
      });
      const { fullStream } = streamResult;

      if (input.runContext) {
        await recordAgentRunEvent(input.runContext.runId, "agent_turn_phase", {
          turnId,
          turnNumber,
          messageId: turnMessageId,
          stage: input.stage,
          subAgent: input.subAgent,
          phase: "model_streaming",
          terminalCorrection: terminalCorrectionTurn,
        });
      }

      let currentMessage = turnMessage;
      turn = await consumeAgentTurn({
        agentName: input.agentName,
        fullStream,
        completion: completion.promise,
        initialMsg: currentMessage,
        userAbortSignal: input.abortSignal,
        abortModelStream: modelStreamScope.abort,
        idleTimeoutMs: turnIdleTimeoutMs,
        maxDurationMs: Math.max(1, turnMaxDurationMs - (Date.now() - turnStartedAt)),
        projectId: input.projectId,
        scriptId: input.scriptId ?? undefined,
        onToolStarted: async ({ toolCallId, toolName }) => {
          if (!input.runContext) return;
          await recordAgentRunEvent(input.runContext.runId, "agent_tool_started", {
            turnId,
            turnNumber,
            messageId: turnMessageId,
            stage: input.stage,
            subAgent: input.subAgent,
            phase: "tool_running",
            toolCallId,
            toolName,
            terminalCorrection: terminalCorrectionTurn,
          });
        },
        onToolFinished: async ({ toolCallId, toolName, success }) => {
          if (!input.runContext) return;
          await recordAgentRunEvent(input.runContext.runId, "agent_tool_finished", {
            turnId,
            turnNumber,
            messageId: turnMessageId,
            stage: input.stage,
            subAgent: input.subAgent,
            phase: "tool_running",
            toolCallId,
            toolName,
            success,
            terminalCorrection: terminalCorrectionTurn,
          });
        },
        onToolResultObserved: ({ success }) => {
          if (success && input.runContext?.terminalIntent) input.runContext.stopForTerminal();
        },
        syncMsg: () => {
          const latest = input.message.get();
          if (latest === currentMessage) return currentMessage;
          currentMessage?.complete?.();
          currentMessage = latest;
          return currentMessage;
        },
      });
    } catch (error) {
      if (input.runContext?.terminalIntent && isAbortError(error)) break;
      const observed = agentTurnResultFromError(error);
      if (isTurnTimeoutError(error)) {
        turnTimedOut = true;
        turn = observed || {
          text: "",
          state: "failed",
          finishReason: error instanceof AgentStreamMaxDurationError ? "max-duration" : "idle-timeout",
          usage: { inputTokens: null, outputTokens: null, totalTokens: null },
          toolCalls: [],
          toolResults: [],
        };
        turn.state = "failed";
        if (input.runContext) {
          await recordAgentRunEvent(input.runContext.runId, "agent_turn_timeout", {
            turnId,
            turnNumber,
            messageId: turnMessageId,
            stage: input.stage,
            subAgent: input.subAgent,
            phase: error.phase,
            activeTools: error.activeTools,
            timeoutMs: error.timeoutMs,
            finishReason: turn.finishReason,
            terminalCorrection: terminalCorrectionTurn,
          });
          input.runContext.setFailed({
            stage: input.stage,
            subAgent: input.subAgent,
            reason: `${input.agentLabel} stopped because the current Turn exceeded its ${error instanceof AgentStreamMaxDurationError ? "maximum duration" : "idle timeout"}.`,
            errorJson: {
              code: error instanceof AgentStreamMaxDurationError ? "AGENT_TURN_MAX_DURATION" : "AGENT_TURN_IDLE_TIMEOUT",
              turnNumber,
              phase: error.phase,
              activeTools: error.activeTools,
              timeoutMs: error.timeoutMs,
            },
          });
        }
      } else if (isContextWindowOverflowError(error)) {
        contextOverflowCount = input.runContext?.recordContextOverflow() ?? contextOverflowCount + 1;
        providerContextOverflow = true;
        turn = observed || {
          text: "",
          state: "interrupted",
          finishReason: "context-overflow",
          usage: { inputTokens: null, outputTokens: null, totalTokens: null },
          toolCalls: [],
          toolResults: [],
        };
        turn.state = "interrupted";
        turn.finishReason = "context-overflow";
      } else if (observed && (observed.state === "interrupted" || isRetryableTransportError(error))) {
        turn = {
          ...observed,
          state: "interrupted",
          finishReason: observed.state === "interrupted" ? observed.finishReason : "transport-error",
        };
      } else {
        throw error;
      }
    } finally {
      if (input.runContext) input.runContext.requestStop = previousStop;
      modelStreamScope.dispose();
    }

    const contextBoundary = turnInputGuard.getBoundary();
    if (contextBoundary?.triggerFinishReason) turn.finishReason = contextBoundary.triggerFinishReason;
    if (input.runContext?.terminalIntent && !turnTimedOut) turn.state = "finished";
    else if (contextBoundary || isRecoverableTurn(turn)) turn.state = "interrupted";
    lastTurn = turn;
    if (turn.text.trim()) transcript.push(turn.text);
    toolResults.push(...turn.toolResults);
    await input.onTurnFinished?.({ turnNumber, turn });

    if (input.runContext) {
      await recordAgentTurnResult(input.runContext.runId, {
        turnId,
        turnNumber,
        messageId: turnMessageId,
        stage: input.stage,
        subAgent: input.subAgent,
        state: turn.state,
        finishReason: turn.finishReason,
        usage: turn.usage,
        textLength: turn.text.length,
        toolCalls: turn.toolCalls,
        toolResults: turn.toolResults,
      });
      if (contextBoundary) {
        await recordAgentRunEvent(input.runContext.runId, "agent_turn_context_boundary", {
          turnId,
          turnNumber,
          messageId: turnMessageId,
          stage: input.stage,
          subAgent: input.subAgent,
          resourceDeliveries: resourceDeliveryStates(turn, false),
          ...contextBoundary,
        });
      } else if (providerContextOverflow) {
        await recordAgentRunEvent(input.runContext.runId, "agent_turn_context_boundary", {
          turnId,
          turnNumber,
          messageId: turnMessageId,
          stage: input.stage,
          subAgent: input.subAgent,
          reason: "provider_context_overflow",
          overflowCount: contextOverflowCount,
          capacitySource: turnInputGuard.budget.source,
          resourceDeliveries: resourceDeliveryStates(turn, true),
        });
      }
    }

    if (input.runContext?.terminalIntent) break;
    if (!input.runContext) break;
    if (input.requireTerminalIntent === false && !contextBoundary && !isRecoverableTurn(turn)) break;

    if (terminalCorrectionTurn) {
      const reason = `${input.agentLabel} did not declare a terminal state during its terminal correction Turn.`;
      await recordAgentRunEvent(input.runContext.runId, "agent_terminal_correction_failed", {
        turnId,
        turnNumber,
        messageId: turnMessageId,
        stage: input.stage,
        subAgent: input.subAgent,
        finishReason: turn.finishReason,
        toolCalls: turn.toolCalls.map((item) => item.toolName),
      });
      input.runContext.setFailed({
        stage: input.stage,
        subAgent: input.subAgent,
        reason,
        errorJson: { code: "AGENT_TERMINAL_CORRECTION_FAILED", turnNumber },
      });
      break;
    }

    const missingTerminalState = !providerContextOverflow && !contextBoundary && !isRecoverableTurn(turn);
    if (missingTerminalState && input.terminalCorrection) {
      const maxAttempts = input.terminalCorrection.maxAttempts ?? 1;
      if (terminalCorrectionAttempts >= maxAttempts) {
        const reason = `${input.agentLabel} exhausted its terminal correction attempt.`;
        input.runContext.setFailed({
          stage: input.stage,
          subAgent: input.subAgent,
          reason,
          errorJson: { code: "AGENT_TERMINAL_CORRECTION_EXHAUSTED", turnNumber, terminalCorrectionAttempts },
        });
        break;
      }
      terminalCorrectionAttempts += 1;
      terminalCorrectionContext = `## Prior model Turn\n- assistantOutput:\n${turn.text.slice(0, 12_000) || "(empty)"}\n- toolCalls: ${JSON.stringify(turn.toolCalls)}\n- toolResults: ${JSON.stringify(boundAgentTurnToolResults(turn.toolResults))}`;
      terminalCorrectionPending = true;
      await recordAgentRunEvent(input.runContext.runId, "agent_terminal_correction_scheduled", {
        fromTurnId: turnId,
        turnNumber,
        nextTurnNumber: turnNumber + 1,
        messageId: turnMessageId,
        stage: input.stage,
        subAgent: input.subAgent,
        finishReason: turn.finishReason,
        attempt: terminalCorrectionAttempts,
      });
      input.message.set(input.message.create());
      continue;
    }

    if (providerContextOverflow && contextOverflowCount >= 2) {
      const checkpoint = String(input.runContext.latestContextCheckpoint || "").trim();
      if (!checkpoint) {
        input.runContext.setFailed({
          stage: input.stage,
          subAgent: input.subAgent,
          reason: `${input.agentLabel} could not preserve a resumable context-overflow checkpoint.`,
          errorJson: { code: "AGENT_RESUMABLE_CHECKPOINT_MISSING", turnNumber },
        });
        break;
      }
      const reason = `${input.agentLabel} was interrupted after the provider reported context overflow twice in this Chat.`;
      const resumable = {
        checkpoint,
        stage: input.stage,
        subAgent: input.subAgent,
        sourceRunId: input.runContext.runId,
        resourceDeliveries: resourceDeliveryStates(turn, true),
        overflow: { count: contextOverflowCount, turnNumber, finishReason: turn.finishReason },
        model: {
          key: input.modelKey,
          capacitySource: turnInputGuard.budget.source,
          contextWindowTokens: turnInputGuard.budget.contextWindowTokens,
          safeInputTokens: turnInputGuard.budget.safeInputTokens,
        },
      };
      await recordAgentRunEvent(input.runContext.runId, "agent_resumable_checkpoint", resumable);
      input.runContext.setInterrupted({
        stage: input.stage,
        subAgent: input.subAgent,
        reason,
        resultJson: { kind: "agent_resumable_context_overflow", sourceRunId: input.runContext.runId },
        errorJson: { code: "AGENT_CONTEXT_OVERFLOW_REPEATED", turnNumber, contextOverflowCount },
      });
      input.onRepeatedContextOverflow?.();
      break;
    }

    consecutiveLengthTurns = advanceConsecutiveLengthTurns(consecutiveLengthTurns, turn.finishReason);
    if (consecutiveLengthTurns >= maxConsecutiveLengthTurns) {
      const reason = `${input.agentLabel} stopped after ${consecutiveLengthTurns} consecutive output-limited Turns.`;
      const textAssetId = await input.archiveFailure?.(turn.text);
      await recordAgentRunEvent(input.runContext.runId, "agent_continuation_exhausted", {
        stage: input.stage,
        subAgent: input.subAgent,
        turnNumber,
        finishReason: turn.finishReason,
        consecutiveLengthTurns,
        textAssetId: textAssetId ?? null,
      });
      input.runContext.setFailed({
        stage: input.stage,
        subAgent: input.subAgent,
        reason,
        errorJson: { code: "AGENT_CONSECUTIVE_LENGTH_LIMIT", turnNumber, consecutiveLengthTurns },
      });
      break;
    }

    const activitySignature = turnActivitySignature(turn);
    const hasNewActivity = Boolean(activitySignature && activitySignature !== lastActivitySignature);
    inactiveTurns = hasNewActivity ? 0 : inactiveTurns + 1;
    if (activitySignature) lastActivitySignature = activitySignature;
    if (inactiveTurns >= maxInactiveTurns) {
      const reason = `${input.agentLabel} ended ${maxInactiveTurns} consecutive Turns without tools, progress, or a terminal declaration.`;
      const textAssetId = await input.archiveFailure?.(turn.text);
      await recordAgentRunEvent(input.runContext.runId, "agent_continuation_exhausted", {
        stage: input.stage,
        subAgent: input.subAgent,
        turnNumber,
        finishReason: turn.finishReason,
        inactiveTurns,
        textAssetId: textAssetId ?? null,
      });
      input.runContext.setFailed({
        stage: input.stage,
        subAgent: input.subAgent,
        reason,
        errorJson: { code: "AGENT_NO_PROGRESS", turnNumber },
      });
      break;
    }

    const reason = continuationReason({ providerContextOverflow, contextBoundary, turn });
    interruptionCount += 1;
    try {
      const continued = await continueProductionAgentContext({
        runId: input.runContext.runId,
        modelKey: input.modelKey,
        think: input.think,
        thinkLevel: input.thinkLevel,
        objective: input.objective,
        context: workingContext,
        fixedContext,
        turn,
        reason,
        stage: input.stage,
        subAgent: input.subAgent,
        turnNumber,
        force: providerContextOverflow || Boolean(contextBoundary),
      });
      workingContext = continued.context;
      if (continued.compacted) input.runContext.setContextCheckpoint(continued.context);
    } catch (error) {
      const diagnostic = u.error(error).message;
      const textAssetId = await input.archiveFailure?.(turn.text);
      await recordAgentRunEvent(input.runContext.runId, "agent_context_compaction_failed", {
        stage: input.stage,
        subAgent: input.subAgent,
        turnNumber,
        finishReason: turn.finishReason,
        textAssetId: textAssetId ?? null,
        diagnostic,
      });
      input.runContext.setFailed({
        stage: input.stage,
        subAgent: input.subAgent,
        reason: `${input.agentLabel} could not preserve a bounded continuation checkpoint.`,
        errorJson: { code: "AGENT_CONTEXT_COMPACTION_FAILED", turnNumber, diagnostic },
      });
      break;
    }
    await recordAgentRunEvent(input.runContext.runId, "agent_turn_continued", {
      fromTurnId: turnId,
      nextTurnNumber: turnNumber + 1,
      reason,
    });
    input.message.set(input.message.create());
  }

  return { lastTurn, transcript, toolResults, interruptionCount } satisfies SharedAgentRuntimeResult;
}
