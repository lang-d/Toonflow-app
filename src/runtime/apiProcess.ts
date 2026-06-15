import { startRuntimeMetrics } from "@/runtime/runtimeMetrics";
import {
  attachRuntimePort,
  closeRuntimePorts,
  setRuntimeSupervisorSnapshot,
  updateRuntimeMetric,
} from "@/runtime/runtimeRegistry";
import { RUNTIME_API_PORT, startRuntimeHeartbeat } from "@/runtime/runtimeProtocol";

process.env.TOONFLOW_UTILITY = "1";
process.env.TOONFLOW_RUNTIME_ROLE = "api";

const parentPort = (process as any).parentPort;
parentPort?.on("message", (event: any) => {
  const data = event?.data ?? event;
  if (data?.type === "runtime:attach" && event?.ports?.[0]) {
    attachRuntimePort(event.ports[0], data.role, Number(data.pid || 0));
  }
  if (data?.type === "runtime:metric" && data.metric) updateRuntimeMetric(data.metric);
  if (data?.type === "runtime:supervisor" && data.snapshot) setRuntimeSupervisorSnapshot(data.snapshot);
  if (data?.type === "shutdown") void shutdown();
});

const stopHeartbeat = startRuntimeHeartbeat("api", (message) => parentPort?.postMessage(message));

const stopMetrics = startRuntimeMetrics("api", (metric) => {
  updateRuntimeMetric(metric);
  parentPort?.postMessage({ type: "runtime:metric", metric });
});

let closeServe: undefined | (() => Promise<void>);
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopMetrics();
  stopHeartbeat();
  try {
    await closeServe?.();
  } finally {
    closeRuntimePorts();
    parentPort?.postMessage({ type: "runtime:stopped", role: "api", pid: process.pid });
    process.exit(0);
  }
}

void (async () => {
  const appModule = require("@/app") as typeof import("@/app");
  closeServe = appModule.closeServe;
  const port = await appModule.default({ startQueue: false, portRetryMs: 10_000 });
  if (port !== RUNTIME_API_PORT) throw new Error(`API bound unexpected port ${port}`);
  parentPort?.postMessage({ type: "runtime:ready", role: "api", pid: process.pid, port });
})().catch((error) => {
  parentPort?.postMessage({
    type: "runtime:error",
    role: "api",
    pid: process.pid,
    code: error?.code,
    message: String(error?.stack || error),
  });
  process.exit(1);
});
