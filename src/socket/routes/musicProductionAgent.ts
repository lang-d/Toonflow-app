import jwt from "jsonwebtoken";
import { Namespace, Socket } from "socket.io";
import u from "@/utils";
import * as agent from "@/agents/musicProductionAgent/index";
import ResTool from "@/socket/resTool";
import {
  musicEpisodeIsolationKey,
  musicProjectIsolationKey,
  type MusicStageStateInput,
} from "@/services/musicStageState";
import type { MusicScopeMode } from "@/services/musicDirector";

async function verifyToken(rawToken: string): Promise<boolean> {
  const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
  if (!setting) return false;
  if (!rawToken) return false;
  const token = rawToken.replace("Bearer ", "");
  try {
    jwt.verify(token, setting.value as string);
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

function normalizeMode(input: any, scriptId: number | null): MusicScopeMode {
  const mode = String(input?.mode || "");
  if (mode === "concept" || mode === "project" || mode === "episode") return mode;
  return scriptId == null ? "project" : "episode";
}

function expectedIsolationKey(input: Required<Pick<MusicStageStateInput, "projectId">> & MusicStageStateInput) {
  return input.mode === "episode" && input.scriptId != null
    ? musicEpisodeIsolationKey(input.projectId, Number(input.scriptId))
    : musicProjectIsolationKey(input.projectId);
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
  if (isolationKey !== expected) {
    throw new Error(`music production isolationKey mismatch: expected ${expected}`);
  }
  return { isolationKey, projectId, scriptId, mode };
}

function userFacingMusicAgentError(error: unknown) {
  const message = u.error(error).message;
  if (/musicProductionAgent|模型配置|部署配置|model/i.test(message)) {
    return `配乐生产 Agent 模型配置未就绪：${message}`;
  }
  return message || "配乐生产 Agent 执行失败";
}

export default (nsp: Namespace) => {
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

    let resTool = new ResTool(socket, {
      projectId: context.projectId,
      scriptId: context.scriptId,
      mode: context.mode,
    });
    let abortController: AbortController | null = null;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on(
      "updateContext",
      async (
        data: {
          isolationKey?: string;
          projectId: number;
          scriptId?: number | null;
          mode?: MusicScopeMode;
        },
        callback,
      ) => {
        try {
          if (abortController) throw new Error("music production agent is running; stop it before switching context");
          const nextContext = await validateMusicProductionAgentContext(data);
          context = nextContext;
          resTool = new ResTool(socket, {
            projectId: nextContext.projectId,
            scriptId: nextContext.scriptId,
            mode: nextContext.mode,
          });
          console.log("[musicProductionAgent] context updated:", context.isolationKey);
          callback?.({ success: true, isolationKey: context.isolationKey });
        } catch (error) {
          callback?.({ success: false, message: u.error(error).message });
        }
      },
    );

    socket.on("chat", async (data: { content: string }) => {
      const content = String(data?.content || "");
      abortController?.abort();
      abortController = new AbortController();
      const currentController = abortController;

      const msg = resTool.newMessage("assistant", "Music Director");
      const ctx: agent.AgentContext = {
        socket,
        isolationKey: context.isolationKey,
        text: content,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: currentController.signal,
        resTool,
        msg,
        thinkConfig,
      };

      try {
        await agent.runDecisionAI(ctx);
      } catch (err: any) {
        if (err.name !== "AbortError" && !currentController.signal.aborted) {
          const message = userFacingMusicAgentError(err);
          ctx.msg.error(message);
          console.error("[musicProductionAgent] chat error:", message);
        }
      } finally {
        if (abortController === currentController) abortController = null;
      }
    });

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = data.think;
      thinkConfig.thinlLevel = data.thinlLevel;
      console.log("[musicProductionAgent] think config updated:", thinkConfig);
    });

    socket.on("stop", () => {
      abortController?.abort();
      abortController = null;
    });
  });

  nsp.on("disconnect", (socket: Socket) => {
    console.log("[musicProductionAgent] disconnected:", socket.id);
  });
};
