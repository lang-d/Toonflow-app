import jwt from "jsonwebtoken";
import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/productionAgent/index";
import ResTool from "@/socket/resTool";
import {
  AGENT_RUN_HEARTBEAT_INTERVAL_MS,
  createAgentRun,
  createAgentRunContext,
  finishAgentRun,
  getActiveAgentRun,
  getLatestAgentRun,
  getResumableAgentInterruption,
  getUnresolvedAgentDecision,
  interruptExpiredAgentRuns,
  recordAgentRunEvent,
  updateAgentRunHeartbeat,
  type AgentRunContext,
  type AgentRunStatus,
} from "@/services/agentRun";
import {
  clearProductionAgentRunControl,
  registerProductionAgentRunControl,
  stopProductionAgentRunControl,
} from "@/services/productionAgentRunRegistry";

type ProductionAgentChatRequest = {
  content?: unknown;
};

type ProductionAgentChatRejectionCode =
  | "INVALID_CHAT_MESSAGE"
  | "RUN_ALREADY_RUNNING"
  | "CHAT_STATE_RESTORE_FAILED"
  | "CHAT_ACCEPT_FAILED";

async function verifyToken(rawToken: string): Promise<Boolean> {
  const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
  if (!setting) return false;
  const { value: tokenKey } = setting;
  if (!rawToken) return false;
  const token = rawToken.replace("Bearer ", "");
  try {
    jwt.verify(token, tokenKey as string);
    return true;
  } catch (err) {
    return false;
  }
}

type ProductionAgentSocketContext = {
  isolationKey: string;
  projectId: number;
  scriptId: number;
};

function productionAgentRoom(context: ProductionAgentSocketContext) {
  return `productionAgent:${context.projectId}:${context.scriptId}`;
}

async function validateProductionAgentContext(input: any): Promise<ProductionAgentSocketContext> {
  const projectId = Number(input?.projectId);
  const scriptId = Number(input?.scriptId);
  const isolationKey = String(input?.isolationKey || "");
  if (!Number.isFinite(projectId) || !Number.isFinite(scriptId) || !isolationKey) {
    throw new Error("invalid production agent context");
  }
  const expectedIsolationKey = `${projectId}:productionAgent:${scriptId}`;
  if (isolationKey !== expectedIsolationKey) {
    throw new Error(`production agent isolationKey mismatch: expected ${expectedIsolationKey}`);
  }
  const script = await u.db("o_script").where({ id: scriptId, projectId }).first("id");
  if (!script) {
    throw new Error(`script ${scriptId} does not belong to project ${projectId}`);
  }
  return { isolationKey, projectId, scriptId };
}

