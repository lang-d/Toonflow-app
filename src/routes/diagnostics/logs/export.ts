import express from "express";
import fs from "node:fs";
import path from "node:path";
import compressing from "compressing";
import { createLogger, getLoggerStatus } from "@/logger";
import { getDbDiagnostics } from "@/utils/db";
import { getRuntimeConnections, getRuntimeMetrics, getRuntimeSupervisorSnapshot } from "@/runtime/runtimeRegistry";

const router = express.Router();
const log = createLogger("diagnostics-logs");

function safeZipPath(value: string) {
  return value.replace(/\\/g, "/").replace(/^(\.\.\/)+/, "").replace(/^\/+/, "");
}

export default router.post("/", async (_req, res) => {
  const status = getLoggerStatus();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const zipStream = new compressing.zip.Stream();
  const summary = {
    generatedAt: new Date().toISOString(),
    logDir: status.logDir,
    retentionDays: status.retentionDays,
    totalSize: status.totalSize,
    fileCount: status.files.length,
    recentErrors: status.recentErrors,
    runtime: {
      supervisor: getRuntimeSupervisorSnapshot(),
      connections: getRuntimeConnections(),
      metrics: getRuntimeMetrics(),
    },
    database: getDbDiagnostics(),
  };

  zipStream.addEntry(Buffer.from(JSON.stringify(summary, null, 2), "utf8"), {
    relativePath: "diagnostics-summary.json",
  });

  for (const file of status.files.filter((item) => item.mtimeMs >= cutoff)) {
    if (!fs.existsSync(file.path) || !fs.statSync(file.path).isFile()) continue;
    zipStream.addEntry(fs.readFileSync(file.path), {
      relativePath: safeZipPath(path.join("logs", file.relativePath)),
    });
  }

  const filename = `toonflow-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
  log.info("Log export started", { event: "logs.export", fileCount: status.files.length, filename });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  zipStream.on("error", (error) => {
    log.error("Log export failed", { event: "logs.export.failed", error });
    if (!res.headersSent) res.status(500).send({ message: "日志导出失败" });
  });
  zipStream.pipe(res);
});
