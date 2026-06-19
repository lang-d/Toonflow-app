import jwt from "jsonwebtoken";
import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/productionAgent/index";
import ResTool from "@/socket/resTool";

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

    let resTool = new ResTool(socket, {
      projectId: context.projectId,
      scriptId: context.scriptId,
    });
    let abortController: AbortController | null = null;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on("updateContext", async (data: { isolationKey: string; projectId: number; scriptId: number }, callback) => {
      try {
        if (abortController) throw new Error("production agent is running; stop it before switching context");
        const nextContext = await validateProductionAgentContext(data);
        context = nextContext;
        resTool = new ResTool(socket, {
          projectId: nextContext.projectId,
          scriptId: nextContext.scriptId,
        });
        console.log("[productionAgent] context updated:", context.isolationKey);
        callback?.({ success: true });
      } catch (error) {
        callback?.({ success: false, message: u.error(error).message });
      }
    });

    socket.on("chat", async (data: { content: string }) => {
      const { content } = data;
      abortController?.abort();
      abortController = new AbortController();
      const currentController = abortController;

      const msg = resTool.newMessage("assistant", "视频策划");
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
          console.error("[productionAgent] chat error:", u.error(err).message);
        }
      } finally {
        if (abortController === currentController) {
          abortController = null;
        }
      }
    });

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = data.think;
      thinkConfig.thinlLevel = data.thinlLevel;
      console.log("[productionAgent] think config updated:", thinkConfig);
    });

    socket.on("stop", () => {
      abortController?.abort();
      abortController = null;
    });
  });
  nsp.on("disconnect", (socket: Socket) => {
    console.log("[productionAgent] disconnected:", socket.id);
  });
};
