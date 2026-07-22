import jwt from "jsonwebtoken";
import { Namespace, Socket } from "socket.io";
import u from "@/utils";
import * as agent from "@/agents/scriptAgent/index";
import ResTool from "@/socket/resTool";
import {
  AGENT_RUN_HEARTBEAT_INTERVAL_MS,
  createAgentRun,
  createAgentRunContext,
  finishAgentRun,
  getActiveAgentRun,
  getLatestAgentRun,
  interruptExpiredAgentRuns,
  recordAgentRunEvent,
  updateAgentRunHeartbeat,
  type AgentRunContext,
  type AgentRunStatus,
} from "@/services/agentRun";
import { SCRIPT_AGENT_KEY, SCRIPT_AGENT_SCRIPT_ID, scriptAgentIsolationKey } from "@/services/scriptAgentWorkspace";

type ScriptAgentSocketContext = {
  projectId: number;
  isolationKey: string;
};

type ActiveExecution = {
  runId: string;
  controller: AbortController;
  runContext: AgentRunContext;
  heartbeatTimer: NodeJS.Timeout;
};

const activeExecutions = new Map<string, ActiveExecution>();

function scopeKey(context: ScriptAgentSocketContext) {
  return `${SCRIPT_AGENT_KEY}:${context.projectId}`;
}

function scriptAgentRoom(context: ScriptAgentSocketContext) {
  return `scriptAgent:${context.projectId}`;
}

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

async function validateContext(input: any): Promise<ScriptAgentSocketContext> {
  const projectId = Number(input?.projectId);
  const isolationKey = String(input?.isolationKey || "");
  if (!Number.isFinite(projectId) || projectId <= 0 || !isolationKey) throw new Error("invalid Script Agent context");
  const expectedIsolationKey = scriptAgentIsolationKey(projectId);
  if (isolationKey !== expectedIsolationKey) throw new Error(`scriptAgent isolationKey mismatch: expected ${expectedIsolationKey}`);
  const project = await u.db("o_project").where({ id: projectId }).first("id");
  if (!project) throw new Error(`project ${projectId} does not exist`);
  return { projectId, isolationKey };
}

