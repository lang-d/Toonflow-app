import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import productionAgent from "@/socket/routes/productionAgent";
import scriptAgent from "@/socket/routes/scriptAgent";

class VirtualSocket extends EventEmitter {
  id: string;
  handshake: { auth: Record<string, unknown> };
  private connectionId: string;
  private port: any;
  private callbacks = new Map<string, (...args: any[]) => void>();

  constructor(port: any, connectionId: string, socketId: string, auth: Record<string, unknown>) {
    super();
    this.port = port;
    this.connectionId = connectionId;
    this.id = socketId;
    this.handshake = { auth };
  }

  emit(eventName: string | symbol, ...args: any[]): boolean {
    const possibleCallback = args.at(-1);
    let callbackId: string | undefined;
    if (typeof possibleCallback === "function") {
      args.pop();
      callbackId = randomUUID();
      this.callbacks.set(callbackId, possibleCallback);
    }
    this.port.postMessage({
      type: "agent:emit",
      connectionId: this.connectionId,
      event: String(eventName),
      args,
      callbackId,
    });
    return true;
  }

  receive(eventName: string, args: any[], callbackId?: string) {
    const callback = callbackId
      ? (...callbackArgs: any[]) =>
          this.port.postMessage({
            type: "agent:input-callback",
            connectionId: this.connectionId,
            callbackId,
            args: callbackArgs,
          })
      : undefined;
    EventEmitter.prototype.emit.call(this, eventName, ...args, ...(callback ? [callback] : []));
  }

  resolveCallback(callbackId: string, args: any[]) {
    const callback = this.callbacks.get(callbackId);
    this.callbacks.delete(callbackId);
    callback?.(...args);
  }

  disconnect() {
    this.port.postMessage({ type: "agent:disconnect", connectionId: this.connectionId });
    this.receive("disconnect", []);
  }
}

class VirtualNamespace extends EventEmitter {}

export function attachAgentSocketBridge(port: any) {
  const productionNamespace = new VirtualNamespace();
  const scriptNamespace = new VirtualNamespace();
  productionAgent(productionNamespace as any);
  scriptAgent(scriptNamespace as any);
  const sockets = new Map<string, VirtualSocket>();

  const onMessage = (event: any) => {
    const message = event?.data ?? event;
    if (message?.type === "agent:connect") {
      const socket = new VirtualSocket(
        port,
        message.connectionId,
        message.socketId,
        message.auth || {},
      );
      sockets.set(message.connectionId, socket);
      const namespace = message.kind === "productionAgent" ? productionNamespace : scriptNamespace;
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
      socket.receive("disconnect", []);
      sockets.delete(message.connectionId);
    }
  };
  port.on("message", onMessage);
  port.start?.();
  return () => {
    port.off?.("message", onMessage);
    for (const socket of sockets.values()) socket.receive("disconnect", []);
    sockets.clear();
  };
}
