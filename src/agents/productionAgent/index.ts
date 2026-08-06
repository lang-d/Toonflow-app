import { Socket } from "socket.io";
import { z } from "zod";
import { tool, jsonSchema } from "ai";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import useTools from "@/agents/productionAgent/tools";
import ResTool from "@/socket/resTool";
import { createTextAsset } from "@/services/textAsset";
import { getDirectorPlanGenerationState } from "@/services/directorPlanGeneration";
import { runLazyRetentionCleanup } from "@/services/retention";
import { getVideoModelPolicy } from "@/services/videoModelPolicy";
import { getProjectContextPack } from "@/services/projectMaterial";
import { readConfiguredSkill } from "@/services/skillResolver";
import { loadProductionStage, productionSupervisionStage } from "@/services/productionStageSkills";
import { createLogger } from "@/logger";
import {
  consumeAgentTurn,
  agentTurnResultFromError,
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
  runStoryboardPanelSingleReview,
  storyboardPanelSingleReviewFailureDetails,
} from "@/services/storyboardPanelSingleReview";
import {
  advanceConsecutiveLengthTurns,
  boundAgentTurnToolResults,
  compactProductionAgentContextIfNeeded,
  continueProductionAgentContext,
  createProductionAgentTurnInputGuard,
  isContextWindowOverflowError,
} from "@/services/agentContextCompaction";

const productionAgentLog = createLogger("production-agent");
const PRODUCTION_AGENT_MAX_INACTIVE_TURNS = 3;
const PRODUCTION_AGENT_MAX_CONSECUTIVE_LENGTH_TURNS = 4;

function productionMemory(isolationKey: string) {
  return new Memory("productionAgent", isolationKey, {
    autoSummarize: false,
    allowedRoles: ["user", "assistant:final"],
    includeSummaries: false,
    includeAutomaticRag: false,
  });
}

