import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { tool, jsonSchema } from "ai";
import { createUnifiedTask, formatUnifiedTaskEnvelope } from "@/services/taskCoordinator";
const router = express.Router();

// 获取资产
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    assetsIds: z.array(z.number()),
    concurrentCount: z.number().min(1).optional(),
  }),
  async (req, res) => {
    const { projectId, assetsIds, concurrentCount } = req.body;
    const assetsData = await u.db("o_assets").whereIn("id", assetsIds).andWhere("projectId", projectId).select("id", "name", "describe", "type");

    const audioData = await u
      .db("o_assets")
      .where("type", "audio")
      .whereNull("assetsId")
      .andWhere("projectId", projectId)
      .select("id", "name", "describe");

    if (!audioData.length) return res.status(400).send(error("暂无设置音频，请先前往资产中心上传音频"));

    await u
      .db("o_assets")
      .whereIn(
        "id",
        assetsData.map((i) => i.id),
      )
      .update("audioBindState", "生成中");
    const tasks = [];
    for (const asset of assetsData) {
      const task = await createUnifiedTask({
        projectId,
        taskClass: "角色音色匹配",
        taskType: "audio",
        status: "queued",
        targetType: "asset",
        targetId: asset.id,
        businessType: "asset",
        businessId: Number(asset.id),
        handler: "audio-binding",
        describe: `匹配角色音色：${asset.name}`,
        payload: { projectId, assetId: asset.id },
      });
      tasks.push({ assetId: asset.id, ...formatUnifiedTaskEnvelope(task, "asset", asset.id) });
    }
    res.status(200).send(success({ total: tasks.length, tasks }));
  },
);
