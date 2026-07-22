import { startRuntimeMetrics } from "@/runtime/runtimeMetrics";
import { startRuntimeHeartbeat } from "@/runtime/runtimeProtocol";
import { initLogger, createLogger } from "@/logger";

process.env.TOONFLOW_UTILITY = "1";
process.env.TOONFLOW_RUNTIME_ROLE = "agent";
initLogger({ role: "agent", hijackConsole: true });
const runtimeLog = createLogger("runtime-agent");

const parentPort = (process as any).parentPort;
let apiPort: any = null;
let detachAgentBridge: undefined | (() => void);
let agentRunRecovery: Promise<void> | null = null;

function recoverRunsForThisAgentRuntime() {
  if (agentRunRecovery) return agentRunRecovery;
  agentRunRecovery = (async () => {
    const { dbReady } = require("@/utils/db") as typeof import("@/utils/db");
    const { interruptAgentRunsForRuntimeRestart } = require("@/services/agentRun") as typeof import("@/services/agentRun");
    await dbReady;
    const interrupted = await interruptAgentRunsForRuntimeRestart();
    if (interrupted) {
      runtimeLog.warn("Interrupted Agent Runs left by a previous Agent runtime", {
        event: "agent-run.runtime-restarted",
        interrupted,
      });
    }
  })();
  return agentRunRecovery;
}

parentPort?.on("message", async (event: any) => {
  const data = event?.data ?? event;
  if (data?.type === "runtime:attach" && event?.ports?.[0]) {
    runtimeLog.info("Agent attached to API runtime port", { event: "runtime.attach", peerRole: data.role });
    detachAgentBridge?.();
    apiPort?.close?.();
    const port = event.ports[0];
    apiPort = port;
    if (data.role === "api") {
      await recoverRunsForThisAgentRuntime();
      const { attachAgentSocketBridge } = require("@/runtime/agentSocketBridge") as typeof import("@/runtime/agentSocketBridge");
      detachAgentBridge = attachAgentSocketBridge(port);
    }
    port.start?.();
  }
  if (data?.type === "shutdown") {
    runtimeLog.info("Agent shutdown requested", { event: "shutdown" });
    stopMetrics();
    stopHeartbeat();
    detachAgentBridge?.();
    apiPort?.close?.();
    parentPort?.postMessage({ type: "runtime:stopped", role: "agent", pid: process.pid });
    process.exit(0);
  }
});

const stopHeartbeat = startRuntimeHeartbeat("agent", (message) => parentPort?.postMessage(message));

const stopMetrics = startRuntimeMetrics("agent", (metric) => {
  parentPort?.postMessage({ type: "runtime:metric", metric });
  apiPort?.postMessage({ type: "runtime:metric", metric });
});

runtimeLog.info("Agent utility process ready", { event: "ready" });
parentPort?.postMessage({ type: "runtime:ready", role: "agent", pid: process.pid });
