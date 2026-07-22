import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { enqueueNovelEventExtraction } from "@/services/novelEventExtraction";
const router = express.Router();

// 新增原文数据
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    data: z.array(
      z.object({
        index: z.number(),
        reel: z.string(),
        chapter: z.string(),
        chapterData: z.string(),
      }),
    ),
  }),
  async (req, res) => {
    const { projectId, data } = req.body;
    const totalNovelId = [];
    const getLastChapterIndex = await u.db("o_novel").where("projectId", projectId).select("chapterIndex").orderBy("chapterIndex", "desc").first();
    let lastChapterIndex = 0;
    if (getLastChapterIndex) {
      lastChapterIndex = getLastChapterIndex.chapterIndex!;
    }
    for (const item of data) {
      const [id] = await u.db("o_novel").insert({
        projectId,
        chapterIndex: ++lastChapterIndex,
        reel: item.reel,
        chapter: item.chapter,
        chapterData: item.chapterData,
        createTime: Date.now(),
        eventState: 0,
      });
      totalNovelId.push(id);
    }
    const eventExtraction = await enqueueNovelEventExtraction({ projectId, novelIds: totalNovelId });

    res.status(200).send(success({ message: "新增原文成功", eventExtraction }));
  },
);
