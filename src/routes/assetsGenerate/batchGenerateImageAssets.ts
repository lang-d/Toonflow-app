import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createUnifiedTask } from "@/services/taskCoordinator";
import { extensionFromDataUrl, taskInputPath } from "@/services/backgroundTaskHandlers";

const router = express.Router();

type AssetType = "role" | "scene" | "tool";

interface AssetTypeConfig {
  label: string;
  taskClass: string;
  dir: string;
  promptTitle: string;
  promptEnd: string;
}

const assetTypeConfig: Record<AssetType, AssetTypeConfig> = {
  role: {
    label: "角色",
    taskClass: "角色图生成",
    dir: "role",
    promptTitle: "角色标准四视图",
    promptEnd: "人物角色四视图",
  },
  scene: {
    label: "场景",
    taskClass: "场景图生成",
    dir: "scene",
    promptTitle: "标准场景图",
    promptEnd: "标准场景图",
  },
  tool: {
    label: "道具",
    taskClass: "道具图生成",
    dir: "props",
    promptTitle: "标准道具图",
    promptEnd: "标准道具图",
  },
};

function buildPrompt(cfg: AssetTypeConfig, artStyle: string, name: string, prompt: string): string {
  return `
    请根据以下参数生成${cfg.promptTitle}：

    **基础参数：**
    - 画风风格: ${artStyle || "未指定"}

    **${cfg.label}设定：**
    - 名称:${name},
    - 提示词:${prompt},

    请严格按照系统规范生成${cfg.promptEnd}。
  `;
}

const requestSchema = {
  projectId: z.number(),
  model: z.string(),
  resolution: z.string(),
  concurrentCount: z.number().int().min(1).optional(),
  items: z.array(
    z.object({
      id: z.number(),
      type: z.enum(["role", "scene", "tool", "storyboard"]),
      name: z.string(),
      prompt: z.string(),
      base64: z.string().optional().nullable(),
    }),
  ),
};

export default router.post("/", validateFields(requestSchema), async (req, res) => {
  const { projectId, model, resolution, items } = req.body;

  // 1. 查询项目
  const project = await u.db("o_project").where("id", projectId).select("artStyle", "type", "intro").first();
  if (!project) return res.status(500).send(error("项目为空"));

  const tasks = [];
  for (const item of items) {
    const [imageId] = await u.db("o_image").insert({
      type: item.type,
      state: "排队中",
      assetsId: item.id,
    });
    await u.db("o_assets").where("id", item.id).update({ imageId });
    let referencePath: string | undefined;
    if (item.base64) {
      referencePath = taskInputPath(projectId, extensionFromDataUrl(item.base64));
      await u.oss.writeFile(referencePath, item.base64);
    }
    const config = assetTypeConfig[item.type as AssetType];
    if (!config) continue;
    const task = await createUnifiedTask({
      projectId,
      taskClass: config.taskClass,
      taskType: "asset",
      status: "queued",
      targetType: "asset",
      targetId: item.id,
      businessType: "image",
      businessId: Number(imageId),
      handler: "asset-image",
      model,
      describe: `生成${config.label}图：${item.name}`,
      payload: {
        projectId,
        imageId: Number(imageId),
        assetId: item.id,
        type: item.type,
        name: item.name,
        prompt: item.prompt,
        model,
        resolution,
        referencePath,
      },
    });
    tasks.push({ assetId: item.id, imageId: Number(imageId), taskId: task.taskId, legacyTaskId: task.legacyTaskId });
  }
  return res.status(200).send(success({ total: tasks.length, tasks }));
});