export default (nsp: Namespace) => {
  void interruptExpiredAgentRuns().catch((error) => {
    console.warn("[productionAgent] failed to recover expired runs:", u.error(error).message);
  });

  nsp.on("connection", async (socket: Socket) => {
    const token = socket.handshake.auth.token;
    if (!token || !(await verifyToken(token))) {
      console.log("[productionAgent] connection rejected: invalid token");
      socket.disconnect();
      return;
    }

    let context: ProductionAgentSocketContext;
    try {
      context = await validateProductionAgentContext(socket.handshake.auth);
    } catch (error) {
      console.log("[productionAgent] connection rejected:", u.error(error).message);
      socket.disconnect();
      return;
    }

    console.log("[productionAgent] connected:", socket.id, context.isolationKey);
    socket.join(productionAgentRoom(context));

    const createScopedResTool = (targetContext: ProductionAgentSocketContext) =>
      new ResTool(
        {
          emit: (event: string, ...args: any[]) => nsp.to(productionAgentRoom(targetContext)).emit(event, ...args),
        } as unknown as Socket,
        {
          projectId: targetContext.projectId,
          scriptId: targetContext.scriptId,
        },
      );

    let resTool = createScopedResTool(context);
    let abortController: AbortController | null = null;
    let currentRunContext: AgentRunContext | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    const runUpdatePayload = (
      payload: Record<string, unknown>,
      targetContext: ProductionAgentSocketContext = context,
    ) => ({
      agentKey: "productionAgent",
      projectId: targetContext.projectId,
      scriptId: targetContext.scriptId,
      serverTime: Date.now(),
      ...payload,
    });

    const emitRunUpdate = (
      payload: Record<string, unknown>,
      targetContext: ProductionAgentSocketContext = context,
    ) => {
      socket.emit("agent:run:update", runUpdatePayload(payload, targetContext));
    };

    const broadcastRunUpdate = (
      payload: Record<string, unknown>,
      targetContext: ProductionAgentSocketContext = context,
    ) => {
      nsp
        .to(productionAgentRoom(targetContext))
        .emit("agent:run:update", runUpdatePayload(payload, targetContext));
    };

    const emitChatRejected = (
      targetContext: ProductionAgentSocketContext,
      input: {
        code: ProductionAgentChatRejectionCode;
        reason: string;
        activeRun?: Awaited<ReturnType<typeof getActiveAgentRun>>;
      },
    ) => {
      emitRunUpdate(
        {
          rejected: true,
          code: input.code,
          reason: input.reason,
          ...(input.activeRun ? { status: input.activeRun.status, activeRun: input.activeRun } : {}),
        },
        targetContext,
      );
    };

    const restoreRunState = async (targetContext: ProductionAgentSocketContext) => {
      const scope = {
        agentKey: "productionAgent",
        projectId: targetContext.projectId,
        scriptId: targetContext.scriptId,
      };
      const activeRun = await getActiveAgentRun(scope);
      if (activeRun) {
        void recordAgentRunEvent(activeRun.runId, "client_resumed", {
          socketId: socket.id,
          isolationKey: targetContext.isolationKey,
        });
        emitRunUpdate({ status: activeRun.status, activeRun, resumed: true }, targetContext);
        return;
      }
      const latestRun = await getLatestAgentRun(scope);
      if (latestRun) {
        emitRunUpdate(
          {
            status: latestRun.status,
            run: latestRun,
            latestRun,
            resumed: false,
            terminal: latestRun.status !== "running",
          },
          targetContext,
        );
      }
    };

    type RunStateRestoreOutcome = {
      context: ProductionAgentSocketContext;
      error: Error | null;
    };

    const beginRunStateRestore = async (targetContext: ProductionAgentSocketContext): Promise<RunStateRestoreOutcome> => {
      try {
        await restoreRunState(targetContext);
        return { context: targetContext, error: null };
      } catch (error) {
        const normalizedError = u.error(error);
        console.warn("[productionAgent] failed to restore run state:", normalizedError.message);
        return { context: targetContext, error: normalizedError };
      }
    };

    let runStateRestorePromise = beginRunStateRestore(context);

    const waitForRunStateRestore = async (
      targetContext: ProductionAgentSocketContext,
      restorePromise: Promise<RunStateRestoreOutcome> = runStateRestorePromise,
    ) => {
      const outcome = await restorePromise;
      if (outcome.context.isolationKey !== targetContext.isolationKey) {
        throw new Error("production agent context changed while restoring run state");
      }
      if (outcome.error) throw outcome.error;
    };

    socket.on("updateContext", async (data: { isolationKey: string; projectId: number; scriptId: number }, callback) => {
      try {
        const nextContext = await validateProductionAgentContext(data);
        const previousContext = context;
        const previousRestorePromise = runStateRestorePromise;
        await waitForRunStateRestore(previousContext, previousRestorePromise);
        if (context.isolationKey !== previousContext.isolationKey) {
          throw new Error("production agent context changed while updating context");
        }
        if (abortController && nextContext.isolationKey !== context.isolationKey) {
          throw new Error("production agent is running; stop it before switching context");
        }
        if (nextContext.isolationKey === context.isolationKey) {
          callback?.({ success: true });
          return;
        }
        socket.leave(productionAgentRoom(context));
        context = nextContext;
        socket.join(productionAgentRoom(context));
        resTool = createScopedResTool(context);
        console.log("[productionAgent] context updated:", context.isolationKey);
        runStateRestorePromise = beginRunStateRestore(context);
        await waitForRunStateRestore(context, runStateRestorePromise);
        callback?.({ success: true });
      } catch (error) {
        callback?.({ success: false, message: u.error(error).message });
      }
    });

    const clearHeartbeat = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    };

    socket.on("chat", async (data: ProductionAgentChatRequest) => {
      const chatContext = context;
      const chatRestorePromise = runStateRestorePromise;
      const chatResTool = resTool;
      const content = typeof data?.content === "string" ? data.content : "";

      try {
        await waitForRunStateRestore(chatContext, chatRestorePromise);
        if (context.isolationKey !== chatContext.isolationKey) {
          throw new Error("production agent context changed before the chat was accepted");
        }
      } catch (error) {
        emitChatRejected(chatContext, {
          code: "CHAT_STATE_RESTORE_FAILED",
          reason: `Production Agent 未能恢复当前运行状态：${u.error(error).message}`,
        });
        return;
      }

      if (!content.trim()) {
        emitChatRejected(chatContext, { code: "INVALID_CHAT_MESSAGE", reason: "消息内容不能为空。" });
        return;
      }

      let activeRun = null;
      try {
        activeRun = await getActiveAgentRun({
          agentKey: "productionAgent",
          projectId: chatContext.projectId,
          scriptId: chatContext.scriptId,
        });
      } catch (error) {
        emitChatRejected(chatContext, {
          code: "CHAT_ACCEPT_FAILED",
          reason: `Production Agent 未能确认当前运行状态：${u.error(error).message}`,
        });
        return;
      }
      if (activeRun) {
        const reason = "同一剧集已有运行中的 Production Agent 对话，请等待完成或手动停止后再提交。";
        emitChatRejected(chatContext, { code: "RUN_ALREADY_RUNNING", reason, activeRun });
        return;
      }
      const continuationScope = {
        agentKey: "productionAgent",
        projectId: chatContext.projectId,
        scriptId: chatContext.scriptId,
      };
      let awaitingUser: Awaited<ReturnType<typeof getUnresolvedAgentDecision>> = null;
      let resumableInterruption: Awaited<ReturnType<typeof getResumableAgentInterruption>> = null;
      try {
        [awaitingUser, resumableInterruption] = await Promise.all([
          getUnresolvedAgentDecision(continuationScope),
          getResumableAgentInterruption({ ...continuationScope, isolationKey: chatContext.isolationKey }),
        ]);
      } catch (error) {
        emitChatRejected(chatContext, {
          code: "CHAT_ACCEPT_FAILED",
          reason: `Production Agent 未能读取续接状态：${u.error(error).message}`,
        });
        return;
      }
      const awaitingContinuation = awaitingUser
        ? { kind: "awaiting_user" as const, ...awaitingUser }
        : null;
      const resumableContinuation = resumableInterruption
        ? { kind: "resumable_interruption" as const, ...resumableInterruption }
        : null;
      const continuation =
        Number(resumableContinuation?.run.startedAt || 0) > Number(awaitingContinuation?.run.startedAt || 0)
          ? resumableContinuation
          : awaitingContinuation;
      abortController = new AbortController();
      const currentController = abortController;

      let msg: ReturnType<ResTool["newMessage"]>;
      try {
        msg = chatResTool.newMessage("assistant", "视频策划");
      } catch (error) {
        abortController = null;
        emitChatRejected(chatContext, {
          code: "CHAT_ACCEPT_FAILED",
          reason: `Production Agent 未能创建本次回复消息：${u.error(error).message}`,
        });
        return;
      }
      let createdRun: Awaited<ReturnType<typeof createAgentRun>>;
      try {
        createdRun = await createAgentRun({
          agentKey: "productionAgent",
          projectId: chatContext.projectId,
          scriptId: chatContext.scriptId,
          isolationKey: chatContext.isolationKey,
          messageId: msg.id,
        });
      } catch (error) {
        msg.error(u.error(error).message);
        abortController = null;
        emitChatRejected(chatContext, {
          code: "CHAT_ACCEPT_FAILED",
          reason: `Production Agent 未能创建本次运行：${u.error(error).message}`,
        });
        return;
      }
      if (!createdRun.created) {
        const reason = "同一剧集已有运行中的 Production Agent 对话，请等待完成或手动停止后再提交。";
        msg.error(reason);
        emitChatRejected(chatContext, {
          code: "RUN_ALREADY_RUNNING",
          reason,
          activeRun: createdRun.activeRun,
        });
        abortController = null;
        return;
      }
      const runContext = createAgentRunContext(createdRun.run.runId);
      if (continuation?.kind === "resumable_interruption") {
        await recordAgentRunEvent(createdRun.run.runId, "agent_run_resumed_from", {
          sourceRunId: continuation.run.runId,
          sourceStatus: continuation.run.status,
          sourceStage: continuation.run.currentStage,
          sourceSubAgent: continuation.run.currentSubAgent,
        });
      }
      currentRunContext = runContext;
      registerProductionAgentRunControl(chatContext.isolationKey, {
        runId: createdRun.run.runId,
        controller: currentController,
        runContext,
      });
      broadcastRunUpdate({ status: "running", run: createdRun.run }, chatContext);
      heartbeatTimer = setInterval(() => {
        void updateAgentRunHeartbeat(createdRun.run.runId).catch((error) => {
          console.warn("[productionAgent] heartbeat failed:", u.error(error).message);
        });
      }, AGENT_RUN_HEARTBEAT_INTERVAL_MS);

      const ctx: agent.AgentContext = {
        socket,
        isolationKey: chatContext.isolationKey,
        text: content,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: currentController.signal,
        resTool: chatResTool,
        msg,
        thinkConfig,
        runContext,
        continuation,
      };

      let finalStatus: AgentRunStatus = "failed";
      let finalReason: string | null = "Agent stream ended without a terminal declaration.";
      let finalError: unknown = { code: "AGENT_TERMINAL_DECLARATION_MISSING" };
      try {
        await agent.runDecisionAI(ctx);
        if (runContext.terminalIntent) {
          finalStatus = runContext.terminalIntent.status;
          finalReason = runContext.terminalIntent.reason;
          finalError = runContext.terminalIntent.errorJson;
        } else {
          await recordAgentRunEvent(createdRun.run.runId, "terminal_declaration_missing", {
            code: "AGENT_TERMINAL_DECLARATION_MISSING",
          });
        }
      } catch (err: any) {
        if (runContext.terminalIntent) {
          finalStatus = runContext.terminalIntent.status;
          finalReason = runContext.terminalIntent.reason;
          finalError = runContext.terminalIntent.errorJson;
        } else if (runContext.abortReason === "user_stop") {
          finalStatus = "cancelled";
          finalReason = "用户已停止当前 Production Agent chat。";
        } else if (err.name === "AbortError" || currentController.signal.aborted) {
          finalStatus = "cancelled";
          finalReason = "Production Agent chat was cancelled.";
        } else {
          finalStatus = "failed";
          finalReason = u.error(err).message;
          finalError = { name: err?.name, message: u.error(err).message };
          console.error("[productionAgent] chat error:", u.error(err).message);
        }
      } finally {
        clearHeartbeat();
        let finished = null;
        try {
          finished = await finishAgentRun(createdRun.run.runId, {
            status: finalStatus,
            reason: finalReason,
            errorJson: finalError,
            resultJson: runContext.terminalIntent?.resultJson,
            currentStage: runContext.terminalIntent?.stage,
            currentSubAgent: runContext.terminalIntent?.subAgent,
          });
        } catch (error) {
          console.error("[productionAgent] failed to persist terminal run status:", u.error(error).message);
        } finally {
          clearProductionAgentRunControl(chatContext.isolationKey, createdRun.run.runId);
          if (abortController === currentController) {
            abortController = null;
          }
          if (currentRunContext === runContext) currentRunContext = null;
        }
        if (finished) {
          broadcastRunUpdate({ status: finished.status, run: finished }, chatContext);
        } else {
          broadcastRunUpdate(
            { status: "running", runId: createdRun.run.runId, terminalPersistenceFailed: true },
            chatContext,
          );
        }
      }
    });

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = data.think;
      thinkConfig.thinlLevel = data.thinlLevel;
      console.log("[productionAgent] think config updated:", thinkConfig);
    });

    socket.on("abort", async (data: { runId?: string }, callback?: (result: any) => void) => {
      try {
        const runId = String(data?.runId || "");
        const activeRun = await getActiveAgentRun({
          agentKey: "productionAgent",
          projectId: context.projectId,
          scriptId: context.scriptId,
        });

        if (!activeRun) {
          callback?.({ accepted: false, code: "NO_ACTIVE_RUN", message: "当前没有可中断的 Production Agent 运行。" });
          return;
        }
        if (!runId || activeRun.runId !== runId) {
          callback?.({ accepted: false, code: "RUN_MISMATCH", runId: activeRun.runId, message: "目标运行已变化，请刷新状态后重试。" });
          return;
        }

        const stopped = stopProductionAgentRunControl(context.isolationKey, runId);
        if (!stopped) {
          await recordAgentRunEvent(runId, "abort_unavailable", { socketId: socket.id, isolationKey: context.isolationKey });
          callback?.({ accepted: false, code: "ABORT_UNAVAILABLE", runId, message: "当前运行无法中断，请稍后刷新状态。" });
          return;
        }

        broadcastRunUpdate({ status: "running", run: activeRun, stopping: true });
        callback?.({ accepted: true, runId, stopping: true });
      } catch (error) {
        callback?.({ accepted: false, code: "ABORT_FAILED", message: `中断请求失败：${u.error(error).message}` });
      }
    });

    socket.on("disconnect", () => {
      console.log("[productionAgent] disconnected:", socket.id);
      if (currentRunContext) {
        void recordAgentRunEvent(currentRunContext.runId, "client_detached", {
          socketId: socket.id,
          isolationKey: context.isolationKey,
        }).catch((error) => console.warn("[productionAgent] failed to record client detach:", u.error(error).message));
      }
    });
  });
};
