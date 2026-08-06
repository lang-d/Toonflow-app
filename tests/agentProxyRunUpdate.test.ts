import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import agentProxy from "../src/socket/routes/agentProxy";
import { attachRuntimePort, closeRuntimePorts } from "../src/runtime/runtimeRegistry";

class TestPort extends EventEmitter {
  messages: any[] = [];

  postMessage(message: any) {
    this.messages.push(message);
  }

  close() {}
}

class TestSocket {
  id = "socket-1";
  handshake = {
    auth: {
      projectId: 7,
      scriptId: 23,
      isolationKey: "7:productionAgent:23",
    },
  };
  emitted: Array<{ event: string; args: any[] }> = [];
  private anyHandler: ((eventName: string, ...args: any[]) => void) | null = null;
  private handlers = new Map<string, Array<(...args: any[]) => void>>();

  emit(event: string, ...args: any[]) {
    this.emitted.push({ event, args });
    return true;
  }

  onAny(handler: (eventName: string, ...args: any[]) => void) {
    this.anyHandler = handler;
  }

  on(event: string, handler: (...args: any[]) => void) {
    const handlers = this.handlers.get(event) || [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  receive(event: string, ...args: any[]) {
    this.anyHandler?.(event, ...args);
  }
}

class TestNamespace {
  private connectionHandler: ((socket: TestSocket) => void) | null = null;

  on(event: string, handler: (socket: TestSocket) => void) {
    if (event === "connection") this.connectionHandler = handler;
  }

  connect(socket: TestSocket) {
    this.connectionHandler?.(socket);
  }
}

function setup(kind: "productionAgent" | "musicProductionAgent" = "productionAgent") {
  const namespace = new TestNamespace();
  const socket = new TestSocket();
  agentProxy(kind)(namespace as any);
  namespace.connect(socket);
  return socket;
}

test("production chat emits a rejected Run update when the agent runtime is unavailable", () => {
  closeRuntimePorts();
  const socket = setup();

  socket.receive("chat", { content: "继续" });

  const updates = socket.emitted.filter((item) => item.event === "agent:run:update");
  assert.equal(updates.length, 1);
  assert.deepEqual(
    { ...updates[0].args[0], serverTime: 0 },
    {
      agentKey: "productionAgent",
      projectId: 7,
      scriptId: 23,
      serverTime: 0,
      rejected: true,
      code: "AGENT_UNAVAILABLE",
      reason: "Agent 进程暂不可用",
    },
  );
  assert.equal(Number.isFinite(updates[0].args[0].serverTime), true);
});

test("non-chat callbacks keep the existing unavailable transport response", () => {
  closeRuntimePorts();
  const socket = setup();
  let result: any = null;

  socket.receive("updateContext", { projectId: 7, scriptId: 23 }, (value: any) => {
    result = value;
  });

  assert.deepEqual(result, { code: "AGENT_UNAVAILABLE", message: "Agent 进程暂不可用" });
  assert.equal(socket.emitted.some((item) => item.event === "agent:run:update"), false);
});

test("runtime replacement after forwarding chat does not eagerly reject the message", () => {
  closeRuntimePorts();
  const port = new TestPort();
  attachRuntimePort(port, "agent", 101);
  const socket = setup();
  socket.emitted.length = 0;

  socket.receive("chat", { content: "继续" });
  assert.equal(port.messages.some((message) => message.type === "agent:input" && message.event === "chat"), true);

  closeRuntimePorts();
  assert.equal(
    socket.emitted.some((item) => item.event === "agent:run:update" && item.args[0]?.rejected === true),
    false,
  );
});
