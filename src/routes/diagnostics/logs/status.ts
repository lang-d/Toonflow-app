import express from "express";
import { success } from "@/lib/responseFormat";
import { getLoggerStatus } from "@/logger";
import { getDbDiagnostics } from "@/utils/db";
import { getRuntimeConnections, getRuntimeMetrics, getRuntimeSupervisorSnapshot } from "@/runtime/runtimeRegistry";

const router = express.Router();

export default router.post("/", async (_req, res) => {
  const status = getLoggerStatus();
  res.status(200).send(
    success({
      logDir: status.logDir,
      retentionDays: status.retentionDays,
      totalSize: status.totalSize,
      fileCount: status.files.length,
      recentErrors: status.recentErrors,
      lastLogAtByRole: status.lastLogAtByRole,
      runtime: {
        supervisor: getRuntimeSupervisorSnapshot(),
        connections: getRuntimeConnections(),
        metrics: getRuntimeMetrics(),
      },
      database: getDbDiagnostics(),
    }),
  );
});
