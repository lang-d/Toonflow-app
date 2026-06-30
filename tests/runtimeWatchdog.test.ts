import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntimeWatchdogDiagnostics, evaluateRuntimeWatchdog } from "../src/runtime/runtimeWatchdog";

test("runtime watchdog defers kill when stdout activity is recent", () => {
  const now = 1_000_000;
  const decision = evaluateRuntimeWatchdog({
    now,
    lastHeartbeatAt: now - 121_000,
    lastStdoutAt: now - 10_000,
    killThresholdMs: 120_000,
  });

  assert.equal(decision.kill, false);
  assert.equal(decision.lastActivityKind, "stdout");
  assert.equal(decision.lastActivityAge, 10_000);
});

test("runtime watchdog kills when heartbeat and all secondary activity are stale", () => {
  const now = 1_000_000;
  const decision = evaluateRuntimeWatchdog({
    now,
    lastHeartbeatAt: now - 121_000,
    lastStdoutAt: now - 130_000,
    lastMetricAt: now - 140_000,
    killThresholdMs: 120_000,
  });

  assert.equal(decision.kill, true);
  assert.equal(decision.lastActivityKind, "heartbeat");
});

test("runtime watchdog diagnostics include metric details", () => {
  const diagnostics = buildRuntimeWatchdogDiagnostics({
    now: 10_000,
    lastHeartbeatAt: 1_000,
    lastStdoutAt: 9_000,
    lastMetricAt: 8_000,
    lastMetric: {
      role: "worker",
      pid: 10,
      timestamp: 8_000,
      uptimeSec: 30,
      eventLoopDelayP95Ms: 12,
      eventLoopDelayMaxMs: 345,
      eventLoopUtilization: 0.45,
      cpuUserMs: 5,
      cpuSystemMs: 1,
      rss: 100,
      heapUsed: 50,
      external: 10,
      database: { busyCount: 2 },
      externalProcesses: [{ pid: 88, command: "dreamina", startedAt: 7_000 }],
      activeTasks: [{ taskId: 42, handler: "image-flow", startedAt: 7_500, runningMs: 500 }],
    },
  });

  assert.equal(diagnostics.lastHeartbeatAge, 9_000);
  assert.equal(diagnostics.eventLoopDelayMaxMs, 345);
  assert.deepEqual(diagnostics.database, { busyCount: 2 });
  assert.deepEqual(diagnostics.activeTasks, [{ taskId: 42, handler: "image-flow", startedAt: 7_500, runningMs: 500 }]);
});
