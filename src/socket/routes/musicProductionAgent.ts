import jwt from "jsonwebtoken";
import { Namespace, Socket } from "socket.io";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import * as agent from "@/agents/musicProductionAgent/index";
import ResTool from "@/socket/resTool";
import {
  AGENT_RUN_HEARTBEAT_INTERVAL_MS,
  createAgentRun,
  createAgentRunContext,
  finishAgentRun,
  getActiveAgentRun,
  getResumableAgentInterruption,
  getUnresolvedAgentDecision,
  interruptExpiredAgentRuns,
  recordAgentRunEvent,
  updateAgentRunHeartbeat,
  type AgentRunContext,
  type AgentRunStatus,
} from "@/services/agentRun";
import { recordAgentTaskSubmitted } from "@/agents/shared/tools";
import {
  createRunStateRestoreBarrier,
  createSharedAgentResTool,
  sharedAgentRoom,
  sharedAgentRunUpdate,
} from "@/socket/routes/sharedAgentLifecycle";
import {
  musicAgentRunScriptId,
  musicEpisodeIsolationKey,
  musicProjectIsolationKey,
  type MusicScopeInput,
} from "@/services/musicScope";
import {
  clearMusicAgentRunControl,
  registerMusicAgentRunControl,
  stopMusicAgentRunControl,
} from "@/services/musicAgentRunRegistry";
import type { MusicScopeMode } from "@/services/musicDirector";

async function verifyToken(rawToken: string): Promise<boolean> {
  const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
  if (!setting || !rawToken) return false;
  try {
    jwt.verify(rawToken.replace("Bearer ", ""), setting.value as string);
    return true;
  } catch {
    return false;
  }
}

type MusicProductionAgentSocketContext = {
  isolationKey: string;
  projectId: number;
  scriptId: number | null;
  mode: MusicScopeMode;
};

type SubmittedMusicTask = {
  taskId: string;
  targetType: string;
  targetId?: string | number | null;
  legacyTaskId?: number;
  status?: string;
};

function normalizeMode(input: any, scriptId: number | null): MusicScopeMode {
  const mode = String(input?.mode || "");
  if (mode === "concept" || mode === "project" || mode === "episode") return mode;
  return scriptId == null ? "project" : "episode";
}

function expectedIsolationKey(input: Required<Pick<MusicScopeInput, "projectId">> & MusicScopeInput) {
  return input.mode === "episode" && input.scriptId != null
    ? musicEpisodeIsolationKey(input.projectId, Number(input.scriptId))
    : musicProjectIsolationKey(input.projectId);
}

function runScope(context: MusicProductionAgentSocketContext) {
  return {
    agentKey: "musicProductionAgent",
    projectId: context.projectId,
    scriptId: musicAgentRunScriptId(context),
  };
}

function socketScope(context: MusicProductionAgentSocketContext) {
  return {
    projectId: context.projectId,
    scriptId: musicAgentRunScriptId(context),
    isolationKey: context.isolationKey,
  };
}

function musicAgentRoom(context: MusicProductionAgentSocketContext) {
  return sharedAgentRoom("musicProductionAgent", socketScope(context));
}

async function validateMusicProductionAgentContext(input: any): Promise<MusicProductionAgentSocketContext> {
  const projectId = Number(input?.projectId);
  const rawScriptId = input?.scriptId == null || input?.scriptId === "" ? null : Number(input.scriptId);
  const scriptId = Number.isFinite(rawScriptId as number) ? (rawScriptId as number) : null;
  const mode = normalizeMode(input, scriptId);
  if (!Number.isFinite(projectId)) throw new Error("invalid music production projectId");
  if (mode === "episode" && scriptId == null) throw new Error("scriptId is required in episode mode");

  const project = await u.db("o_project").where("id", projectId).first("id");
  if (!project) throw new Error(`project ${projectId} does not exist`);
  if (scriptId != null) {
    const script = await u.db("o_script").where({ id: scriptId, projectId }).first("id");
    if (!script) throw new Error(`script ${scriptId} does not belong to project ${projectId}`);
  }

  const expected = expectedIsolationKey({ projectId, scriptId, mode });
  const isolationKey = String(input?.isolationKey || expected);
  if (isolationKey !== expected) throw new Error(`music production isolationKey mismatch: expected ${expected}`);
  return { isolationKey, projectId, scriptId, mode };
}

