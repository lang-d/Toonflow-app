import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { VirtualNamespace, VirtualSocket } from "../src/runtime/virtualSocket";

class TestPort extends EventEmitter {
  messages: any[] = [];

  postMessage(message: any) {
    this.messages.push(message);
  }
}

function createSocket(namespace: VirtualNamespace, port: TestPort, connectionId: string, socketId = connectionId) {
  const socket = new VirtualSocket(port, connectionId, socketId, {}, namespace);
  namespace.register(socket);
  return socket;
}

function emittedEvents(port: TestPort) {
  return port.messages.filter((message) => message.type === "agent:emit");
}

test("virtual socket rooms broadcast only to matching members", () => {
  const namespace = new VirtualNamespace();
  const roomOnePort = new TestPort();
  const roomOneSecondPort = new TestPort();
  const roomTwoPort = new TestPort();
  const roomOne = createSocket(namespace, roomOnePort, "room-one");
  const roomOneSecond = createSocket(namespace, roomOneSecondPort, "room-one-second");
  const roomTwo = createSocket(namespace, roomTwoPort, "room-two");

  roomOne.join("productionAgent:1:10");
  roomOneSecond.join("productionAgent:1:10");
  roomTwo.join("productionAgent:1:11");

  assert.equal(namespace.to("productionAgent:1:10").emit("agent:run:update", { status: "running" }), true);
  assert.equal(emittedEvents(roomOnePort).length, 1);
  assert.equal(emittedEvents(roomOneSecondPort).length, 1);
  assert.equal(emittedEvents(roomTwoPort).length, 0);
});

test("virtual socket leave and disconnect remove room membership", () => {
  const namespace = new VirtualNamespace();
  const port = new TestPort();
  const socket = createSocket(namespace, port, "connection-1");
  let disconnects = 0;
  socket.on("disconnect", () => {
    disconnects++;
  });

  socket.join("productionAgent:1:10");
  socket.leave("productionAgent:1:10");
  assert.equal(namespace.to("productionAgent:1:10").emit("agent:run:update"), false);

  socket.join("productionAgent:1:10");
  socket.disconnect();
  socket.disconnect();
  assert.equal(disconnects, 1);
  assert.equal(namespace.to("productionAgent:1:10").emit("agent:run:update"), false);
  assert.equal(port.messages.filter((message) => message.type === "agent:disconnect").length, 1);
});

test("virtual socket forwards input callbacks to the API proxy", () => {
  const namespace = new VirtualNamespace();
  const port = new TestPort();
  const socket = createSocket(namespace, port, "connection-1");
  socket.on("updateContext", (_data, callback) => callback({ success: true }));

  socket.receive("updateContext", [{ isolationKey: "1:productionAgent:10" }], "callback-1");

  assert.deepEqual(port.messages, [
    {
      type: "agent:input-callback",
      connectionId: "connection-1",
      callbackId: "callback-1",
      args: [{ success: true }],
    },
  ]);
});
