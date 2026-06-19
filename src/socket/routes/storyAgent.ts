import jwt from "jsonwebtoken";
import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/storyAgent/index";
import ResTool from "@/socket/resTool";

async function verifyToken(rawToken: string): Promise<boolean> {
  const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
  if (!setting) return false;
  const { value: tokenKey } = setting;
  if (!rawToken) return false;
  const token = rawToken.replace("Bearer ", "");
  try {
    jwt.verify(token, tokenKey as string);
    return true;
  } catch {
    return false;
  }
}

export default (nsp: Namespace) => {
  nsp.on("connection", async (socket: Socket) => {
    const token = socket.handshake.auth.token;
    if (!token || !(await verifyToken(token))) {
      console.log("[storyAgent] connection rejected: invalid token");
      socket.disconnect();
      return;
    }
    const isolationKey = socket.handshake.auth.isolationKey;
    if (!isolationKey) {
      console.log("[storyAgent] connection rejected: missing isolationKey");
      socket.disconnect();
      return;
    }

    const resTool = new ResTool(socket, {
      projectId: socket.handshake.auth.projectId,
    });
    let abortController: AbortController | null = null;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on(
      "chat",
      async (data: {
        content: string;
        projectId?: number;
        artifactId?: number;
        includeOpenAnnotations?: boolean;
      }) => {
        abortController?.abort();
        abortController = new AbortController();
        const currentController = abortController;
        const msg = resTool.newMessage("assistant", "Story Agent");
        const projectId = Number(data.projectId ?? socket.handshake.auth.projectId);
        if (!Number.isFinite(projectId)) {
          msg.error("Missing projectId");
          return;
        }
        resTool.data.projectId = projectId;
        const ctx: agent.AgentContext = {
          socket,
          isolationKey,
          text: data.content,
          artifactId: data.artifactId,
          includeOpenAnnotations: data.includeOpenAnnotations,
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
            console.error("[storyAgent] chat error:", u.error(err).message);
            msg.error(u.error(err).message);
          }
        } finally {
          if (abortController === currentController) {
            abortController = null;
          }
        }
      },
    );

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = data.think;
      thinkConfig.thinlLevel = data.thinlLevel;
    });

    socket.on("stop", () => {
      abortController?.abort();
      abortController = null;
    });
  });
};
