import { EventEmitter } from "node:events";
import productionAgent from "@/socket/routes/productionAgent";
import musicProductionAgent from "@/socket/routes/musicProductionAgent";
import scriptAgent from "@/socket/routes/scriptAgent";
import storyAgent from "@/socket/routes/storyAgent";
import { VirtualNamespace, VirtualSocket } from "@/runtime/virtualSocket";

export { VirtualNamespace, VirtualSocket } from "@/runtime/virtualSocket";

export function attachAgentSocketBridge(port: any) {
  const productionNamespace = new VirtualNamespace();
  const musicProductionNamespace = new VirtualNamespace();
  const scriptNamespace = new VirtualNamespace();
  const storyNamespace = new VirtualNamespace();
  productionAgent(productionNamespace as any);
  musicProductionAgent(musicProductionNamespace as any);
  scriptAgent(scriptNamespace as any);
  storyAgent(storyNamespace as any);
  const sockets = new Map<string, VirtualSocket>();

  const onMessage = (event: any) => {
    const message = event?.data ?? event;
    if (message?.type === "agent:connect") {
      const namespace =
        message.kind === "productionAgent"
          ? productionNamespace
          : message.kind === "musicProductionAgent"
            ? musicProductionNamespace
            : message.kind === "storyAgent"
              ? storyNamespace
              : scriptNamespace;
      const socket = new VirtualSocket(
        port,
        message.connectionId,
        message.socketId,
        message.auth || {},
        namespace,
        () => sockets.delete(message.connectionId),
      );
      sockets.set(message.connectionId, socket);
      namespace.register(socket);
      EventEmitter.prototype.emit.call(namespace, "connection", socket);
      return;
    }
    const socket = sockets.get(message?.connectionId);
    if (!socket) return;
    if (message.type === "agent:input") {
      socket.receive(message.event, Array.isArray(message.args) ? message.args : [], message.callbackId);
    } else if (message.type === "agent:callback") {
      socket.resolveCallback(message.callbackId, Array.isArray(message.args) ? message.args : []);
    } else if (message.type === "agent:disconnect") {
      socket.dispose();
    }
  };
  port.on("message", onMessage);
  port.start?.();
  return () => {
    port.off?.("message", onMessage);
    for (const socket of [...sockets.values()]) socket.dispose();
    sockets.clear();
  };
}
