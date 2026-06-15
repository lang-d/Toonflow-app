import express from "express";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { success } from "@/lib/responseFormat";
import {
  getRuntimeConnections,
  getRuntimeMetrics,
  getRuntimeSupervisorSnapshot,
} from "@/runtime/runtimeRegistry";
import { RUNTIME_API_URL } from "@/runtime/runtimeProtocol";
import { getDbDiagnostics } from "@/utils/db";
import { getActiveCliProcesses } from "@/utils/dreaminaCli";

const router = express.Router();
const delay = monitorEventLoopDelay({ resolution: 20 });
delay.enable();

export default router.post("/", async (_req, res) => {
  const local = {
    role: process.env.TOONFLOW_RUNTIME_ROLE || "api",
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    memory: process.memoryUsage(),
    eventLoopDelayP95Ms: Number((delay.percentile(95) / 1e6).toFixed(2)),
    eventLoopDelayMaxMs: Number((delay.max / 1e6).toFixed(2)),
  };
  delay.reset();
  res.status(200).send(
    success({
      serverTime: Date.now(),
      apiUrl: RUNTIME_API_URL,
      local,
      supervisor: getRuntimeSupervisorSnapshot(),
      ipcConnections: getRuntimeConnections(),
      processes: getRuntimeMetrics(),
      database: getDbDiagnostics(),
      externalProcesses: getActiveCliProcesses(),
    }),
  );
});
