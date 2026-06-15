import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  closeRuntimePorts,
  getRuntimeConnections,
  getRuntimePort,
  getRuntimeSupervisorSnapshot,
  onRuntimePortChanged,
  setRuntimeSupervisorSnapshot,
  attachRuntimePort,
} from "../src/runtime/runtimeRegistry";
import {
  RUNTIME_API_HOST,
  RUNTIME_API_PORT,
  RUNTIME_API_URL,
  type RuntimeSupervisorSnapshot,
} from "../src/runtime/runtimeProtocol";

class FakePort extends EventEmitter {
  closed = false;
  started = false;

  start() {
    this.started = true;
  }

  close() {
    this.closed = true;
  }
}

test("runtime API address is fixed", () => {
  assert.equal(RUNTIME_API_HOST, "127.0.0.1");
  assert.equal(RUNTIME_API_PORT, 10588);
  assert.equal(RUNTIME_API_URL, "http://127.0.0.1:10588/api");
});

test("attaching a new role port replaces and closes the previous port", () => {
  closeRuntimePorts();
  const changes: Array<{ port: FakePort | null; pid: number }> = [];
  const detach = onRuntimePortChanged("worker", (port, pid) => {
    changes.push({ port, pid });
  });
  const first = new FakePort();
  const second = new FakePort();

  attachRuntimePort(first, "worker", 101);
  attachRuntimePort(second, "worker", 202);

  assert.equal(first.closed, true);
  assert.equal(second.started, true);
  assert.equal(getRuntimePort("worker"), second);
  assert.deepEqual(getRuntimeConnections(), [{ role: "worker", pid: 202, connected: true }]);
  assert.deepEqual(
    changes.map((item) => item.pid),
    [101, 202],
  );

  detach();
  closeRuntimePorts();
});

test("supervisor snapshot is available to diagnostics", () => {
  const snapshot: RuntimeSupervisorSnapshot = {
    apiUrl: RUNTIME_API_URL,
    updatedAt: Date.now(),
    services: [
      {
        role: "api",
        pid: 100,
        status: "ready",
        lastHeartbeatAt: Date.now(),
        restartCount: 0,
        ipcConnected: true,
      },
    ],
  };
  setRuntimeSupervisorSnapshot(snapshot);
  assert.equal(getRuntimeSupervisorSnapshot(), snapshot);
});
