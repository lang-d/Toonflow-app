import { startRuntimeMetrics } from "@/runtime/runtimeMetrics";
import { startRuntimeHeartbeat } from "@/runtime/runtimeProtocol";

process.env.TOONFLOW_UTILITY = "1";
process.env.TOONFLOW_RUNTIME_ROLE = "worker";

const parentPort = (process as any).parentPort;
let apiPort: any = null;
let shuttingDown = false;
let stopWorker: undefined | (() => Promise<void>);
let readDbDiagnostics: undefined | (() => Record<string, unknown>);
let readExternalProcesses: undefined | (() => Array<{ pid: number; command: string; startedAt: number }>);

parentPort?.on("message", (event: any) => {
  const data = event?.data ?? event;
  if (data?.type === "runtime:attach" && event?.ports?.[0]) {
    if (apiPort) {
      apiPort.close?.();
    }
    apiPort = event.ports[0];
    apiPort.start?.();
  }
  if (data?.type === "task:wake") {
    apiPort?.postMessage({ type: "task:wake" });
  }
  if (data?.type === "shutdown") void shutdown();
});

const stopHeartbeat = startRuntimeHeartbeat("worker", (message) => parentPort?.postMessage(message));

const stopMetrics = startRuntimeMetrics("worker", (metric) => {
  if (readDbDiagnostics) metric.database = readDbDiagnostics();
  if (readExternalProcesses) metric.externalProcesses = readExternalProcesses();
  parentPort?.postMessage({ type: "runtime:metric", metric });
  apiPort?.postMessage({ type: "runtime:metric", metric });
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopMetrics();
  stopHeartbeat();
  try {
    await stopWorker?.();
    const queue = require("@/utils/videoGenerationQueue") as typeof import("@/utils/videoGenerationQueue");
    await queue.stopVideoGenerationQueue();
    const portable = require("@/services/projectPortable") as typeof import("@/services/projectPortable");
    const summary = await portable.generateStaleProjectSnapshotsOnExit(undefined, { timeoutMs: 60_000 });
    if (summary.scanned) {
      parentPort?.postMessage({
        type: "runtime:log",
        role: "worker",
        pid: process.pid,
        message: `[project-snapshot] exit flush scanned=${summary.scanned} completed=${summary.completed} failed=${summary.failed} skipped=${summary.skipped}`,
      });
    }
  } finally {
    apiPort?.close?.();
    parentPort?.postMessage({ type: "runtime:stopped", role: "worker", pid: process.pid });
    process.exit(0);
  }
}

void (async () => {
  const dbModule = require("@/utils/db") as typeof import("@/utils/db");
  const { dbReady } = dbModule;
  readDbDiagnostics = dbModule.getDbDiagnostics;
  await dbReady;
  const queue = require("@/utils/videoGenerationQueue") as typeof import("@/utils/videoGenerationQueue");
  readExternalProcesses = (require("@/utils/dreaminaCli") as typeof import("@/utils/dreaminaCli")).getActiveCliProcesses;
  const worker = require("@/services/unifiedTaskWorker") as typeof import("@/services/unifiedTaskWorker");
  queue.startVideoGenerationQueue();
  const unified = await worker.startUnifiedTaskWorker({
    onWake: () => {
      apiPort?.postMessage({ type: "task:event-available" });
    },
  });
  stopWorker = () => unified.stop();
  parentPort?.postMessage({ type: "runtime:ready", role: "worker", pid: process.pid });
})().catch((error) => {
  parentPort?.postMessage({
    type: "runtime:error",
    role: "worker",
    pid: process.pid,
    message: String(error?.stack || error),
  });
  process.exit(1);
});
