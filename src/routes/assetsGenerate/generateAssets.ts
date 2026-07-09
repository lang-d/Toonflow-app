import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createUnifiedTask, formatUnifiedTaskEnvelope } from "@/services/taskCoordinator";
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

// ─── 构建生成提示词 ──────────────────────────────────────────

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

// ─── 生成资产图片 ────────────────────────────────────────────

const requestSchema = {
  projectId: z.number(),
  model: z.string().optional(),
  resolution: z.string().optional(),
  id: z.number(),
  type: z.string(),
  name: z.string(),
  prompt: z.string(),
  base64: z.string().optional().nullable(),
};

export default router.post("/", validateFields(requestSchema), async (req, res) => {
  const { projectId, id, type, name, prompt, base64 } = req.body;

  // 1. 查询项目 & 获取类型配置
  const project = await u.db("o_project").where("id", projectId).select("artStyle", "type", "intro", "imageModel", "imageQuality").first();
  if (!project) return res.status(404).send(error("项目不存在"));
  const model = req.body.model || project.imageModel;
  const resolution = req.body.resolution || project.imageQuality;
  if (!model) return res.status(400).send(error("项目未配置默认图片模型"));
  if (!resolution) return res.status(400).send(error("项目未配置默认图片质量"));

  const cfg = assetTypeConfig[type as AssetType];
  if (type === "storyboard") return res.status(400).send(error("storyboard image generation must use /production/storyboard/batchGenerateImage."));
  if (!cfg) return res.status(400).send(error("不支持的类型"));

  // 2. 创建图片占位记录
  const [imageId] = await u.db("o_image").insert({
    type,
    state: "生成中",
    assetsId: id,
    model: model.split(/:(.+)/)[1],
    resolution,
  });
  await u.db("o_assets").where("id", id).update({ imageId });

  let referencePath: string | undefined;
  if (base64) {
    referencePath = taskInputPath(projectId, extensionFromDataUrl(base64));
    await u.oss.writeFile(referencePath, base64);
  }
  await u.db("o_image").where("id", imageId).update({ state: "排队中" });
  const task = await createUnifiedTask({
    projectId,
    taskClass: cfg.taskClass,
    taskType: "asset",
    status: "queued",
    targetType: "asset",
    targetId: id,
    businessType: "image",
    businessId: Number(imageId),
    handler: "asset-image",
    model,
    describe: `生成${cfg.label}图：${name}`,
    payload: {
      projectId,
      imageId: Number(imageId),
      assetId: id,
      type,
      name,
      prompt,
      model,
      resolution,
      referencePath,
    },
  });
  return res.status(200).send(
    success({
      assetsId: id,
      imageId: Number(imageId),
      ...formatUnifiedTaskEnvelope(task, "asset", id),
      status: "queued",
      state: "排队中",
    }),
  );
});
