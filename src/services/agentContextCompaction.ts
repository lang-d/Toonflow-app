import type { StopCondition } from "ai";
import u from "@/utils";
import { resolveTextModelRuntimeInfo } from "@/utils/ai";
import { recordAgentRunEvent } from "@/services/agentRun";
import type { AgentTurnResult } from "@/agents/shared/streaming";

const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
export const MAX_COMPACTED_AGENT_CONTEXT_CHARS = 16_000;
export const MAX_AGENT_TOOL_RESULT_CHARS = 12_000;
export const MAX_AGENT_TURN_TOOL_RESULTS_CHARS = 24_000;
export const MAX_AGENT_COMPACTION_ASSISTANT_CHARS = 12_000;
export const MAX_AGENT_COMPACTION_TOOL_RESULTS_CHARS = MAX_AGENT_TURN_TOOL_RESULTS_CHARS;
export const AGENT_CHECKPOINT_START = "<agent-checkpoint>";
export const AGENT_CHECKPOINT_END = "</agent-checkpoint>";

export type AgentTurnContextBoundary = {
  reason: "resolved_capacity";
  capacitySource: "resolved" | "fallback";
  safeInputTokens: number;
  lastStepInputTokens: number | null;
  estimatedNextInputTokens: number | null;
  incrementalChars: number;
  stepCount: number;
  triggerFinishReason: string | null;
};

export type ProductionAgentTurnInputGuard = {
  stopWhen: StopCondition<any>;
  getBoundary: () => AgentTurnContextBoundary | null;
  budget: ReturnType<typeof calculateAgentContextBudget>;
};

const AGENT_CHECKPOINT_SYSTEM = `You are the same Agent preserving your own working state across a technical context boundary. This is not a neutral summary and not a professional re-review. Do not call tools. Preserve the user objective and constraints, confirmed decisions, completed work, pending work, material findings with evidence references, exact completed ranges or cursors, and formal artifact or tool-result references. Do not invent completion or new findings. A tool may be recorded as actually called, successful, failed, or available only when the supplied toolCalls/toolResults prove that claim. A tool name mentioned only in assistantOutput is an unverified idea: omit it or explicitly label it unverified, and never promote it to a system capability or completed action. Keep the checkpoint concise enough to continue the same task without restarting completed work.

Return only one checkpoint enclosed by the exact markers ${AGENT_CHECKPOINT_START} and ${AGENT_CHECKPOINT_END}. The text inside may use natural-language headings and lists. Do not return JSON, Markdown fences, commentary outside the markers, or null.`;

export function estimateAgentTokens(text: string) {
  return estimateAgentTokensFromChars(text.length);
}

function estimateAgentTokensFromChars(chars: number) {
  if (!chars) return 0;
  // A deliberately conservative provider-neutral estimate. Exact tokenizers
  // remain provider-owned; this is only an early compaction trigger.
  return Math.ceil(chars / 2.5);
}

export function calculateAgentContextBudget(info: {
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
}) {
  const contextWindowTokens = info.contextWindowTokens || DEFAULT_CONTEXT_WINDOW_TOKENS;
  const maxOutputTokens = info.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS;
  return {
    contextWindowTokens,
    maxOutputTokens,
    safeInputTokens: Math.max(1024, Math.floor(contextWindowTokens * 0.9) - maxOutputTokens),
    source: info.contextWindowTokens || info.maxOutputTokens ? "resolved" : "fallback",
  } as const;
}

export async function resolveAgentContextBudget(modelKey: Parameters<typeof u.Ai.Text>[0]) {
  const info = await resolveTextModelRuntimeInfo(modelKey);
  return {
    ...info,
    ...calculateAgentContextBudget(info),
  } as const;
}

function workingContextPrompt(objective: string, context: string) {
  return `Create a compact replacement working checkpoint for continuing the same Agent task. Stable workflow and Skill instructions are supplied separately on every Turn and must not be copied into this checkpoint.

Preserve the user's objective and constraints, confirmed decisions, completed work, pending work, material model-authored findings with their evidence references, exact completed data ranges or pagination cursors, and references to formal artifacts or recent tool results. Do not invent completion, quality conclusions, remaining ranges, or professional judgments. Database facts and tool outputs remain authoritative and should be represented by references rather than copied in full. Distinguish assistant plans from actual execution: only the supplied toolCalls/toolResults establish that a named tool was called or returned a result.

Current user objective:
${objective}

Conversation/task context to compact:
${context}`;
}

