import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { cancelUnifiedTask, updateUnifiedTask } from "@/services/taskCoordinator";
import { cancelQueuedVideoGenerationTask, VideoQueueCancelError } from "@/utils/videoGenerationQueue";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ taskId: z.string().min(1) }),
  async (req, res) => {
    const task = await (u.db as any)("o_tasks").where("taskId", req.body.taskId).first();
    if (!task) return res.status(404).send(error("任务不存在"));
    try {
      if (task.businessType === "video-generation") {
        const queueTask = await (u.db as any)("o_videoGenerationTask").where("taskCenterId", task.id).first();
        if (!queueTask) return res.status(404).send(error("视频队列任务不存在"));
        await cancelQueuedVideoGenerationTask(Number(queueTask.id));
      } else {
        const result = await cancelUnifiedTask(req.body.taskId);
        if (!result.ok) return res.status(result.statusCode).send(error(result.message));
        if (task.businessType === "video-track-prompt" && task.businessId) {
          await (u.db as any)("o_videoTrack").where("id", task.businessId).update({ state: "已取消", reason: "用户取消" });
        }
        if (task.businessType === "image-flow" && task.businessId) {
          await (u.db as any)("o_editImageTask")
            .where("id", task.businessId)
            .whereIn("status", ["pending", "queued", "processing"])
            .update({ status: "cancelled", state: "已取消", reason: "用户取消", updateTime: Date.now() });
        }
      }
      const latest = await (u.db as any)("o_tasks").where("id", task.id).first();
      if (latest.status !== "cancelled") {
        await updateUnifiedTask(task.id, { status: "cancelled", phase: "cancelled", reason: "用户取消", clearLease: true });
      }
      res.status(200).send(success({ taskId: req.body.taskId, legacyTaskId: task.id, status: "cancelled", state: "已取消" }));
    } catch (cause) {
      const status = cause instanceof VideoQueueCancelError ? cause.statusCode : 500;
      res.status(status).send(error(u.error(cause).message));
    }
  },
);
