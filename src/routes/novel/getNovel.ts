import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { novelEventIdsFromPayload } from "@/services/novelEventExtraction";
const router = express.Router();

// 获取原文数据
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    page: z.number(),
    limit: z.number(),
    search: z.string().optional(),
  }),
  async (req, res) => {
    const { projectId, page, limit, search } = req.body;
    const offset = (page - 1) * limit;
    const data = await u
      .db("o_novel")
      .where("projectId", projectId)
      .select("id", "chapterIndex as index", "reel", "chapter", "chapterData", "event", "eventState", "errorReason")
      .andWhere((qb) => {
        if (search) {
          qb.where("chapter", "like", `%${search}%`);
        }
      })
      .orderBy("chapterIndex", "asc")
      .limit(limit)
      .offset(offset);

    const activeTasks = await u
      .db("o_tasks")
      .where({ projectId, handler: "novel-event" })
      .whereIn("status", ["pending", "queued", "submitting", "processing"])
      .orderBy("updateTime", "desc")
      .select("id", "taskId", "status", "phase", "progress", "reason", "payloadJson");
    const taskByNovelId = new Map<number, any>();
    for (const task of activeTasks) {
      for (const novelId of novelEventIdsFromPayload(task.payloadJson)) {
        if (!taskByNovelId.has(novelId)) taskByNovelId.set(novelId, task);
      }
    }
    const returnData = data.map((item: any) => {
      const task = taskByNovelId.get(Number(item.id));
      if (!task) return { ...item, eventExtraction: null };
      return {
        ...item,
        taskId: task.taskId,
        legacyTaskId: Number(task.id),
        eventExtraction: {
          status: task.status,
          taskId: task.taskId,
          legacyTaskId: Number(task.id),
          phase: task.phase || "",
          progress: Number(task.progress || 0),
          reason: task.reason || "",
        },
      };
    });

    // 统计总数
    const totalQuery = (await u
      .db("o_novel")
      .where("projectId", projectId)
      .andWhere((qb) => {
        if (search) {
          qb.where("chapter", "like", `%${search}%`);
        }
      })
      .count("* as total")
      .first()) as any;

    res.status(200).send(success({ data: returnData, total: totalQuery.total }));
  },
);