export async function compactProductionAgentContextIfNeeded(input: {
  runId?: string;
  modelKey: Parameters<typeof u.Ai.Text>[0];
  think?: boolean;
  thinkLevel?: 0 | 1 | 2 | 3;
  objective: string;
  context: string;
  fixedContext?: string;
  force?: boolean;
  stage?: string;
  subAgent?: string;
  turnNumber?: number;
}) {
  const budget = await resolveAgentContextBudget(input.modelKey);
  const estimatedInputTokens = estimateAgentTokens(
    `${input.fixedContext || ""}\n${input.objective}\n${input.context}`,
  );
  if (!input.force && (budget.source !== "resolved" || estimatedInputTokens < budget.safeInputTokens)) {
    return { compacted: false as const, context: input.context, budget, estimatedInputTokens };
  }

  const response = await u.Ai.Text(input.modelKey, input.think ?? false, input.thinkLevel ?? 0).invoke({
    maxRetries: 0,
    system: AGENT_CHECKPOINT_SYSTEM,
    messages: [{ role: "user", content: workingContextPrompt(input.objective, input.context) }],
  });
  const checkpoint = parseProductionAgentCheckpoint(String(response.text || ""), String(response.finishReason || "unknown"));
  const compactedContext = checkpoint.context;
  if (input.runId) {
    await recordAgentRunEvent(input.runId, "agent_context_compacted", {
      stage: input.stage ?? null,
      subAgent: input.subAgent ?? null,
      turnNumber: input.turnNumber ?? null,
      forced: Boolean(input.force),
      model: budget.resolvedModelName,
      capacitySource: budget.source,
      estimatedInputTokens,
      safeInputTokens: budget.safeInputTokens,
      originalChars: input.context.length,
      fixedContextChars: input.fixedContext?.length || 0,
      compactedChars: compactedContext.length,
      checkpointFinishReason: response.finishReason,
      checkpointUsage: response.usage,
      checkpoint: checkpoint.content,
    });
  }
  return { compacted: true as const, context: compactedContext, budget, estimatedInputTokens };
}

function serializeToolResult(value: unknown) {
  try {
    const serialized = JSON.stringify(value);
    return { serialized: serialized ?? "null", serializable: true };
  } catch {
    return { serialized: String(value), serializable: false };
  }
}

function serializedLength(value: unknown) {
  try {
    const serialized = JSON.stringify(value);
    return serialized == null ? 0 : serialized.length;
  } catch {
    return null;
  }
}

function finiteUsageToken(value: unknown) {
  const token = Number(value);
  return Number.isFinite(token) && token >= 0 ? token : null;
}

