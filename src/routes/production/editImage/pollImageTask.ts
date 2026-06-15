import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { toTaskStatus } from "@/lib/taskStatus";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

async function formatTask(taskId: number, task: any) {
  if (!task) {
    return {
      taskId,
      nodeId: "",
      status: "failed",
      state: "生成失败",
      reason: "任务不存在",
    };
  }
  const result: Record<string, unknown> = {
    taskId: task.id,
    nodeId: task.nodeId || "",
    status: task.status || toTaskStatus(task.state) || "processing",
    state: task.state,
  };
  if (result.status === "completed") {
    result.url = task.url ? await u.oss.getSmallImageUrl(task.url) : "";
    result.historyId = task.id;
  }
  if (result.status === "failed" || result.status === "cancelled") result.reason = task.reason || "";
  return result;
}

export default router.post(
  "/",
  validateFields({
    taskId: z.union([z.string(), z.number()]).transform(Number).optional(),
    taskIds: z.array(z.union([z.string(), z.number()]).transform(Number)).optional(),
  }),
  async (req, res) => {
    const singleTaskId = req.body.taskId;
    const taskIds: number[] = singleTaskId != null ? [singleTaskId] : req.body.taskIds || [];
    if (!taskIds.length) return res.status(400).send(error("taskId 不能为空"));
    if (req.body.taskIds) console.warn("[deprecated] pollImageTask taskIds[]; use taskId");

    const tasks = await u.db("o_editImageTask").whereIn("id", taskIds).select("id", "nodeId", "status", "state", "url", "reason");
    const result = await Promise.all(taskIds.map((taskId) => formatTask(taskId, tasks.find((task: any) => task.id === taskId))));
    res.status(200).send(success(singleTaskId != null ? result[0] : result));
  },
);
