import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

const router = express.Router();

export default router.post("/", async (_req, res) => {
  try {
    const now = Date.now();
    const rows = await u
      .db("o_videoGenerationTask as detail")
      .join("o_tasks as task", "task.id", "detail.taskCenterId")
      .where("detail.vendorId", "dreamina")
      .whereIn("task.status", ["pending", "queued", "submitting", "processing"])
      .select(
        "detail.id",
        "detail.videoId",
        "detail.model",
        "detail.providerModelKey",
        "detail.providerCapacityKey",
        "detail.providerAccountId",
        "task.providerSubmittedAt as providerSubmittedAt",
        "task.providerTaskId as submitId",
        "detail.nextSubmitTime",
        "detail.nextPollTime",
        "detail.pollCount",
        "detail.providerQueueStatus",
        "detail.providerQueueIndex",
        "detail.providerQueueLength",
        "detail.startTime",
        "detail.updateTime",
        "task.status as status",
        "task.phase as phase",
        "task.state as state",
        "task.progress as progress",
      );
    const tasks = rows.map((row) => ({
      ...row,
      providerWorkElapsedSec: row.providerSubmittedAt
        ? Math.max(0, Math.round((now - Number(row.providerSubmittedAt)) / 1000))
        : 0,
    }));
    const capacities = await u.db("o_videoProviderCapacity").where("vendorId", "dreamina").select("*");
    const models = await u.vendor.getModelList("dreamina");
    const modelConfig = new Map<string, any>(
      models
        .filter((item: any) => item?.modelName)
        .map((item: any) => [u.dreaminaCli.getDreaminaProviderModelKey(item.modelName), item.queueConfig || {}]),
    );

    const summary = tasks.reduce((acc: Record<string, any>, row: any) => {
      const modelName = String(row.model || "").replace(/^dreamina:/, "");
      const key = row.providerModelKey || u.dreaminaCli.getDreaminaProviderModelKey(modelName);
      const item =
        acc[key] ||
        {
          providerModelKey: key,
          configuredConcurrent: Number(modelConfig.get(key)?.maxConcurrent || 1),
          maxWorkHours: Number(
            modelConfig.get(key)?.maxWorkHours ?? modelConfig.get(key)?.maxWaitHours ?? 6,
          ),
          knownActive: 0,
          occupiedSlots: 0,
          submitting: 0,
          confirming: 0,
          processing: 0,
          waiting: 0,
          total: 0,
          capacityBlocked: false,
        };
      item.total += 1;
      if (row.phase === "submitting") {
        item.submitting += 1;
        item.occupiedSlots += 1;
      } else if (row.phase === "confirming") {
        item.confirming += 1;
        item.occupiedSlots += 1;
      } else if (row.status === "processing" && row.providerCapacityKey) {
        item.processing += 1;
        if (row.submitId) item.knownActive += 1;
        item.occupiedSlots += 1;
      } else {
        item.waiting += 1;
      }
      if (row.providerQueueIndex != null) item.queueIndex = row.providerQueueIndex;
      if (row.providerQueueLength != null) item.queueLength = row.providerQueueLength;
      acc[key] = item;
      return acc;
    }, {});

    for (const capacity of capacities) {
      const key = capacity.providerModelKey;
      const item =
        summary[key] ||
        {
          providerModelKey: key,
          configuredConcurrent: Number(modelConfig.get(key)?.maxConcurrent || 1),
          maxWorkHours: Number(
            modelConfig.get(key)?.maxWorkHours ?? modelConfig.get(key)?.maxWaitHours ?? 6,
          ),
          knownActive: 0,
          occupiedSlots: 0,
          submitting: 0,
          confirming: 0,
          processing: 0,
          waiting: 0,
          total: 0,
          capacityBlocked: false,
        };
      item.capacityBlocked = Boolean(capacity.capacityBlocked && Number(capacity.blockedUntil || 0) > now);
      item.blockedUntil = capacity.blockedUntil || undefined;
      item.lastProviderCode = capacity.lastProviderCode || undefined;
      summary[key] = item;
    }

    res.status(200).send(success({ summary: Object.values(summary), tasks }));
  } catch (err) {
    res.status(500).send(error(u.error(err).message));
  }
});
