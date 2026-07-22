import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export class VirtualNamespace extends EventEmitter {
  private sockets = new Set<VirtualSocket>();
  private rooms = new Map<string, Set<VirtualSocket>>();

  register(socket: VirtualSocket) {
    this.sockets.add(socket);
  }

  unregister(socket: VirtualSocket) {
    this.sockets.delete(socket);
    for (const room of socket.roomNames()) this.leave(socket, room);
  }

  join(socket: VirtualSocket, room: string) {
    if (!this.sockets.has(socket)) this.sockets.add(socket);
    const members = this.rooms.get(room) ?? new Set<VirtualSocket>();
    members.add(socket);
    this.rooms.set(room, members);
    socket.addRoom(room);
  }

  leave(socket: VirtualSocket, room: string) {
    const members = this.rooms.get(room);
    members?.delete(socket);
    if (members?.size === 0) this.rooms.delete(room);
    socket.removeRoom(room);
  }

  to(room: string) {
    return {
      emit: (eventName: string | symbol, ...args: any[]) => {
        const members = [...(this.rooms.get(room) ?? [])];
        for (const socket of members) socket.emit(eventName, ...args);
        return members.length > 0;
      },
    };
  }
}

export class VirtualSocket extends EventEmitter {
  id: string;
  handshake: { auth: Record<string, unknown> };
  private connectionId: string;
  private port: any;
  private namespace: VirtualNamespace;
  private rooms = new Set<string>();
  private callbacks = new Map<string, (...args: any[]) => void>();
  private disconnected = false;
  private onDispose: () => void;

  constructor(
    port: any,
    connectionId: string,
    socketId: string,
    auth: Record<string, unknown>,
    namespace: VirtualNamespace,
    onDispose: () => void = () => {},
  ) {
    super();
    this.port = port;
    this.connectionId = connectionId;
    this.id = socketId;
    this.handshake = { auth };
    this.namespace = namespace;
    this.onDispose = onDispose;
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

  join(room: string) {
    if (!this.disconnected) this.namespace.join(this, room);
  }

  leave(room: string) {
    this.namespace.leave(this, room);
  }

  roomNames() {
    return [...this.rooms];
  }

  addRoom(room: string) {
    this.rooms.add(room);
  }

  removeRoom(room: string) {
    this.rooms.delete(room);
  }

  dispose(notifyRemote = false) {
    if (this.disconnected) return;
    this.disconnected = true;
    this.callbacks.clear();
    this.namespace.unregister(this);
    this.onDispose();
    if (notifyRemote) this.port.postMessage({ type: "agent:disconnect", connectionId: this.connectionId });
    EventEmitter.prototype.emit.call(this, "disconnect");
  }

  disconnect() {
    this.dispose(true);
  }
}
