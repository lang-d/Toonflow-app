import express from "express";
import u from "@/utils";
import * as zod from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createUnifiedTask, formatUnifiedTaskEnvelope } from "@/services/taskCoordinator";
const router = express.Router();
interface OutlineItem {
  description: string;
  name: string;
}

interface OutlineData {
  chapterRange: number[];
  characters?: OutlineItem[];
  props?: OutlineItem[];
  scenes?: OutlineItem[];
}

interface NovelChapter {
  id: number;
  reel: string;
  chapter: string;
  chapterData: string;
  projectId: number;
}

type ItemType = "characters" | "props" | "scenes";

//润色提示词
export default router.post(
  "/",
  validateFields({
    items: zod.array(
      zod.object({
        assetsId: zod.number(),
        type: zod.string(),
        name: zod.string(),
        describe: zod.string(),
      }),
    ),
    projectId: zod.number(),
    concurrentCount: zod.number().int().min(1).optional(),
    otherTextPrompt: zod.string(),
  }),
  async (req, res) => {
    const { projectId, items, otherTextPrompt } = req.body;
    //获取风格
    const project = await u.db("o_project").where("id", projectId).select("artStyle", "type", "intro").first();
    //如果没有找到对应的项目，返回错误
    if (!project) return res.status(404).send(error("项目不存在"));

    // 预加载公共数据
    const assetsIds = items.map((item: { assetsId: number }) => item.assetsId);
    //查询所有资产，用于判断每个资产是否是衍生资产
    const assetsDataList = await u.db("o_assets").whereIn("id", assetsIds).select("id", "assetsId");
    if (!assetsDataList || assetsDataList.length === 0) return res.status(500).send(error("资产不存在"));
    const assetsDataMap = new Map(assetsDataList.map((a: any) => [a.id, a]));
    // 所有前置检测通过后，再批量更新状态为生成中
    await u.db("o_assets").whereIn("id", assetsIds).update({ promptState: "生成中" });

    const tasks = [];
    for (const item of items) {
      if (!assetsDataMap.has(item.assetsId)) continue;
      const task = await createUnifiedTask({
        projectId,
        taskClass: "资产提示词润色",
        taskType: "prompt",
        status: "queued",
        targetType: "asset",
        targetId: item.assetsId,
        businessType: "asset",
        businessId: item.assetsId,
        handler: "asset-prompt",
        describe: `润色资产提示词：${item.name}`,
        payload: {
          projectId,
          assetId: item.assetsId,
          type: item.type,
          name: item.name,
          describe: item.describe,
          otherTextPrompt,
        },
      });
      tasks.push({ assetId: item.assetsId, ...formatUnifiedTaskEnvelope(task, "asset", item.assetsId) });
    }
    return res.status(200).send(success({ total: tasks.length, tasks }));
  },
);
