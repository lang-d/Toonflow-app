import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createUnifiedTask, formatUnifiedTaskEnvelope } from "@/services/taskCoordinator";

const router = express.Router();

// 清洗小说原文，生成事件列表
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    novelIds: z.array(z.number()),
    concurrentCount: z.number().min(1).optional(),
  }),
  async (req, res) => {
    const { projectId, novelIds, concurrentCount = 5 } = req.body;

    const allChapters = await u.db("o_novel").where("projectId", projectId).whereIn("id", novelIds);
    if (allChapters.length === 0) {
      return res.status(400).send(error("没有对应章节"));
    }
    await u.db("o_novel").where("projectId", projectId).whereIn("id", novelIds).update({ eventState: 0, event: null });
    const tasks = [];
    for (const chapter of allChapters) {
      const task = await createUnifiedTask({
        projectId,
        taskClass: "小说事件提取",
        taskType: "prompt",
        status: "queued",
        targetType: "novel",
        targetId: chapter.id,
        businessType: "novel",
        businessId: Number(chapter.id),
        handler: "novel-event",
        describe: `提取章节事件：${chapter.chapter || chapter.id}`,
        payload: { projectId, novelId: chapter.id },
      });
      tasks.push({ novelId: chapter.id, ...formatUnifiedTaskEnvelope(task, "novel", chapter.id) });
    }
    return res.status(200).send(success({ total: tasks.length, tasks }));
  },
);