export function isContextWindowOverflowError(error: unknown) {
  const seen = new Set<unknown>();
  const values: unknown[] = [error];
  const structuredCodes = new Set([
    "context_length_exceeded",
    "context_window_exceeded",
    "max_context_length",
    "input_too_long",
    "prompt_too_long",
  ]);
  const messagePattern =
    /context[_-](?:length|window)[_-]exceeded|input[_-]too[_-]long|context(?:\s+window|\s+length)?.{0,60}(?:exceed|too\s+(?:large|long)|maximum|limit)|maximum\s+context|too\s+many\s+tokens|input.{0,40}token.{0,40}limit|prompt.{0,20}too\s+long/i;

  while (values.length) {
    const value = values.shift();
    if (value == null || seen.has(value)) continue;
    seen.add(value);
    if (typeof value === "string") {
      if (structuredCodes.has(value.toLowerCase()) || messagePattern.test(value)) return true;
      continue;
    }
    if (typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    for (const key of ["code", "type", "name", "message"]) {
      const candidate = record[key];
      if (typeof candidate === "string") values.push(candidate);
    }
    for (const key of ["cause", "error", "response", "responseBody", "data", "body", "lastError"]) {
      if (record[key] != null) values.push(record[key]);
    }
  }
  return false;
}

export async function createProductionAgentTurnInputGuard(input: {
  modelKey: Parameters<typeof u.Ai.Text>[0];
}): Promise<ProductionAgentTurnInputGuard> {
  const budget = await resolveAgentContextBudget(input.modelKey);
  return createProductionAgentTurnInputGuardForBudget({ budget });
}

export function createProductionAgentTurnInputGuardForBudget(input: {
  budget: ReturnType<typeof calculateAgentContextBudget>;
}): ProductionAgentTurnInputGuard {
  const { budget } = input;
  let boundary: AgentTurnContextBoundary | null = null;

  const stopWhen: StopCondition<any> = ({ steps }) => {
    if (boundary || steps.length === 0) return Boolean(boundary);
    const lastStep = steps[steps.length - 1];
    const incrementalChars = serializedLength(lastStep.response?.messages);
    const currentStepChars = serializedLength(lastStep.content);
    const lastStepInputTokens = finiteUsageToken(lastStep.usage?.inputTokens);
    const estimatedNextInputTokens =
      lastStepInputTokens == null || currentStepChars == null
        ? null
        : lastStepInputTokens + estimateAgentTokensFromChars(currentStepChars);
    const resolvedCapacityReached =
      budget.source === "resolved" &&
      estimatedNextInputTokens != null &&
      estimatedNextInputTokens >= budget.safeInputTokens;

    if (!resolvedCapacityReached) return false;
    boundary = {
      reason: "resolved_capacity",
      capacitySource: budget.source,
      safeInputTokens: budget.safeInputTokens,
      lastStepInputTokens,
      estimatedNextInputTokens,
      incrementalChars: incrementalChars ?? Number.MAX_SAFE_INTEGER,
      stepCount: steps.length,
      triggerFinishReason: typeof lastStep.finishReason === "string" ? lastStep.finishReason : null,
    };
    return true;
  };

  return { stopWhen, getBoundary: () => boundary, budget };
}

function boundedSerializedValue(value: unknown, maxChars: number) {
  const { serialized, serializable } = serializeToolResult(value);
  if (serializable && serialized.length <= maxChars) return value;

  let low = 0;
  let high = Math.floor(maxChars / 2);
  let bounded = {
    truncated: true,
    serializable,
    originalChars: serialized.length,
    head: "",
    tail: "",
  };
  while (low <= high) {
    const partChars = Math.floor((low + high) / 2);
    const candidate = {
      ...bounded,
      head: serialized.slice(0, partChars),
      tail: serialized.slice(-partChars),
    };
    if (JSON.stringify(candidate).length <= maxChars) {
      bounded = candidate;
      low = partChars + 1;
    } else {
      high = partChars - 1;
    }
  }
  return bounded;
}

function compactResourceAccessResult(value: unknown) {
  const result = value as Record<string, unknown> | null;
  if (!result || typeof result.resourceRef !== "string") return null;
  return {
    resourceRef: result.resourceRef,
    key: result.key ?? null,
    version: result.version ?? null,
    returnedRange: result.returnedRange ?? null,
    nextCursor: result.nextCursor ?? null,
    eof: result.eof ?? null,
    contentOmitted: typeof result.content === "string",
    itemCount: Array.isArray(result.items) ? result.items.length : null,
    hitCount: Array.isArray(result.hits) ? result.hits.length : null,
    pendingConsumption: true,
  };
}

export type BoundedAgentToolResults = {
  items: Array<{
    toolCallId: string | null;
    toolName: string | null;
    success: boolean;
    result?: unknown;
    originalChars: number;
    resultOmitted?: true;
  }>;
  omittedMetadataCount: number;
};

export function boundAgentTurnToolResults(results: AgentTurnResult["toolResults"]): BoundedAgentToolResults {
  const items: BoundedAgentToolResults["items"] = [];
  let omittedMetadataCount = 0;
  const resultEnvelopeReserve = 128;
  let usedChars = 2 + resultEnvelopeReserve;

  // Preserve metadata for as many calls as possible, prioritizing the newest
  // calls because they describe the state reached immediately before the
  // boundary. Result payloads are attached in a second pass from newest to
  // oldest within the same aggregate budget.
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    const originalChars = serializeToolResult(result.result).serialized.length;
    const metadataItem = {
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      success: result.success,
      originalChars,
      resultOmitted: true as const,
    };
    const metadataChars = JSON.stringify(metadataItem).length + 1;
    if (usedChars + metadataChars <= MAX_AGENT_TURN_TOOL_RESULTS_CHARS) {
      items.unshift(metadataItem);
      usedChars += metadataChars;
    } else {
      omittedMetadataCount += 1;
    }
  }

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const source = results.find((result) => result.toolCallId === item.toolCallId);
    if (!source) continue;
    const remainingChars = MAX_AGENT_TURN_TOOL_RESULTS_CHARS - usedChars;
    const resultBudget = Math.min(MAX_AGENT_TOOL_RESULT_CHARS, remainingChars - 32);
    if (resultBudget < 256) break;
    const candidate = {
      toolCallId: item.toolCallId,
      toolName: item.toolName,
      success: item.success,
      result:
        source.toolName === "resource_access"
          ? compactResourceAccessResult(source.result) || boundedSerializedValue(source.result, resultBudget)
          : boundedSerializedValue(source.result, resultBudget),
      originalChars: item.originalChars,
    };
    const addedChars = JSON.stringify(candidate).length - JSON.stringify(item).length;
    if (addedChars > remainingChars) continue;
    items[index] = candidate;
    usedChars += addedChars;
  }

  return { items, omittedMetadataCount };
}