function completionLatch() {
  let resolve!: (value: AgentModelCompletion | null) => void;
  const promise = new Promise<AgentModelCompletion | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

function isRecoverableTurn(turn: AgentTurnResult) {
  return turn.state === "interrupted" || ["length", "tool-calls", "unknown"].includes(turn.finishReason);
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

function interruptedOverflowFeedback(resTool: ResTool) {
  const feedback = resTool.newMessage("assistant", "视频策划");
  feedback
    .text(
      "当前 Chat 因供应商连续两次报告上下文容量溢出而安全中断，工作断点已保存。可以直接发送“继续”创建新的 Chat 并从断点恢复，也可以先切换更大上下文模型或缩小任务范围。",
    )
    .complete();
  feedback.complete();
}

type SubAgentTaskResult = {
  text: string;
  finishReason: string;
  toolResults: AgentTurnResult["toolResults"];
  interruptionCount: number;
  outputAssetId?: number;
};

function subAgentText(result: SubAgentTaskResult) {
  return result.text || "Sub-agent returned without a user-facing summary.";
}

async function archiveProductionAgentTranscript(input: {
  runId?: string;
  projectId: number;
  scriptId: number | null;
  agentKey: string;
  stage: string;
  subAgent: string;
  name: string;
  content: string;
}) {
  if (!input.content.trim()) return undefined;
  await runLazyRetentionCleanup();
  const asset = await createTextAsset({
    projectId: input.projectId,
    scriptId: input.scriptId,
    targetType: "agentOutput",
    targetId: `${input.agentKey}:${input.runId || Date.now()}`,
    content: input.content,
    summary: `${input.name} process transcript (${input.content.length} chars)`,
    state: "complete",
  });
  if (input.runId) {
    await recordAgentRunEvent(input.runId, "agent_output_archived", {
      stage: input.stage,
      subAgent: input.subAgent,
      agentKey: input.agentKey,
      textAssetId: asset.id,
      summary: asset.summary,
      size: asset.size,
    });
  }
  return asset.id;
}

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  text: string;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  messages?: { role: "user" | "assistant" | "system"; content: string }[];
  thinkConfig: {
    think: boolean;
    thinlLevel: 0 | 1 | 2 | 3;
  };
  runContext?: AgentRunContext;
  continuation?: {
    kind: "awaiting_user" | "resumable_interruption";
    run: {
      runId: string;
      reason: string | null;
      currentStage: string | null;
      currentSubAgent: string | null;
      resultJson: string | null;
      startedAt: number | null;
    };
    decision?: unknown;
    checkpoint?: unknown;
  } | null;
}

function isAbortError(error: unknown) {
  const err = error as { name?: string; code?: string } | undefined;
  return err?.name === "AbortError" || err?.code === "ABORT_ERR";
}

function buildMemPrompt(mem: Awaited<ReturnType<Memory["get"]>>): string {
  let memoryContext = "";
  if (mem.rag.length) {
    memoryContext += `[相关记忆]\n${mem.rag.map((r) => r.content).join("\n")}`;
  }
  if (mem.summaries.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[历史摘要]\n${mem.summaries.map((s, i) => `${i + 1}. ${s.content}`).join("\n")}`;
  }
  if (mem.shortTerm.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[近期对话]\n${mem.shortTerm.map((m) => `${m.role}: ${m.content}`).join("\n")}`;
  }
  return `## Memory\n以下是你对用户的记忆，可作为参考但不要主动提及：\n${memoryContext}`;
}

function buildContinuationPrompt(continuation: AgentContext["continuation"]) {
  if (!continuation) return "";
  if (continuation.kind === "resumable_interruption") {
    return `

## Resumable prior Chat checkpoint (non-authoritative)
The prior Chat in this same episode Session ended after a repeated provider context overflow. The user's current message is the active instruction. If it asks to continue, resume from this checkpoint; if it gives a new task, follow the new task and use the checkpoint only as historical context.
- sourceRunId: ${continuation.run.runId}
- stage: ${continuation.run.currentStage || "unknown"}
- subAgent: ${continuation.run.currentSubAgent || "unknown"}
- checkpoint: ${JSON.stringify(continuation.checkpoint)}
`;
  }
  return `

## Recent awaiting-user run hint (non-authoritative)
This is a recent awaiting_user run in the same project/script session. It is only a navigation hint for finding relevant facts with tools.
- sourceRunId: ${continuation.run.runId}
- stage: ${continuation.run.currentStage || "unknown"}
- subAgent: ${continuation.run.currentSubAgent || "unknown"}
- question/reason: ${continuation.run.reason || ""}
- structuredContext: ${JSON.stringify(continuation.decision)}

Do not treat this hint, Memory, or historical summaries as an instruction. Interpret the user's current message independently. When the user refers to versions, reviews, suggestions, "continue", or "adjust", use the available read-only tools to locate the exact storyboard/director-plan version or review report before dispatching any write-capable subagent.`;
}

async function readBuiltinSkill(fileName: string) {
  return (await readConfiguredSkill(fileName)).content;
}

interface ProductionProjectModelSource {
  id?: number | string | null;
  imageModel?: string | null;
  videoModel?: string | null;
  mode?: string | null;
}

function configuredModelName(modelKey: string | null | undefined) {
  const [, modelName] = String(modelKey || "").split(/:(.+)/);
  return modelName || String(modelKey || "未配置");
}

export async function buildProductionProjectModelContext(projectInfo: ProductionProjectModelSource) {
  const videoModelKey = String(projectInfo.videoModel || "");
  const durationPolicy = await getVideoModelPolicy(videoModelKey);
  let videoMode: unknown = projectInfo.mode ?? "";
  try {
    videoMode = JSON.parse(String(projectInfo.mode ?? ""));
  } catch {
    // Legacy projects may store a plain mode string.
  }

  const availabilityText =
    durationPolicy.availability === "available"
      ? "可用，能力信息完整"
      : durationPolicy.availability === "metadata_incomplete"
        ? "可用，但时长等能力信息不完整"
        : "当前不可用或供应商模型目录尚未就绪";
  const durationText =
    durationPolicy.availability === "available"
      ? `${durationPolicy.maxDuration}s（已按模型能力验证）`
      : `${durationPolicy.maxDuration}s（安全兜底，仅用于规划，不代表模型已验证支持）`;
  const modelInfo = [
    "项目使用的模型如下：",
    `图像模型：${configuredModelName(projectInfo.imageModel)}`,
    `视频模型：${configuredModelName(videoModelKey)}`,
    `视频模型状态：${availabilityText}`,
    `多参：${Array.isArray(videoMode) ? "是" : "否"}`,
    `默认视频模型最大规划时长：${durationText}`,
    "分镜组是一次视频生成单元，不是场次；单组总时长不得超过默认视频模型最大规划时长。",
    durationPolicy.availability === "unavailable"
      ? "当前只允许继续策划；实际生成视频前必须刷新供应商模型或重新选择可用模型。"
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const logContext = {
    event: "project-video-model.resolved",
    projectId: projectInfo.id ?? undefined,
    model: videoModelKey,
    availability: durationPolicy.availability,
    maxDuration: durationPolicy.maxDuration,
    diagnostic: durationPolicy.diagnostic,
  };
  if (durationPolicy.availability === "available") {
    productionAgentLog.info("Project video model metadata resolved", logContext);
  } else {
    productionAgentLog.warn("Project video model metadata degraded; continuing planning", logContext);
  }

  return { modelInfo, durationPolicy };
}

function isExplicitStoryboardImageGenerationRequest(text: string) {
  const compact = String(text || "").replace(/\s+/g, "");
  if (!/(分镜图|分镜图片|故事板图|storyboard)/i.test(compact)) return false;
  if (/(不生成|不要生成|别生成|暂不生成|先不生成|无需生成|不用生成)/.test(compact)) return false;
  return /(生成|开始|启动|确认|同意|执行|生图)/.test(compact);
}

function isShortConfirmation(text: string) {
  const compact = String(text || "").replace(/\s+/g, "");
  return /^(确认|可以|好的|好|同意|开始|生成|是|要)$/.test(compact);
}

function recentlyAskedStoryboardImageGeneration(mem: Awaited<ReturnType<Memory["get"]>>) {
  const recent = mem.shortTerm
    .slice(-6)
    .map((item) => `${item.role}: ${item.content}`)
    .join("\n");
  return /是否生成分镜图|要不要生成分镜图|确认生成分镜图|生成分镜图/.test(recent);
}

function allowsDerivedAssetDelete(userText: string, taskPrompt: string) {
  return /(删除|移除|删掉|清除|作废|delete|remove)/i.test(`${userText}\n${taskPrompt}`);
}

async function buildDirectorProjectContextPrompt(projectId: number) {
  const pack = await getProjectContextPack(projectId).catch(() => null);
  const content = String(pack?.content || "").trim();
  if (!content) return "";
  const clipped = content.length > 4000 ? `${content.slice(0, 4000)}\n...(已截断)` : content;
  return `

【项目制作参考包（仅供导演规划软参考）】
用途：用于保持项目连续性、角色关系、世界观、视觉方向、音乐/节奏方向。
优先级：不得覆盖用户本轮明确要求、剧本文本、已有资产设定；不要把参考包原文整段复述进导演规划。

${clipped}`;
}

export async function runDecisionAI(ctx: AgentContext) {
  const { isolationKey, text, abortSignal } = ctx;
  const memory = productionMemory(isolationKey);
  const priorMemory = await memory.get(text);
  await memory.add("user", text, { createTime: ctx.userMessageTime });

  const prompt = await readBuiltinSkill("production_agent_decision.md");

  const projectInfo = await u.db("o_project").where("id", ctx.resTool.data.projectId).first();
  if (!projectInfo) throw new Error(`项目不存在，ID: ${ctx.resTool.data.projectId}`);
  const { modelInfo, durationPolicy } = await buildProductionProjectModelContext(projectInfo);

  const mem = buildMemPrompt(priorMemory);
  const continuationPrompt = buildContinuationPrompt(ctx.continuation);
  const decisionFixedContext = prompt + modelInfo + text;
  const preparedContext = await compactProductionAgentContextIfNeeded({
    runId: ctx.runContext?.runId,
    modelKey: "productionAgent:decisionAgent",
    think: ctx.thinkConfig.think,
    thinkLevel: ctx.thinkConfig.thinlLevel,
    objective: text,
    context: mem + continuationPrompt,
    fixedContext: decisionFixedContext,
  });
  let decisionContext = preparedContext.context;
  if (preparedContext.compacted) ctx.runContext?.setContextCheckpoint(preparedContext.context);
  let turnNumber = 0;
  let inactiveTurns = 0;
  let consecutiveLengthTurns = 0;
  let contextOverflowCount = 0;
  let lastActivitySignature = "";
  const archiveDecisionFailure = async (content: string) =>
    archiveProductionAgentTranscript({
      runId: ctx.runContext?.runId,
      projectId: Number(ctx.resTool.data.projectId),
      scriptId: ctx.resTool.data.scriptId == null ? null : Number(ctx.resTool.data.scriptId),
      agentKey: "productionAgent:decisionAgent",
      stage: "decision",
      subAgent: "decisionAgent",
      name: "Decision Agent recovery",
      content,
    }).catch((error) => {
      console.warn("[productionAgent] failed to archive Decision Agent recovery transcript", error);
      return undefined;
    });

  while (!ctx.runContext?.terminalIntent) {
    turnNumber += 1;
    const turnId = u.uuid();
    const turnMessageId = ctx.msg.id;
    const turnInputGuard = await createProductionAgentTurnInputGuard({
      modelKey: "productionAgent:decisionAgent",
    });
    const modelStreamScope = createAgentModelStreamScope(abortSignal);
    const completion = completionLatch();
    if (ctx.runContext) {
      ctx.runContext.requestStop = () => modelStreamScope.abort();
      ctx.runContext.markStage("decision", "decisionAgent");
      await recordAgentTurnStarted(ctx.runContext.runId, {
        turnId,
        turnNumber,
        messageId: turnMessageId,
        stage: "decision",
        subAgent: "decisionAgent",
        continuedFrom: turnNumber > 1 ? "previous_turn" : null,
      });
    }

    let turn: AgentTurnResult;
    let providerContextOverflow = false;
    try {
      const { fullStream } = await u.Ai.Text(
        "productionAgent:decisionAgent",
        ctx.thinkConfig.think,
        ctx.thinkConfig.thinlLevel,
      ).stream({
        messages: [
          { role: "system", content: prompt },
          { role: "assistant", content: decisionContext + "\n" + modelInfo },
          { role: "user", content: text },
        ],
        stopWhen: turnInputGuard.stopWhen,
        abortSignal: modelStreamScope.signal,
        tools: {
          ...memory.getTools(),
          ...useTools({
            resTool: ctx.resTool,
            msg: ctx.msg,
            toolsNames: [
              "get_flowData",
              "resource_access",
              "update_agent_progress",
              "complete_agent_run",
              "await_user_decision",
              "list_storyboard_generations",
              "read_storyboard_generation",
              "list_production_reviews",
              "read_production_review",
              "read_text_asset",
              "list_director_plan_generations",
              "read_director_plan_generation",
            ],
            runContext: ctx.runContext,
            continuation: ctx.continuation,
          }),
          ...(await createSubAgent(ctx, { projectInfo, modelInfo, durationPolicy })),
        },
        onFinish: async (result) => {
          completion.resolve(result);
          if (ctx.runContext) {
            await recordAgentModelStreamFinished(ctx.runContext.runId, result).catch((error) => {
              console.warn("[productionAgent] failed to record model stream completion:", u.error(error).message);
            });
          }
        },
      });

      let currentMsg = ctx.msg;
      turn = await consumeAgentTurn({
        agentName: "productionAgent:decisionAgent",
        fullStream,
        completion: completion.promise,
        initialMsg: currentMsg,
        userAbortSignal: abortSignal,
        abortModelStream: modelStreamScope.abort,
        projectId: ctx.resTool.data.projectId,
        scriptId: ctx.resTool.data.scriptId,
        syncMsg: () => {
          if (ctx.msg === currentMsg) return currentMsg;
          currentMsg.complete();
          currentMsg = ctx.msg;
          return currentMsg;
        },
      });
    } catch (error) {
      if (ctx.runContext?.terminalIntent && isAbortError(error)) break;
      const observed = agentTurnResultFromError(error);
      if (isContextWindowOverflowError(error)) {
        contextOverflowCount = ctx.runContext?.recordContextOverflow() ?? contextOverflowCount + 1;
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
      if (ctx.runContext?.requestStop) ctx.runContext.requestStop = undefined;
      modelStreamScope.dispose();
    }

    const contextBoundary = turnInputGuard.getBoundary();
    if (contextBoundary?.triggerFinishReason) turn.finishReason = contextBoundary.triggerFinishReason;
    if (contextBoundary || isRecoverableTurn(turn)) turn.state = "interrupted";
    if (ctx.runContext) {
      await recordAgentTurnResult(ctx.runContext.runId, {
        turnId,
        turnNumber,
        messageId: turnMessageId,
        stage: "decision",
        subAgent: "decisionAgent",
        state: turn.state,
        finishReason: turn.finishReason,
        usage: turn.usage,
        textLength: turn.text.length,
        toolCalls: turn.toolCalls,
        toolResults: turn.toolResults,
      });
      if (contextBoundary) {
        await recordAgentRunEvent(ctx.runContext.runId, "agent_turn_context_boundary", {
          turnId,
          turnNumber,
          messageId: turnMessageId,
          stage: "decision",
          subAgent: "decisionAgent",
          resourceDeliveries: resourceDeliveryStates(turn, false),
          ...contextBoundary,
        });
      } else if (providerContextOverflow) {
        await recordAgentRunEvent(ctx.runContext.runId, "agent_turn_context_boundary", {
          turnId,
          turnNumber,
          messageId: turnMessageId,
          stage: "decision",
          subAgent: "decisionAgent",
          reason: "provider_context_overflow",
          overflowCount: contextOverflowCount,
          capacitySource: turnInputGuard.budget.source,
          resourceDeliveries: resourceDeliveryStates(turn, true),
        });
      }
    }

    if (ctx.runContext?.terminalIntent) break;
    if (!ctx.runContext) return;

    if (providerContextOverflow && contextOverflowCount >= 2) {
      const checkpoint = String(ctx.runContext.latestContextCheckpoint || "").trim();
      if (!checkpoint) {
        ctx.runContext.setFailed({
          stage: "decision",
          subAgent: "decisionAgent",
          reason: "Production Agent could not preserve a resumable context-overflow checkpoint.",
          errorJson: { code: "AGENT_RESUMABLE_CHECKPOINT_MISSING", turnNumber },
        });
        break;
      }
      const reason = "Production Agent was interrupted after the provider reported context overflow twice in this Chat.";
      const resumable = {
        checkpoint,
        stage: "decision",
        subAgent: "decisionAgent",
        sourceRunId: ctx.runContext.runId,
        resourceDeliveries: resourceDeliveryStates(turn, true),
        overflow: { count: contextOverflowCount, turnNumber, finishReason: turn.finishReason },
        model: {
          key: "productionAgent:decisionAgent",
          capacitySource: turnInputGuard.budget.source,
          contextWindowTokens: turnInputGuard.budget.contextWindowTokens,
          safeInputTokens: turnInputGuard.budget.safeInputTokens,
        },
      };
      await recordAgentRunEvent(ctx.runContext.runId, "agent_resumable_checkpoint", resumable);
      ctx.runContext.setInterrupted({
        stage: "decision",
        subAgent: "decisionAgent",
        reason,
        resultJson: { kind: "agent_resumable_context_overflow", sourceRunId: ctx.runContext.runId },
        errorJson: { code: "AGENT_CONTEXT_OVERFLOW_REPEATED", turnNumber, contextOverflowCount },
      });
      interruptedOverflowFeedback(ctx.resTool);
      break;
    }

    consecutiveLengthTurns = advanceConsecutiveLengthTurns(consecutiveLengthTurns, turn.finishReason);
    if (consecutiveLengthTurns >= PRODUCTION_AGENT_MAX_CONSECUTIVE_LENGTH_TURNS) {
      const reason = `Production Agent stopped after ${consecutiveLengthTurns} consecutive output-limited Turns.`;
      const textAssetId = await archiveDecisionFailure(turn.text);
      await recordAgentRunEvent(ctx.runContext.runId, "agent_continuation_exhausted", {
        stage: "decision",
        subAgent: "decisionAgent",
        turnNumber,
        finishReason: turn.finishReason,
        consecutiveLengthTurns,
        textAssetId: textAssetId ?? null,
      });
      ctx.runContext.setFailed({
        stage: "decision",
        subAgent: "decisionAgent",
        reason,
        errorJson: { code: "AGENT_CONSECUTIVE_LENGTH_LIMIT", turnNumber, consecutiveLengthTurns },
      });
      break;
    }

    const activitySignature = turnActivitySignature(turn);
    const hasNewActivity = Boolean(activitySignature && activitySignature !== lastActivitySignature);
    inactiveTurns = hasNewActivity ? 0 : inactiveTurns + 1;
    if (activitySignature) lastActivitySignature = activitySignature;
    if (inactiveTurns >= PRODUCTION_AGENT_MAX_INACTIVE_TURNS) {
      const reason = "Production Agent ended three consecutive Turns without tools, progress, or a terminal declaration.";
      const textAssetId = await archiveDecisionFailure(turn.text);
      await recordAgentRunEvent(ctx.runContext.runId, "agent_continuation_exhausted", {
        stage: "decision",
        subAgent: "decisionAgent",
        turnNumber,
        finishReason: turn.finishReason,
        inactiveTurns,
        textAssetId: textAssetId ?? null,
      });
      ctx.runContext.setFailed({
        stage: "decision",
        subAgent: "decisionAgent",
        reason,
        errorJson: { code: "AGENT_NO_PROGRESS", turnNumber },
      });
      break;
    }

    try {
      const continued = await continueProductionAgentContext({
        runId: ctx.runContext.runId,
        modelKey: "productionAgent:decisionAgent",
        think: ctx.thinkConfig.think,
        thinkLevel: ctx.thinkConfig.thinlLevel,
        objective: text,
        context: decisionContext,
        fixedContext: decisionFixedContext,
        turn,
        reason: providerContextOverflow
          ? "provider_context_overflow"
          : contextBoundary
          ? "context_budget_boundary"
          : isRecoverableTurn(turn)
            ? "recoverable_interruption"
            : "missing_terminal_state",
        stage: "decision",
        subAgent: "decisionAgent",
        turnNumber,
        force: providerContextOverflow || Boolean(contextBoundary),
      });
      decisionContext = continued.context;
      if (continued.compacted) ctx.runContext.setContextCheckpoint(continued.context);
    } catch (error) {
      const diagnostic = u.error(error).message;
      const textAssetId = await archiveDecisionFailure(turn.text);
      await recordAgentRunEvent(ctx.runContext.runId, "agent_context_compaction_failed", {
        stage: "decision",
        subAgent: "decisionAgent",
        turnNumber,
        finishReason: turn.finishReason,
        textAssetId: textAssetId ?? null,
        diagnostic,
      });
      ctx.runContext.setFailed({
        stage: "decision",
        subAgent: "decisionAgent",
        reason: "Production Agent could not preserve a bounded continuation checkpoint.",
        errorJson: { code: "AGENT_CONTEXT_COMPACTION_FAILED", turnNumber, diagnostic },
      });
      break;
    }
    await recordAgentRunEvent(ctx.runContext.runId, "agent_turn_continued", {
      fromTurnId: turnId,
      nextTurnNumber: turnNumber + 1,
      reason: providerContextOverflow
        ? "provider_context_overflow"
        : contextBoundary
        ? "context_budget_boundary"
        : isRecoverableTurn(turn)
          ? "recoverable_interruption"
          : "missing_terminal_state",
    });
    ctx.msg = ctx.resTool.newMessage("assistant", "视频策划");
  }

  const finalMemory = ctx.runContext?.terminalIntent?.reason?.trim();
  if (finalMemory) {
    await memory.add("assistant:final", finalMemory, { createTime: Date.now() });
  }
}

async function createSubAgent(
  parentCtx: AgentContext,
  context: { projectInfo: any; modelInfo: string; durationPolicy: Awaited<ReturnType<typeof getVideoModelPolicy>> },
) {
  const { resTool, abortSignal } = parentCtx;
  const { projectInfo, modelInfo } = context;
  const memory = productionMemory(parentCtx.isolationKey);
  const continuationPrompt = buildContinuationPrompt(parentCtx.continuation);
  async function runAgent({
    key,
    prompt,
    system,
    name,
    memoryKey,
    stage,
    subAgent,
    progressTitle,
    tools: extraTools,
    toolNames,
    messages,
    modelKey,
    archiveOutput,
  }: {
    key: `${string}:${string}`;
    modelKey?: Parameters<typeof u.Ai.Text>[0];
    prompt: string;
    system: string;
    name: string;
    memoryKey: string;
    stage: string;
    subAgent: string;
    progressTitle?: string;
    tools?: Record<string, any>;
    toolNames: string[];
    messages?: { role: "user" | "assistant" | "system"; content: string }[];
    archiveOutput?: boolean;
  }) {
    parentCtx.runContext?.markStage(stage, subAgent);
    const resolvedModelKey = modelKey ?? key;
    const baseMessages = messages ?? [{ role: "user" as const, content: prompt }];
    const fixedContext = `${system}\n${baseMessages.map((message) => `${message.role}: ${message.content}`).join("\n")}`;
    let continuationContext = "";
    let turnNumber = 0;
    let inactiveTurns = 0;
    let consecutiveLengthTurns = 0;
    let contextOverflowCount = 0;
    let lastActivitySignature = "";
    let interruptionCount = 0;
    let continuationFailure = false;
    let lastTurn: AgentTurnResult | null = null;
    const transcript: string[] = [];
    const allToolResults: AgentTurnResult["toolResults"] = [];

    while (!parentCtx.runContext?.terminalIntent) {
      turnNumber += 1;
      parentCtx.msg.complete();
      const subMsg = resTool.newMessage("assistant", name);
      const storyboardProgress = progressTitle ? subMsg.thinking(progressTitle) : undefined;
      const modelStreamScope = createAgentModelStreamScope(abortSignal);
      const completion = completionLatch();
      const previousStop = parentCtx.runContext?.requestStop;
      const turnId = u.uuid();
      if (parentCtx.runContext) {
        parentCtx.runContext.requestStop = () => modelStreamScope.abort();
        await recordAgentTurnStarted(parentCtx.runContext.runId, {
          turnId,
          turnNumber,
          messageId: subMsg.id,
          stage,
          subAgent,
          continuedFrom: turnNumber > 1 ? "previous_sub_agent_turn" : null,
        });
      }

      const turnMessages = baseMessages.map((message, index, list) =>
        index === list.length - 1 && message.role === "user"
          ? { ...message, content: continuationContext ? `${message.content}\n\n${continuationContext}` : message.content }
          : message,
      );
      const turnInputGuard = await createProductionAgentTurnInputGuard({
        modelKey: resolvedModelKey,
      });
      let providerContextOverflow = false;

      try {
        const { fullStream } = await u.Ai.Text(
          resolvedModelKey,
          parentCtx.thinkConfig.think,
          parentCtx.thinkConfig.thinlLevel,
        ).stream({
          system,
          messages: turnMessages,
          stopWhen: turnInputGuard.stopWhen,
          abortSignal: modelStreamScope.signal,
          tools: {
            ...extraTools,
            ...useTools({
              resTool,
              msg: subMsg,
              toolsNames: toolNames,
              runContext: parentCtx.runContext,
              continuation: parentCtx.continuation,
              storyboardProgress,
            }),
          },
          onFinish: async (result) => {
            completion.resolve(result);
            if (parentCtx.runContext) {
              await recordAgentModelStreamFinished(parentCtx.runContext.runId, result).catch((error) => {
                console.warn("[productionAgent] failed to record sub-agent model completion:", u.error(error).message);
              });
            }
          },
        });

        lastTurn = await consumeAgentTurn({
          agentName: key,
          fullStream,
          completion: completion.promise,
          initialMsg: subMsg,
          userAbortSignal: abortSignal,
          abortModelStream: modelStreamScope.abort,
          projectId: resTool.data.projectId,
          scriptId: resTool.data.scriptId,
        });
      } catch (error) {
        if (parentCtx.runContext?.terminalIntent && isAbortError(error)) {
          lastTurn = {
            text: parentCtx.runContext.terminalIntent.reason,
            state: "aborted",
            finishReason: "terminal",
            usage: { inputTokens: null, outputTokens: null, totalTokens: null },
            toolCalls: [],
            toolResults: [],
          };
        } else {
          const observed = agentTurnResultFromError(error);
          if (isContextWindowOverflowError(error)) {
            contextOverflowCount = parentCtx.runContext?.recordContextOverflow() ?? contextOverflowCount + 1;
            providerContextOverflow = true;
            lastTurn = observed || {
              text: "",
              state: "interrupted",
              finishReason: "context-overflow",
              usage: { inputTokens: null, outputTokens: null, totalTokens: null },
              toolCalls: [],
              toolResults: [],
            };
            lastTurn.state = "interrupted";
            lastTurn.finishReason = "context-overflow";
          } else if (observed && (observed.state === "interrupted" || isRetryableTransportError(error))) {
            lastTurn = {
              ...observed,
              state: "interrupted",
              finishReason: observed.state === "interrupted" ? observed.finishReason : "transport-error",
            };
          } else {
            throw error;
          }
        }
      } finally {
        storyboardProgress?.complete();
        if (parentCtx.runContext) parentCtx.runContext.requestStop = previousStop;
        modelStreamScope.dispose();
      }

      if (!lastTurn) throw new Error(`${key} ended without a Turn result`);
      const contextBoundary = turnInputGuard.getBoundary();
      if (contextBoundary?.triggerFinishReason) lastTurn.finishReason = contextBoundary.triggerFinishReason;
      if (contextBoundary || isRecoverableTurn(lastTurn)) lastTurn.state = "interrupted";
      if (lastTurn.text.trim()) transcript.push(lastTurn.text);
      allToolResults.push(...lastTurn.toolResults);
      if (parentCtx.runContext) {
        await recordAgentTurnResult(parentCtx.runContext.runId, {
          turnId,
          turnNumber,
          messageId: subMsg.id,
          stage,
          subAgent,
          state: lastTurn.state,
          finishReason: lastTurn.finishReason,
          usage: lastTurn.usage,
          textLength: lastTurn.text.length,
          toolCalls: lastTurn.toolCalls,
          toolResults: lastTurn.toolResults,
        });
        if (contextBoundary) {
          await recordAgentRunEvent(parentCtx.runContext.runId, "agent_turn_context_boundary", {
            turnId,
            turnNumber,
            stage,
            subAgent,
            resourceDeliveries: resourceDeliveryStates(lastTurn, false),
            ...contextBoundary,
          });
        } else if (providerContextOverflow) {
          await recordAgentRunEvent(parentCtx.runContext.runId, "agent_turn_context_boundary", {
            turnId,
            turnNumber,
            messageId: subMsg.id,
            stage,
            subAgent,
            reason: "provider_context_overflow",
            overflowCount: contextOverflowCount,
            capacitySource: turnInputGuard.budget.source,
            resourceDeliveries: resourceDeliveryStates(lastTurn, true),
          });
        }
      }

      if (parentCtx.runContext?.terminalIntent || (!contextBoundary && !isRecoverableTurn(lastTurn))) break;

      if (providerContextOverflow && contextOverflowCount >= 2) {
        continuationFailure = true;
        const checkpoint = String(parentCtx.runContext?.latestContextCheckpoint || "").trim();
        if (!checkpoint) {
          parentCtx.runContext?.setFailed({
            stage,
            subAgent,
            reason: "Production Agent could not preserve a resumable context-overflow checkpoint.",
            errorJson: { code: "AGENT_RESUMABLE_CHECKPOINT_MISSING", turnNumber },
          });
          break;
        }
        const reason = `${key} was interrupted after the provider reported context overflow twice in this Chat.`;
        if (parentCtx.runContext) {
          const resumable = {
            checkpoint,
            stage,
            subAgent,
            sourceRunId: parentCtx.runContext.runId,
            resourceDeliveries: resourceDeliveryStates(lastTurn, true),
            overflow: { count: contextOverflowCount, turnNumber, finishReason: lastTurn.finishReason },
            model: {
              key: resolvedModelKey,
              capacitySource: turnInputGuard.budget.source,
              contextWindowTokens: turnInputGuard.budget.contextWindowTokens,
              safeInputTokens: turnInputGuard.budget.safeInputTokens,
            },
          };
          await recordAgentRunEvent(parentCtx.runContext.runId, "agent_resumable_checkpoint", resumable);
          parentCtx.runContext.setInterrupted({
            stage,
            subAgent,
            reason,
            resultJson: { kind: "agent_resumable_context_overflow", sourceRunId: parentCtx.runContext.runId },
            errorJson: { code: "AGENT_CONTEXT_OVERFLOW_REPEATED", turnNumber, contextOverflowCount },
          });
          parentCtx.runContext.stopForTerminal();
        }
        interruptedOverflowFeedback(resTool);
        break;
      }

      interruptionCount += 1;
      consecutiveLengthTurns = advanceConsecutiveLengthTurns(consecutiveLengthTurns, lastTurn.finishReason);
      if (consecutiveLengthTurns >= PRODUCTION_AGENT_MAX_CONSECUTIVE_LENGTH_TURNS) {
        continuationFailure = true;
        const reason = `${key} stopped after ${consecutiveLengthTurns} consecutive output-limited Turns.`;
        if (parentCtx.runContext) {
          await recordAgentRunEvent(parentCtx.runContext.runId, "agent_continuation_exhausted", {
            stage,
            subAgent,
            turnNumber,
            finishReason: lastTurn.finishReason,
            consecutiveLengthTurns,
          });
          parentCtx.runContext.setFailed({
            stage,
            subAgent,
            reason,
            errorJson: { code: "AGENT_CONSECUTIVE_LENGTH_LIMIT", turnNumber, consecutiveLengthTurns },
          });
          parentCtx.runContext.stopForTerminal();
        }
        break;
      }
      const activitySignature = turnActivitySignature(lastTurn);
      const hasNewActivity = Boolean(activitySignature && activitySignature !== lastActivitySignature);
      inactiveTurns = hasNewActivity ? 0 : inactiveTurns + 1;
      if (activitySignature) lastActivitySignature = activitySignature;
      if (inactiveTurns >= PRODUCTION_AGENT_MAX_INACTIVE_TURNS) {
        continuationFailure = true;
        const reason = `${key} made no tool or progress activity across three continuation Turns`;
        if (parentCtx.runContext) {
          await recordAgentRunEvent(parentCtx.runContext.runId, "agent_continuation_exhausted", {
            stage,
            subAgent,
            turnNumber,
            finishReason: lastTurn.finishReason,
            inactiveTurns,
          });
          parentCtx.runContext.setFailed({
            stage,
            subAgent,
            reason,
            errorJson: { code: "AGENT_NO_PROGRESS", turnNumber, inactiveTurns },
          });
          parentCtx.runContext.stopForTerminal();
        }
        break;
      }
      try {
        const continued = await continueProductionAgentContext({
          runId: parentCtx.runContext?.runId,
          modelKey: resolvedModelKey,
          think: parentCtx.thinkConfig.think,
          thinkLevel: parentCtx.thinkConfig.thinlLevel,
          objective: prompt,
          context: continuationContext,
          fixedContext,
          turn: lastTurn,
          reason: providerContextOverflow
            ? "provider_context_overflow"
            : contextBoundary
              ? "context_budget_boundary"
              : "recoverable_sub_agent_interruption",
          stage,
          subAgent,
          turnNumber,
          force: providerContextOverflow || Boolean(contextBoundary),
        });
        continuationContext = continued.context;
        if (continued.compacted) parentCtx.runContext?.setContextCheckpoint(continued.context);
      } catch (error) {
        continuationFailure = true;
        const diagnostic = u.error(error).message;
        if (parentCtx.runContext) {
          await recordAgentRunEvent(parentCtx.runContext.runId, "agent_context_compaction_failed", {
            stage,
            subAgent,
            turnNumber,
            finishReason: lastTurn.finishReason,
            diagnostic,
          });
          parentCtx.runContext.setFailed({
            stage,
            subAgent,
            reason: "Production Agent could not preserve a bounded continuation checkpoint.",
            errorJson: { code: "AGENT_CONTEXT_COMPACTION_FAILED", turnNumber, diagnostic },
          });
          parentCtx.runContext.stopForTerminal();
        }
        break;
      }
      if (parentCtx.runContext) {
        await recordAgentRunEvent(parentCtx.runContext.runId, "agent_turn_continued", {
          fromTurnId: turnId,
          nextTurnNumber: turnNumber + 1,
          stage,
          subAgent,
          reason: providerContextOverflow
            ? "provider_context_overflow"
            : contextBoundary
              ? "context_budget_boundary"
              : "recoverable_sub_agent_interruption",
        });
      }
      parentCtx.msg = resTool.newMessage("assistant", "视频策划");
    }

    const fullTranscript = transcript.join("\n\n");
    let outputAssetId: number | undefined;
    if (fullTranscript.trim() && (archiveOutput === true || continuationFailure || fullTranscript.length > 4000)) {
      try {
        outputAssetId = await archiveProductionAgentTranscript({
          runId: parentCtx.runContext?.runId,
          projectId: Number(resTool.data.projectId),
          scriptId: resTool.data.scriptId == null ? null : Number(resTool.data.scriptId),
          agentKey: key,
          stage,
          subAgent,
          name,
          content: fullTranscript,
        });
      } catch (err) {
        console.warn("[productionAgent] failed to archive long output", err);
      }
    }

    parentCtx.msg = resTool.newMessage("assistant", "视频策划");
    if (parentCtx.runContext?.terminalIntent) parentCtx.runContext.stopForTerminal();
    return {
      text: lastTurn?.text || "",
      finishReason: lastTurn?.finishReason || "unknown",
      toolResults: allToolResults,
      interruptionCount,
      ...(outputAssetId ? { outputAssetId } : {}),
    } satisfies SubAgentTaskResult;
  }

  const promptInput = z
    .object({
      prompt: z.string().describe("交给子Agent的完整任务说明；审核返修需包含正式版本、完整问题范围和保留要求"),
    })
    .toJSONSchema();

  async function runStoryboardTableReview(input: {
    executionPrompt: string;
    executionSummary: string;
    generationId: string;
    revision: number;
  }) {
    const startedAt = Date.now();
    const projectId = Number(resTool.data.projectId);
    const scriptId = Number(resTool.data.scriptId);
    if (parentCtx.runContext) {
      await recordAgentRunEvent(parentCtx.runContext.runId, "storyboard_table_review_started", { projectId, scriptId });
    }
    const reviewStage = await loadProductionStage({
      stage: "supervisionStoryboardTable",
      artStyle: projectInfo.artStyle || "",
      directorManual: projectInfo.directorManual || "",
    });
    const reviewPrompt = `
请对刚刚提交的正式分镜表执行独立只读审核。审核对象必须锁定为 generationId=${input.generationId}、revision=${input.revision} 的正式结构化字段；先读取这个指定版本，再读取 script、scriptPlan 和 assets 作为上游依据，不得混用其他版本。

本轮执行指令：
${input.executionPrompt}

本轮执行摘要：
${input.executionSummary}

以上两项只用于识别本轮返修范围和执行意图；当前正式 generation/revision 中实际存在的字段才是审核对象。若这是返修复核，读取上一轮完整审核报告，逐项区分已修复、仍存在、返修回归和历史漏检。

审核完成并归并后，必须只用一次 record_storyboard_table_review 保存本轮完整问题清单；即使没有问题也提交 items: []。逐镜问题只传正式分镜的 storyboardIndex；不得把 generation 行内部 ID 或 index+1 猜作 storyboardId，服务端会按 index 解析。全局问题仍使用 scope=global。这是内部持久化步骤，最终回复绝对不要提及工具名、JSON、数据库或下一次工具调用。不得修改任何分镜。最终回复只给简洁结论、异常/风险和需要用户决定的问题，不逐镜罗列通过项。

保存审核报告后，必须调用 await_user_decision，用自然语言向用户说明本次仅完成检查、尚未改动正式分镜，并等待用户决定是否调整、保留或指定其他版本/范围。`;
    const response = await runAgent({
      key: "productionAgent:supervisionStoryboardTableAgent",
      modelKey: "productionAgent:supervisionAgent",
      prompt: reviewPrompt,
      system: reviewStage.workflow,
      name: "监制",
      memoryKey: "assistant:supervision:storyboardTable",
      stage: "supervisionStoryboardTable",
      subAgent: "supervisionStoryboardTableAgent",
      messages: [
        { role: "assistant", content: reviewStage.prompt + `\n${modelInfo}` },
        { role: "user", content: reviewPrompt },
      ],
      tools: reviewStage.tools,
      toolNames: reviewStage.definition.tools,
      archiveOutput: true,
    });
    const reviewRecorded = parentCtx.runContext
      ? await u
          .db("o_agentRunEvent")
          .where({ runId: parentCtx.runContext.runId, eventType: "storyboard_table_review_recorded" })
          .where("createdAt", ">=", startedAt)
          .first("createdAt", "payloadJson")
      : null;
    if (!reviewRecorded) {
      throw new Error("Storyboard table review ended without recording its audit report.");
    }
    return { response };
  }

  //衍生资产分析与信息写入
  const run_sub_agent_derive_assets = tool({
    description: "运行执行subAgent来完成衍生资产分析与信息写入相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const stage = await loadProductionStage({
        stage: "deriveAssets",
        artStyle: projectInfo.artStyle || "",
        directorManual: projectInfo.directorManual || "",
      });
      const toolNames = [...stage.definition.tools, "del_deriveAsset"];
      const response = await runAgent({
        key: "productionAgent:deriveAssetsAgent",
        prompt,
        system: stage.workflow,
        name: "执行导演",
        memoryKey: "assistant:execution",
        stage: "deriveAssets",
        subAgent: "deriveAssetsAgent",
        messages: [
          { role: "assistant", content: modelInfo },
          { role: "user", content: prompt },
        ],
        tools: stage.tools,
        toolNames,
      });
      return response;
    },
  });

  //衍生资产图片生成
  const run_sub_agent_generate_assets = tool({
    description: "运行执行subAgent来完成衍生资产图片生成相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const stage = await loadProductionStage({
        stage: "generateAssets",
        artStyle: projectInfo.artStyle || "",
        directorManual: projectInfo.directorManual || "",
      });
      return runAgent({
        key: "productionAgent:generateAssetsAgent",
        prompt,
        system: stage.workflow,
        name: "执行导演",
        memoryKey: "assistant:execution",
        stage: "generateAssets",
        subAgent: "generateAssetsAgent",
        messages: [
          { role: "assistant", content: modelInfo },
          { role: "user", content: prompt },
        ],
        tools: stage.tools,
        toolNames: stage.definition.tools,
      });
    },
  });

  //拍摄计划
  const run_sub_agent_director_plan = tool({
    description: "运行执行subAgent来完成导演规划相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const startedAt = Date.now();
      const stage = await loadProductionStage({
        stage: "directorPlan",
        artStyle: projectInfo.artStyle || "",
        directorManual: projectInfo.directorManual || "",
      });

      const projectContextPrompt = await buildDirectorProjectContextPrompt(Number(resTool.data.projectId));
      const directorPromptContext = projectContextPrompt;

      const response = await runAgent({
        key: "productionAgent:directorPlanAgent",
        prompt,
        system: stage.workflow,
        name: "执行导演",
        memoryKey: "assistant:execution",
        stage: "directorPlan",
        subAgent: "directorPlanAgent",
        messages: [
          { role: "assistant", content: stage.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt + directorPromptContext },
        ],
        tools: stage.tools,
        toolNames: stage.definition.tools,
      });
      const generation = await getDirectorPlanGenerationState(
        Number(resTool.data.projectId),
        Number(resTool.data.scriptId),
      );
      const current = generation.current;
      if (current?.state === "committed" && current.textAssetId && Number(current.updatedAt) >= startedAt) {
        return JSON.stringify({
          status: "committed",
          generationId: current.generationId,
          textAssetId: current.textAssetId,
          version: current.version,
          summary: subAgentText(response).trim().slice(0, 1000),
        });
      }
      return JSON.stringify({
        status: current?.state || "failed",
        generationId: current?.generationId || null,
        error: generation.lastFailure?.errorJson || "Director plan was not committed in this execution.",
      });
    },
  });

  //分镜图生成
  const run_sub_agent_storyboard_gen = tool({
    description: "运行执行subAgent来完成分镜图生成相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      // eslint-disable-next-line no-constant-condition
      if (false) {
        return "分镜面板刚刚写入完成。必须先等待用户明确确认，不能在同一轮自动启动分镜图生成。请询问用户是否生成分镜图。";
      }
      const confirmedFromRecentPrompt =
        isShortConfirmation(parentCtx.text) && recentlyAskedStoryboardImageGeneration(await memory.get(parentCtx.text));
      void confirmedFromRecentPrompt;
      // eslint-disable-next-line no-constant-condition
      if (false) {
        return "未检测到用户本轮明确确认生成分镜图。不能自动启动分镜图生成；请先询问用户是否生成分镜图。";
      }
      const stage = await loadProductionStage({
        stage: "storyboardGenerate",
        artStyle: projectInfo.artStyle || "",
        directorManual: projectInfo.directorManual || "",
      });
      return runAgent({
        key: "productionAgent:storyboardGenAgent",
        prompt,
        system: stage.workflow,
        name: "执行导演",
        memoryKey: "assistant:execution",
        stage: "storyboardGenerate",
        subAgent: "storyboardGenAgent",
        messages: [
          { role: "assistant", content: modelInfo },
          { role: "user", content: prompt },
        ],
        tools: stage.tools,
        toolNames: stage.definition.tools,
      });
    },
  });

  // const mainSkills: { path: string; name: string; description: string }[] = [];
  // for (const skill of mainSkill) {
  //   const skillPath = path.join(rootDir, skill + ".md");
  //   if (!fs.existsSync(skillPath)) throw new Error(`主技能文件不存在: ${skillPath}`);
  //   if (!isPathInside(skillPath, normalizedRootDir)) throw new Error(`技能名称无效：检测到路径穿越。${skillPath}`);
  //   const content = await fs.promises.readFile(skillPath, "utf-8");
  //   const parsed = parseFrontmatter(content);
  //   mainSkills.push({ path: skillPath, ...parsed });
  // }

  //分镜面板写入
  const run_sub_agent_storyboard_panel = tool({
    description: "运行执行subAgent来完成分镜面板写入相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const stage = await loadProductionStage({
        stage: "storyboardPanel",
        artStyle: projectInfo.artStyle || "",
        directorManual: projectInfo.directorManual || "",
      });

      const panelPromptV3 = `

Storyboard panel derivation must use only version-native formal facts. Read targets first, then read sources with the returned snapshotId.
- For V3, select the earliest explicit, visible state from shotDescription that can naturally start the later action. A state necessarily implied by the first action may be used, but do not invent precise position, direction, layout, appearance, or later results.
- Bind only the requiredAssets that are actually visible in that selected opening frame. A person or object entering later must not be included.
- For historical V1/V2, use picture as the static opening source without synthesizing a V3 description.
- If a ready V3 source cannot yield a trustworthy opening frame, call update_storyboard_panel with shouldGenerateImage=false and report an upstream storyboard-table issue. Do not repair formal facts here.
- Write only prompt, shouldGenerateImage and associateAssetsIds with update_storyboard_panel. Never rewrite tableRowJson or factRevision.
- Do not call get_flowData("storyboard") and do not output complete storyboard JSON.
`;

      const response = await runAgent({
        key: "productionAgent:storyboardPanelAgent",
        prompt,
        system:
          stage.workflow +
          panelPromptV3 +
          "\n\n完成后必须停止，等待用户明确确认后才允许进入分镜图生成阶段；不得自行启动分镜图生成。",
        name: "执行导演",
        memoryKey: "assistant:execution",
        stage: "storyboardPanel",
        subAgent: "storyboardPanelAgent",
        messages: [
          { role: "assistant", content: stage.prompt + `\n${modelInfo}` },
          {
            role: "user",
            content:
              prompt +
              panelPromptV3 +
              "\n\n完成后必须停止，等待用户明确确认后才允许进入分镜图生成阶段；不得自行启动分镜图生成。",
          },
        ],
        tools: stage.tools,
        toolNames: stage.definition.tools,
      });
      return response;
    },
  });

  let storyboardPanelReviewFailure: string | null = null;
  const run_storyboard_panel_review = tool({
    description:
      "Run one complete, read-only, structured storyboard-panel review against the current frozen facts. This capability never repairs panel data and never changes the Agent Run lifecycle.",
    inputSchema: jsonSchema<Record<string, never>>(z.object({}).toJSONSchema()),
    execute: async () => {
      if (storyboardPanelReviewFailure) throw new Error(storyboardPanelReviewFailure);
      let review: Awaited<ReturnType<typeof runStoryboardPanelSingleReview>>;
      try {
        review = await runStoryboardPanelSingleReview({
          projectId: Number(resTool.data.projectId),
          scriptId: Number(resTool.data.scriptId),
          modelKey: "productionAgent:supervisionAgent",
          think: parentCtx.thinkConfig.think,
          thinkLevel: parentCtx.thinkConfig.thinlLevel,
        });
      } catch (error) {
        const diagnostic = storyboardPanelSingleReviewFailureDetails(error);
        storyboardPanelReviewFailure = `STORYBOARD_PANEL_REVIEW_FAILED: ${diagnostic.message}`;
        if (parentCtx.runContext) {
          await recordAgentRunEvent(parentCtx.runContext.runId, "storyboard_panel_single_review_failed", {
            stage: "supervisionStoryboardPanel",
            subAgent: "supervisionStoryboardPanelAgent",
            diagnostic,
          });
        }
        throw new Error(storyboardPanelReviewFailure);
      }
      await runLazyRetentionCleanup();
      const content = JSON.stringify(review.result, null, 2);
      const asset = await createTextAsset({
        projectId: Number(resTool.data.projectId),
        scriptId: Number(resTool.data.scriptId),
        targetType: "agentOutput",
        targetId: `storyboardPanelReview:${parentCtx.runContext?.runId || Date.now()}`,
        content,
        summary: `Storyboard panel structured review (${review.result.items.length} issues)`,
        state: "complete",
      });
      if (parentCtx.runContext) {
        await recordAgentRunEvent(parentCtx.runContext.runId, "storyboard_panel_single_review_recorded", {
          stage: "supervisionStoryboardPanel",
          subAgent: "supervisionStoryboardPanelAgent",
          textAssetId: asset.id,
          snapshotId: review.bundle.snapshotId,
          total: review.bundle.total,
          issueCount: review.result.items.length,
          modelFinishReason: review.model.finishReason,
          usage: review.model.usage,
        });
      }
      return {
        snapshotId: review.bundle.snapshotId,
        total: review.bundle.total,
        reviewAssetId: asset.id,
        result: review.result,
      };
    },
  });

  //分镜表写入
  const run_sub_agent_storyboard_table = tool({
    description: "运行执行subAgent来完成分镜表构建相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const startedAt = Date.now();
      parentCtx.runContext?.markStage("storyboardTable", "storyboardTableAgent");
      const stage = await loadProductionStage({
        stage: "storyboardTable",
        artStyle: projectInfo.artStyle || "",
        directorManual: projectInfo.directorManual || "",
      });

      const storyboardV3Prompt = `

Write the formal storyboard table only through the structured tools. New rows must be StoryboardTableRow version 3 and must use one chronological shotDescription; picture, action, characters, visibleEmotion, groupName and groupIntent are forbidden in V3 rows.
Execution order:
1. Read the complete upstream facts once. Decide shot boundaries and video groups, then call prepare_storyboard_table with only status, summary, shots[{index, estimatedDurationSec}] and groups.
2. If prepare returns ready, call begin_storyboard_table without repeating row count or groups.
3. Append V3 rows from index 0 in batches of 5-10, following the backend nextIndex.
4. Commit once for the current generation after all rows are accepted, then call inspect_storyboard_table_change before concluding the stage. Interpret the returned facts against the user's objective yourself. If the committed result does not match that objective, read the needed formal versions, call prepare_storyboard_table again, and write a new generation before inspecting again.
shotDescription must follow natural time order: earliest visible state -> trigger -> continuous visible change -> ending state. It may state a precondition necessarily implied by the first action or explicitly handed off by the adjacent formal shot, but must not invent exact blocking, layout, appearance, later entrants or completed results.
Choose shot boundaries by the actual change of visual subject, information recipient, causal action or time/space condition. Do not split one continuous action for decorative shot-size changes, and do not combine independent actions merely to fill the model duration limit. Dialogue, necessary pauses and visible action must fit durationSec without unsupported acceleration.
`;

      const storyboardTableRules =
        "\n\n分镜组规则：分镜组是一次视频生成单元，不是场次。单个场次可拆为多个分镜组；每组 storyboardIndexes 必须连续递增；每组 durationSec 总和必须小于等于上方模型信息里的默认视频模型最大支持时长。跨场景、跨时间、跨连续事件目标或跨戏剧功能时必须新建分镜组。";

      const commitFailureRules =
        "\n\nCommit failure handling: if commit_storyboard_table returns status=invalid, do not retry any storyboard write tool in this run. Explain every returned issue in user-facing language, offer concrete adjustment choices, then call await_user_decision. If it returns status=failed, stop immediately and report the failure. Never start a new generation in the same execution turn.";

      const response = await runAgent({
        key: "productionAgent:storyboardTableAgent",
        prompt,
        system: stage.workflow + storyboardV3Prompt + storyboardTableRules + commitFailureRules,
        name: "执行导演",
        memoryKey: "assistant:execution",
        stage: "storyboardTable",
        subAgent: "storyboardTableAgent",
        progressTitle: "正在整理剧情与镜头节奏...",
        messages: [
          { role: "assistant", content: stage.prompt + `\n${modelInfo}` + continuationPrompt },
          {
            role: "user",
            content: prompt + storyboardV3Prompt + storyboardTableRules + commitFailureRules + continuationPrompt,
          },
        ],
        tools: stage.tools,
        toolNames: stage.definition.tools,
      });
      if (parentCtx.runContext?.terminalIntent) return response;

      const prepareAttempt = parentCtx.runContext
        ? await u
            .db("o_agentRunEvent")
            .where({ runId: parentCtx.runContext.runId, eventType: "storyboard_prepare_started" })
            .where("createdAt", ">=", startedAt)
            .first("id")
        : null;
      if (!prepareAttempt) {
        const code = "STORYBOARD_EXECUTION_NO_WRITE_ATTEMPT";
        const reason = "Storyboard execution ended before prepare_storyboard_table was called; no database, network, append, or commit failure occurred.";
        if (parentCtx.runContext) {
          await recordAgentRunEvent(parentCtx.runContext.runId, "storyboard_execution_no_write_attempt", { code });
          parentCtx.runContext.setFailed({
            stage: "storyboardTable",
            subAgent: "storyboardTableAgent",
            reason,
            errorJson: { code, phase: "prepare", message: reason },
          });
          parentCtx.runContext.stopForTerminal();
        }
        return `${subAgentText(response)}\n\n${code}: ${reason}`;
      }

      const committedGeneration = await u
        .db("o_storyboardGeneration")
        .where({
          projectId: Number(resTool.data.projectId),
          scriptId: Number(resTool.data.scriptId),
          state: "committed",
        })
        .where("updatedAt", ">=", startedAt)
        .orderBy("updatedAt", "desc")
        .first("generationId", "revision", "updatedAt");
      if (!committedGeneration) {
        return `${subAgentText(response)}\n\n分镜表尚未成功提交，未启动审核。请确认是否继续调整或重新生成。`;
      }

      let reviewResponse: string;
      try {
        const review = await runStoryboardTableReview({
          executionPrompt: prompt,
          executionSummary: summarizeAgentReason(subAgentText(response)),
          generationId: String(committedGeneration.generationId),
          revision: Number(committedGeneration.revision || 0),
        });
        reviewResponse = subAgentText(review.response);
      } catch (error: any) {
        const reason = `Storyboard table was committed, but its independent review failed: ${u.error(error).message}`;
        if (parentCtx.runContext) {
          await recordAgentRunEvent(parentCtx.runContext.runId, "storyboard_table_review_failed", {
            projectId: Number(resTool.data.projectId),
            scriptId: Number(resTool.data.scriptId),
            generationId: String(committedGeneration.generationId),
            reason,
          });
        }
        parentCtx.runContext?.setFailed({
          stage: "supervisionStoryboardTable",
          subAgent: "supervisionStoryboardTableAgent",
          reason,
          errorJson: { message: u.error(error).message },
          resultJson: {
            source: "supervisionStoryboardTable",
            generationId: String(committedGeneration.generationId),
            revision: Number(committedGeneration.revision || 0),
            retryTarget: "storyboardTableReview",
          },
        });
        parentCtx.runContext?.stopForTerminal();
        return `${subAgentText(response)}\n\n分镜表已提交，但独立审核未成功启动或未落库。分镜事实已保留；请重试审核，不需要重写分镜表。`;
      }
      return `${subAgentText(response)}\n\n${reviewResponse}`;
    },
  });

  const run_sub_agent_supervision = tool({
    description: "运行监督层subAgent执行独立任务，完成后返回结果",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const stage = await loadProductionStage({
        stage: productionSupervisionStage(prompt),
        artStyle: projectInfo.artStyle || "",
        directorManual: projectInfo.directorManual || "",
      });
      const response = await runAgent({
        key: "productionAgent:supervisionAgent",
        prompt,
        system: stage.workflow,
        name: "监制",
        memoryKey: "assistant:supervision",
        stage: productionSupervisionStage(prompt),
        subAgent: "supervisionAgent",
        messages: [
          { role: "assistant", content: stage.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt },
        ],
        tools: stage.tools,
        toolNames: stage.definition.tools,
        archiveOutput: true,
      });
      return response;
    },
  });

  return {
    run_sub_agent_derive_assets,
    run_sub_agent_generate_assets,
    run_sub_agent_director_plan,
    run_sub_agent_storyboard_gen,
    run_sub_agent_storyboard_panel,
    run_storyboard_panel_review,
    run_sub_agent_storyboard_table,
    run_sub_agent_supervision,
  };
}

function removeAllXmlTags(text: string): string {
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "");
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "");
  text = text.replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "");
  return text.trim();
}

function summarizeAgentReason(text: string) {
  const cleaned = removeAllXmlTags(text).replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 2000) || "Agent review completed.";
}
