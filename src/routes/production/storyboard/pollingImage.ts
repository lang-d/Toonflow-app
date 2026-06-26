import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { toTaskStatus } from "@/lib/taskStatus";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    ids: z.array(z.number()),
  }),
  async (req, res) => {
    const { ids } = req.body;
    const data = await u.db("o_storyboard").whereIn("id", ids).select("id", "state", "reason", "filePath", "prompt");
    const tasks = await u
      .db("o_editImageTask")
      .where("targetType", "storyboard")
      .whereIn("targetId", ids)
      .orderBy("updateTime", "desc")
      .orderBy("id", "desc")
      .select("id", "targetId", "nodeId", "status", "state", "reason");
    const latestTaskByStoryboard = new Map<number, any>();
    for (const task of tasks) {
      const storyboardId = Number(task.targetId);
      if (!latestTaskByStoryboard.has(storyboardId)) latestTaskByStoryboard.set(storyboardId, task);
    }
    const result = await Promise.all(
      data.map(async (item: any) => {
        const task = latestTaskByStoryboard.get(Number(item.id));
        return {
          ...item,
          status: task?.status || toTaskStatus(item.state) || "pending",
          legacyTaskId: task?.id,
          nodeId: task?.nodeId,
          reason: task?.reason || item.reason || "",
          src: item.filePath ? await u.oss.getSmallImageUrl(item.filePath) : null,
        };
      }),
    );
    res.status(200).send(success(result));
  },
);
