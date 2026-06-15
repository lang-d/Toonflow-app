import { randomUUID } from "node:crypto";
import type { Namespace, Socket } from "socket.io";
import { onRuntimePortChanged } from "@/runtime/runtimeRegistry";

type AgentKind = "productionAgent" | "scriptAgent";

export default function agentProxy(kind: AgentKind) {
  return (nsp: Namespace) => {
    nsp.on("connection", (socket: Socket) => {
      const connectionId = `${kind}:${socket.id}:${randomUUID()}`;
      const callbacks = new Map<string, (...args: any[]) => void>();
      let port: any | null = null;

      const onAgentMessage = (event: any) => {
        const message = event?.data ?? event;
        if (message?.connectionId !== connectionId) return;
        if (message.type === "agent:emit") {
          const args = Array.isArray(message.args) ? message.args : [];
          if (message.callbackId) {
            socket.emit(message.event, ...args, (...callbackArgs: any[]) => {
              port?.postMessage({
                type: "agent:callback",
                connectionId,
                callbackId: message.callbackId,
                args: callbackArgs,
              });
            });
          } else {
            socket.emit(message.event, ...args);
          }
        }
        if (message.type === "agent:disconnect") socket.disconnect();
        if (message.type === "agent:input-callback") {
          const callback = callbacks.get(message.callbackId);
          callbacks.delete(message.callbackId);
          callback?.(...(Array.isArray(message.args) ? message.args : []));
        }
      };

      const detachRuntimeListener = onRuntimePortChanged("agent", (nextPort) => {
        if (port === nextPort) return;
        port?.off?.("message", onAgentMessage);
        port = nextPort;
        if (!port) {
          socket.emit("agent:error", {
            code: "AGENT_UNAVAILABLE",
            message: "Agent 进程暂不可用，正在恢复",
          });
          return;
        }
        port.on("message", onAgentMessage);
        port.postMessage({
          type: "agent:connect",
          connectionId,
          kind,
          socketId: socket.id,
          auth: socket.handshake.auth || {},
        });
      });

      socket.onAny((eventName, ...incomingArgs) => {
        const args = [...incomingArgs];
        const possibleCallback = args.at(-1);
        let callbackId: string | undefined;
        if (typeof possibleCallback === "function") {
          args.pop();
          callbackId = randomUUID();
          callbacks.set(callbackId, possibleCallback);
        }
        if (!port) {
          if (callbackId && typeof possibleCallback === "function") {
            callbacks.delete(callbackId);
            possibleCallback({ code: "AGENT_UNAVAILABLE", message: "Agent 进程暂不可用" });
          } else {
            socket.emit("agent:error", { code: "AGENT_UNAVAILABLE", message: "Agent 进程暂不可用" });
          }
          return;
        }
        port.postMessage({
          type: "agent:input",
          connectionId,
          event: eventName,
          args,
          callbackId,
        });
      });

      socket.on("disconnect", () => {
        callbacks.clear();
        detachRuntimeListener();
        port?.off?.("message", onAgentMessage);
        port?.postMessage({ type: "agent:disconnect", connectionId });
      });
    });
  };
}
