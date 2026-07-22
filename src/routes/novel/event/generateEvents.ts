import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { enqueueNovelEventExtraction } from "@/services/novelEventExtraction";

const router = express.Router();

// 清洗小说原文，生成事件列表
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    novelIds: z.array(z.number()),
  }),
  async (req, res) => {
    const { projectId, novelIds } = req.body;
    if (!novelIds.length) return res.status(400).send(error("没有对应章节"));
    const result = await enqueueNovelEventExtraction({ projectId, novelIds });
    return res.status(200).send(success(result));
  },
);