function userFacingMusicAgentError(error: unknown) {
  const message = u.error(error).message;
  if (/musicProductionAgent|model/i.test(message)) return `Music production Agent model configuration is unavailable: ${message}`;
  return message || "Music production Agent failed";
}

async function appendTerminalMemory(context: MusicProductionAgentSocketContext, status: AgentRunStatus, submittedTasks: SubmittedMusicTask[], reason?: string | null) {
  if (status === "completed") return;
  const memory = new Memory("musicProductionAgent", context.isolationKey);
  await memory.add("assistant:status", `Music Agent ${status}${reason ? `: ${reason}` : ""}`);
}

export default (nsp: Namespace) => {
  void interruptExpiredAgentRuns().catch((error) => console.warn("[musicProductionAgent] failed to recover expired runs:", u.error(error).message));

  nsp.on("connection", async (socket: Socket) => {
    const token = socket.handshake.auth.token;
    if (!token || !(await verifyToken(token))) {
      console.log("[musicProductionAgent] connection rejected: invalid token");
      socket.disconnect();
      return;
    }

    let context: MusicProductionAgentSocketContext;
    try {
      context = await validateMusicProductionAgentContext(socket.handshake.auth);
    } catch (error) {
      console.log("[musicProductionAgent] connection rejected:", u.error(error).message);
      socket.disconnect();
      return;
    }

    console.log("[musicProductionAgent] connected:", socket.id, context.isolationKey);
    socket.join(musicAgentRoom(context));
    const createScopedResTool = (targetContext: MusicProductionAgentSocketContext) =>
      createSharedAgentResTool(nsp, "musicProductionAgent", socketScope(targetContext), {
        projectId: targetContext.projectId,
        scriptId: targetContext.scriptId,
        mode: targetContext.mode,
      });
    let resTool = createScopedResTool(context);
    const thinkConfig: agent.AgentContext["thinkConfig"] = { think: false, thinlLevel: 0 };

    const emitRunUpdate = (payload: Record<string, unknown>, targetContext: MusicProductionAgentSocketContext = context) => {
      socket.emit("agent:run:update", sharedAgentRunUpdate("musicProductionAgent", socketScope(targetContext), payload));
    };
    const broadcastRunUpdate = (payload: Record<string, unknown>, targetContext: MusicProductionAgentSocketContext = context) => {
      nsp
        .to(musicAgentRoom(targetContext))
        .emit("agent:run:update", sharedAgentRunUpdate("musicProductionAgent", socketScope(targetContext), payload));
    };
    let restoreBarrier = createRunStateRestoreBarrier({
      nsp,
      socket,
      agentKey: "musicProductionAgent",
      scope: socketScope(context),
    });

    socket.on("updateContext", async (data, callback) => {
      try {
        const previousContext = context;
        const previousBarrier = restoreBarrier;
        await previousBarrier.wait(socketScope(previousContext));
        if (context.isolationKey !== previousContext.isolationKey) throw new Error("music production agent context changed while updating context");
        const nextContext = await validateMusicProductionAgentContext(data);
        if (nextContext.isolationKey === previousContext.isolationKey) {
          callback?.({ success: true, isolationKey: context.isolationKey });
          return;
        }
        socket.leave(musicAgentRoom(previousContext));
        context = nextContext;
        socket.join(musicAgentRoom(context));
        resTool = createScopedResTool(context);
        restoreBarrier = createRunStateRestoreBarrier({
          nsp,
          socket,
          agentKey: "musicProductionAgent",
          scope: socketScope(context),
        });
        await restoreBarrier.wait(socketScope(context));
        callback?.({ success: true, isolationKey: context.isolationKey });
      } catch (error) {
        callback?.({ success: false, message: u.error(error).message });
      }
    });

    socket.on("chat", async (data: { content: string }) => {
      const chatContext = context;
      const chatBarrier = restoreBarrier;
      const chatResTool = resTool;
      const content = String(data?.content || "").trim();
      try {
        await chatBarrier.wait(socketScope(chatContext));
        if (context.isolationKey !== chatContext.isolationKey) throw new Error("music production agent context changed before chat acceptance");
      } catch (error) {
        emitRunUpdate(
          { rejected: true, code: "CHAT_STATE_RESTORE_FAILED", reason: u.error(error).message },
          chatContext,
        );
        return;
      }
      if (!content) {
        emitRunUpdate({ rejected: true, code: "INVALID_CHAT_MESSAGE", reason: "消息内容不能为空。" }, chatContext);
        return;
      }

      const accepted = await (async () => {
        const scope = runScope(chatContext);
        const activeRun = await getActiveAgentRun(scope);
        if (activeRun) {
          emitRunUpdate({ status: activeRun.status, activeRun, rejected: true, code: "RUN_ALREADY_RUNNING", reason: "A Music Agent chat is already running for this scope." }, chatContext);
          return null;
        }

        const [awaitingUser, resumableInterruption] = await Promise.all([
          getUnresolvedAgentDecision(scope),
          getResumableAgentInterruption({ ...scope, isolationKey: chatContext.isolationKey }),
        ]);
        const awaitingContinuation = awaitingUser ? { kind: "awaiting_user" as const, ...awaitingUser } : null;
        const resumableContinuation = resumableInterruption
          ? { kind: "resumable_interruption" as const, ...resumableInterruption }
          : null;
        const continuation =
          Number(resumableContinuation?.run.startedAt || 0) > Number(awaitingContinuation?.run.startedAt || 0)
            ? resumableContinuation
            : awaitingContinuation;

        const msg = chatResTool.newMessage("assistant", "Music Director");
        const createdRun = await createAgentRun({ ...scope, isolationKey: chatContext.isolationKey, messageId: msg.id });
        if (!createdRun.created) {
          emitRunUpdate({ status: createdRun.activeRun.status, activeRun: createdRun.activeRun, rejected: true, code: "RUN_ALREADY_RUNNING", reason: "A Music Agent chat is already running for this scope." }, chatContext);
          return null;
        }
        return { continuation, msg, createdRun };
      })().catch((error) => {
        emitRunUpdate({ rejected: true, code: "CHAT_ACCEPT_FAILED", reason: u.error(error).message }, chatContext);
        return null;
      });
      if (!accepted) return;
      const { continuation, msg, createdRun } = accepted;

      const controller = new AbortController();
      const runContext = createAgentRunContext(createdRun.run.runId);
      runContext.bindRootStop(() => controller.abort());
      registerMusicAgentRunControl(chatContext.isolationKey, { runId: createdRun.run.runId, controller, runContext });
      const submittedTasks = new Map<string, SubmittedMusicTask>();
      const heartbeatTimer = setInterval(() => {
        void updateAgentRunHeartbeat(createdRun.run.runId).catch((error) => console.warn("[musicProductionAgent] heartbeat failed:", u.error(error).message));
      }, AGENT_RUN_HEARTBEAT_INTERVAL_MS);

      broadcastRunUpdate({ status: "running", run: createdRun.run }, chatContext);
      const ctx: agent.AgentContext = {
        socket,
        isolationKey: chatContext.isolationKey,
        text: content,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: controller.signal,
        resTool: chatResTool,
        msg,
        thinkConfig,
        runContext,
        continuation,
        onTaskQueued: async (task) => {
          submittedTasks.set(task.taskId, task);
          await recordAgentTaskSubmitted(runContext.runId, task);
        },
      };

      let finalStatus: AgentRunStatus = "failed";
      let finalReason: string | null = "Agent stream ended without a terminal declaration.";
      let finalError: unknown = { code: "AGENT_TERMINAL_DECLARATION_MISSING" };
      try {
        await agent.runDecisionAI(ctx);
        if (runContext.abortReason === "user_stop") {
          finalStatus = "cancelled";
          finalReason = "Music Agent was stopped by the user.";
        } else if (runContext.terminalIntent) {
          finalStatus = runContext.terminalIntent.status;
          finalReason = runContext.terminalIntent.reason;
          finalError = runContext.terminalIntent.errorJson;
        } else {
          await recordAgentRunEvent(createdRun.run.runId, "terminal_declaration_missing", {
            code: "AGENT_TERMINAL_DECLARATION_MISSING",
          });
        }
      } catch (error: any) {
        if (runContext.abortReason === "user_stop") {
          finalStatus = "cancelled";
          finalReason = "Music Agent was stopped by the user.";
        } else if (runContext.terminalIntent) {
          finalStatus = runContext.terminalIntent.status;
          finalReason = runContext.terminalIntent.reason;
          finalError = runContext.terminalIntent.errorJson;
        } else if (controller.signal.aborted) {
          finalStatus = "cancelled";
          finalReason = "Music Agent was stopped by the user.";
        } else {
          finalStatus = "failed";
          finalReason = userFacingMusicAgentError(error);
          finalError = { name: error?.name, message: u.error(error).message };
          ctx.msg.error(finalReason);
          console.error("[musicProductionAgent] chat error:", finalReason);
        }
      } finally {
        clearInterval(heartbeatTimer);
        const taskList = Array.from(submittedTasks.values());
        const terminalResult = runContext.terminalIntent?.resultJson;
        const resultJson =
          terminalResult && typeof terminalResult === "object" && !Array.isArray(terminalResult)
            ? { ...terminalResult, submittedTasks: taskList }
            : { submittedTasks: taskList, terminal: terminalResult ?? null };
        let finished = null;
        try {
          finished = await finishAgentRun(createdRun.run.runId, {
            status: finalStatus,
            reason: finalReason,
            errorJson: finalError,
            resultJson,
            currentStage: runContext.terminalIntent?.stage,
            currentSubAgent: runContext.terminalIntent?.subAgent,
          });
          if (finished) {
            await appendTerminalMemory(chatContext, finalStatus, taskList, finalReason).catch((error) => {
              console.warn("[musicProductionAgent] failed to persist terminal memory:", u.error(error).message);
            });
          }
        } catch (error) {
          console.error("[musicProductionAgent] failed to persist terminal run status:", u.error(error).message);
        } finally {
          clearMusicAgentRunControl(chatContext.isolationKey, createdRun.run.runId);
        }
        if (finished) {
          broadcastRunUpdate({ status: finished.status, run: finished }, chatContext);
        } else {
          broadcastRunUpdate({ status: "running", runId: createdRun.run.runId, terminalPersistenceFailed: true }, chatContext);
        }
      }
    });

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = data.think;
      thinkConfig.thinlLevel = data.thinlLevel;
    });

    socket.on("stop", async () => {
      const stopped = stopMusicAgentRunControl(context.isolationKey);
      if (stopped) {
        emitRunUpdate({ status: "running", runId: stopped.runId, stopping: true });
        return;
      }
      const activeRun = await getActiveAgentRun(runScope(context));
      if (activeRun) {
        await recordAgentRunEvent(activeRun.runId, "stop_unavailable", { socketId: socket.id, isolationKey: context.isolationKey });
        emitRunUpdate({ status: activeRun.status, activeRun, stopUnavailable: true });
      }
    });

    socket.on("disconnect", () => {
      console.log("[musicProductionAgent] disconnected:", socket.id);
      void getActiveAgentRun(runScope(context))
        .then((activeRun) => activeRun && recordAgentRunEvent(activeRun.runId, "client_detached", { socketId: socket.id, isolationKey: context.isolationKey }))
        .catch((error) => console.warn("[musicProductionAgent] failed to record client detach:", u.error(error).message));
    });
  });
};
