import type { Socket } from "socket.io";
import { createLogger } from "@/logger";

export const AGENT_SOCKET_ACK_TIMEOUT_MS = Number(process.env.AGENT_SOCKET_ACK_TIMEOUT_MS || 30000);

const log = createLogger("agent-tool-ack");

export async function emitWithAckTimeout<T = unknown>(
  socket: Pick<Socket, "emit">,
  event: string,
  payload: unknown,
  timeoutMs = AGENT_SOCKET_ACK_TIMEOUT_MS,
  context: Record<string, unknown> = {},
): Promise<T> {
  const startedAt = Date.now();
  log.info("Agent tool ack started", {
    event: "agent.tool-ack.start",
    socketEvent: event,
    timeoutMs,
    ...context,
  });

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const message = `等待前端响应 ${event} 超时，请刷新页面或重试。`;
      log.warn("Agent tool ack timeout", {
        event: "agent.tool-ack.timeout",
        socketEvent: event,
        timeoutMs,
        durationMs: Date.now() - startedAt,
        ...context,
      });
      reject(new Error(message));
    }, timeoutMs);

    socket.emit(event, payload, (res: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.info("Agent tool ack succeeded", {
        event: "agent.tool-ack.success",
        socketEvent: event,
        durationMs: Date.now() - startedAt,
        ...context,
      });
      resolve(res);
    });
  });
}