export function buildAgentTurnContinuationContext(turn: AgentTurnResult, reason?: string) {
  const toolResults = boundAgentTurnToolResults(turn.toolResults);
  return `## Previous model Turn\nThis section records prior runtime state; it is not a new user request.\n- reason: ${reason || turn.finishReason}\n- state: ${turn.state}\n- finishReason: ${turn.finishReason}\n- assistantOutput:\n${turn.text || "(empty)"}\n- toolCalls: ${JSON.stringify(turn.toolCalls)}\n- toolResults: ${JSON.stringify(toolResults)}`;
}

export function buildAgentTurnCompactionContext(turn: AgentTurnResult, reason?: string) {
  const assistantOutput = boundedSerializedValue(turn.text || "", MAX_AGENT_COMPACTION_ASSISTANT_CHARS);
  const toolResults = boundAgentTurnToolResults(turn.toolResults);
  return `## Previous model Turn source for compaction
This section is source material for a replacement working checkpoint; it is not a new user request.
- reason: ${reason || turn.finishReason}
- state: ${turn.state}
- finishReason: ${turn.finishReason}
- assistantOutput: ${JSON.stringify(assistantOutput)}
- toolCalls: ${JSON.stringify(turn.toolCalls)}
- toolResults: ${JSON.stringify(toolResults)}`;
}

export function parseProductionAgentCheckpoint(text: string, finishReason = "stop") {
  if (finishReason === "length") {
    throw new Error("AGENT_CONTEXT_COMPACTION_FAILED: checkpoint output reached the model length limit");
  }
  const raw = String(text || "").trim();
  const startIndex = raw.indexOf(AGENT_CHECKPOINT_START);
  const endIndex = raw.lastIndexOf(AGENT_CHECKPOINT_END);
  if (startIndex < 0 || endIndex < startIndex + AGENT_CHECKPOINT_START.length) {
    throw new Error("AGENT_CONTEXT_COMPACTION_FAILED: checkpoint markers are incomplete");
  }
  const content = raw.slice(startIndex + AGENT_CHECKPOINT_START.length, endIndex).trim();
  if (!content) throw new Error("AGENT_CONTEXT_COMPACTION_FAILED: checkpoint is empty");
  const context = `## Active working checkpoint (replaces older Turn history)
Continue the same task from this checkpoint. It is the same Agent's preserved working state, not a new user request. Do not restart tool-confirmed completed work merely because older raw messages were compacted. The checkpoint preserves prior results and pending work but does not restrict tool choice in this Turn: choose any currently provided tool that helps the task, and use the current Tool Schema only to confirm whether a tool is callable now. A prior tool result remains evidence for the prior action; a tool name in the checkpoint does not require reuse and does not prove current availability. You may reread a specific fact when you judge its evidence missing or conflicting.
${content}`;
  if (context.length > MAX_COMPACTED_AGENT_CONTEXT_CHARS) {
    throw new Error(`AGENT_CONTEXT_COMPACTION_FAILED: checkpoint exceeded ${MAX_COMPACTED_AGENT_CONTEXT_CHARS} characters`);
  }
  return { content, context };
}

export function advanceConsecutiveLengthTurns(current: number, finishReason: string) {
  return finishReason === "length" ? current + 1 : 0;
}

export async function continueProductionAgentContext(input: {
  runId?: string;
  modelKey: Parameters<typeof u.Ai.Text>[0];
  think?: boolean;
  thinkLevel?: 0 | 1 | 2 | 3;
  objective: string;
  context: string;
  fixedContext?: string;
  turn: AgentTurnResult;
  reason?: string;
  stage?: string;
  subAgent?: string;
  turnNumber?: number;
  force?: boolean;
}) {
  const force = Boolean(input.force) || input.turn.finishReason === "length";
  const turnContext = force
    ? buildAgentTurnCompactionContext(input.turn, input.reason)
    : buildAgentTurnContinuationContext(input.turn, input.reason);
  const combinedContext = input.context ? `${input.context}\n\n${turnContext}` : turnContext;
  return compactProductionAgentContextIfNeeded({
    runId: input.runId,
    modelKey: input.modelKey,
    think: input.think,
    thinkLevel: input.thinkLevel,
    objective: input.objective,
    context: combinedContext,
    fixedContext: input.fixedContext,
    force,
    stage: input.stage,
    subAgent: input.subAgent,
    turnNumber: input.turnNumber,
  });
}