export default (nsp: Namespace) => {
  void interruptExpiredAgentRuns().catch((error) => console.warn("[scriptAgent] expired run recovery failed:", u.error(error).message));

  nsp.on("connection", async (socket: Socket) => {
    const token = socket.handshake.auth.token;
    if (!token || !(await verifyToken(token))) {
      socket.disconnect();
      return;
    }

    let context: ScriptAgentSocketContext;
    try {
      context = await validateContext(socket.handshake.auth);
    } catch (error) {
      console.warn("[scriptAgent] connection rejected:", u.error(error).message);
      socket.disconnect();
      return;
    }

    socket.join(scriptAgentRoom(context));

    const scopedResTool = () =>
      new ResTool(
        { emit: (event: string, ...args: any[]) => nsp.to(scriptAgentRoom(context)).emit(event, ...args) } as unknown as Socket,
        { projectId: context.projectId, scriptId: SCRIPT_AGENT_SCRIPT_ID },
      );

    let resTool = scopedResTool();
    const thinkConfig: agent.AgentContext["thinkConfig"] = { think: false, thinlLevel: 0 };

    const runUpdatePayload = (payload: Record<string, unknown>) => ({
      agentKey: SCRIPT_AGENT_KEY,
      projectId: context.projectId,
      scriptId: SCRIPT_AGENT_SCRIPT_ID,
      serverTime: Date.now(),
      ...payload,
    });
    const emitRunUpdate = (payload: Record<string, unknown>) => socket.emit("agent:run:update", runUpdatePayload(payload));
    const broadcastRunUpdate = (payload: Record<string, unknown>) =>
      nsp.to(scriptAgentRoom(context)).emit("agent:run:update", runUpdatePayload(payload));

    const restoreRunState = async () => {
      const scope = { agentKey: SCRIPT_AGENT_KEY, projectId: context.projectId, scriptId: SCRIPT_AGENT_SCRIPT_ID };
      const activeRun = await getActiveAgentRun(scope);
      if (activeRun) {
        await recordAgentRunEvent(activeRun.runId, "client_resumed", { socketId: socket.id, isolationKey: context.isolationKey });
        emitRunUpdate({ status: activeRun.status, activeRun, resumed: true });
        return;
      }
      const latestRun = await getLatestAgentRun(scope);
      if (latestRun) emitRunUpdate({ status: latestRun.status, run: latestRun, latestRun, terminal: latestRun.status !== "running" });
    };

    void restoreRunState().catch((error) => console.warn("[scriptAgent] state restore failed:", u.error(error).message));

    socket.on("updateContext", async (data: any, callback?: (result: any) => void) => {
      try {
        const nextContext = await validateContext(data);
        const activeRun = await getActiveAgentRun({ agentKey: SCRIPT_AGENT_KEY, projectId: context.projectId, scriptId: SCRIPT_AGENT_SCRIPT_ID });
        if (activeRun) throw new Error("Script Agent is running; stop it before switching context");
        socket.leave(scriptAgentRoom(context));
        context = nextContext;
        socket.join(scriptAgentRoom(context));
        resTool = scopedResTool();
        await restoreRunState();
        callback?.({ success: true });
      } catch (error) {
        callback?.({ success: false, message: u.error(error).message });
      }
    });

    socket.on("chat", async (data: { content: string }) => {
      const content = String(data?.content || "").trim();
      if (!content) return;
      const scope = { agentKey: SCRIPT_AGENT_KEY, projectId: context.projectId, scriptId: SCRIPT_AGENT_SCRIPT_ID };
      const activeRun = await getActiveAgentRun(scope);
      if (activeRun) {
        emitRunUpdate({ status: activeRun.status, activeRun, rejected: true, reason: "Script Agent already has an active run in this project." });
        return;
      }

      const msg = resTool.newMessage("assistant", "剧本策划");
      const createdRun = await createAgentRun({ ...scope, isolationKey: context.isolationKey, messageId: msg.id });
      if (!createdRun.created) {
        emitRunUpdate({ status: createdRun.activeRun.status, activeRun: createdRun.activeRun, rejected: true, reason: "Script Agent already has an active run in this project." });
        return;
      }

      const controller = new AbortController();
      const runContext = createAgentRunContext(createdRun.run.runId);
      runContext.requestStop = () => controller.abort();
      const heartbeatTimer = setInterval(() => {
        void updateAgentRunHeartbeat(createdRun.run.runId).catch((error) => console.warn("[scriptAgent] heartbeat failed:", u.error(error).message));
      }, AGENT_RUN_HEARTBEAT_INTERVAL_MS);
      activeExecutions.set(scopeKey(context), { runId: createdRun.run.runId, controller, runContext, heartbeatTimer });
      broadcastRunUpdate({ status: "running", run: createdRun.run });

      let finalStatus: AgentRunStatus = "failed";
      let finalReason: string | null = "Agent stream ended without a terminal declaration.";
      let finalError: unknown = { code: "AGENT_TERMINAL_DECLARATION_MISSING" };
      try {
        await agent.runDecisionAI({
          socket,
          isolationKey: context.isolationKey,
          text: content,
          userMessageTime: new Date(msg.datetime).getTime() - 1,
          abortSignal: controller.signal,
          resTool,
          msg,
          thinkConfig,
          runContext,
        });
        if (runContext.terminalIntent) {
          finalStatus = runContext.terminalIntent.status;
          finalReason = runContext.terminalIntent.reason;
          finalError = runContext.terminalIntent.errorJson;
        } else {
          await recordAgentRunEvent(createdRun.run.runId, "terminal_declaration_missing", {
            code: "AGENT_TERMINAL_DECLARATION_MISSING",
          });
        }
      } catch (error: any) {
        if (runContext.terminalIntent) {
          finalStatus = runContext.terminalIntent.status;
          finalReason = runContext.terminalIntent.reason;
          finalError = runContext.terminalIntent.errorJson;
        } else if (runContext.abortReason === "user_stop" || controller.signal.aborted) {
          finalStatus = "cancelled";
          finalReason = "Script Agent run was cancelled by the user.";
        } else {
          finalStatus = "failed";
          finalReason = u.error(error).message;
          finalError = { name: error?.name, message: u.error(error).message };
          console.error("[scriptAgent] chat error:", u.error(error).message);
        }
      } finally {
        clearInterval(heartbeatTimer);
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
          console.error("[scriptAgent] failed to persist terminal run status:", u.error(error).message);
        } finally {
          const active = activeExecutions.get(scopeKey(context));
          if (active?.runId === createdRun.run.runId) activeExecutions.delete(scopeKey(context));
        }
        if (finished) {
          broadcastRunUpdate({ status: finished.status, run: finished });
        } else {
          broadcastRunUpdate({ status: "running", runId: createdRun.run.runId, terminalPersistenceFailed: true });
        }
      }
    });

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = Boolean(data?.think);
      thinkConfig.thinlLevel = data?.thinlLevel ?? 0;
    });

    socket.on("stop", async () => {
      const active = activeExecutions.get(scopeKey(context));
      if (!active) return;
      active.runContext.abortReason = "user_stop";
      active.controller.abort();
    });

    socket.on("disconnect", () => {
      const active = activeExecutions.get(scopeKey(context));
      if (!active) return;
      void recordAgentRunEvent(active.runId, "client_detached", { socketId: socket.id, isolationKey: context.isolationKey }).catch((error) =>
        console.warn("[scriptAgent] failed to record detached client:", u.error(error).message),
      );
    });
  });
};
