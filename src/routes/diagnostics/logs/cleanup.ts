import express from "express";
import { success } from "@/lib/responseFormat";
import { cleanupLogs, createLogger } from "@/logger";

const router = express.Router();
const log = createLogger("diagnostics-logs");

export default router.post("/", async (_req, res) => {
  const result = cleanupLogs(7);
  log.info("Log cleanup completed", { event: "logs.cleanup", ...result });
  res.status(200).send(success(result));
});
