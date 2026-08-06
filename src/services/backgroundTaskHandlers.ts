import fs from "node:fs/promises";
import path from "node:path";
import { jsonSchema, tool } from "ai";
import { z } from "zod";
import u from "@/utils";
import { ensureThumbnail, type ThumbnailSize } from "@/utils/image";
import getPath from "@/utils/getPath";
import { cacheDataPath, storageMode } from "@/services/storagePaths";
import { buildAssetImageGenerationInput } from "@/services/assetImageGenerationInput";

type AssetType = "role" | "scene" | "tool";

const assetTypeConfig: Record<
  AssetType,
  { label: string; dir: string; visualManual: string; derivativeManual: string }
> = {
  role: {
    label: "角色",
    dir: "role",
    visualManual: "art_character",
    derivativeManual: "art_character_derivative",
  },
  scene: {
    label: "场景",
    dir: "scene",
    visualManual: "art_scene",
    derivativeManual: "art_scene_derivative",
  },
  tool: {
    label: "道具",
    dir: "props",
    visualManual: "art_prop",
    derivativeManual: "art_prop_derivative",
  },
};

export async function executeAssetImageTask(payload: any, task?: any) {
  const config = assetTypeConfig[payload.type as AssetType];
  if (!config) throw new Error(`不支持的资产类型: ${payload.type}`);
  const project = await u.db("o_project").where("id", payload.projectId).select("id").first();
  if (!project) throw new Error("项目不存在");
  const image = await u.db("o_image").where("id", payload.imageId).first();
  if (!image) throw new Error("资产图片记录不存在");
  if (image.state === "生成失败") throw new Error(image.errorReason || "资产图片任务已失败");

  const references = !task?.providerTaskId && payload.referencePath
    ? [{ type: "image" as const, base64: await u.oss.getImageBase64(payload.referencePath) }]
    : [];
  const outputPath = `/${payload.projectId}/${config.dir}/${u.uuid()}.jpg`;
  try {
    const imageResult = await u.Ai.Image(payload.model).runRecoverable(
      buildAssetImageGenerationInput(payload.prompt, references, payload.resolution),
      task,
    );
    if (imageResult.pending) return { __taskPending: true };
    const aiImage = imageResult.image!;
    await aiImage.save(outputPath);
    await u.db.transaction(async (trx: any) => {
      await trx("o_image").where("id", payload.imageId).update({
        state: "已完成",
        filePath: outputPath,
        type: payload.type,
        model: String(payload.model).split(/:(.+)/)[1],
        resolution: payload.resolution,
        errorReason: null,
      });
      await trx("o_assets").where("id", payload.assetId).update({ imageId: payload.imageId });
    });
    return { businessId: payload.assetId, media: await u.mediaRef.toMediaRef(outputPath, { source: "assets", sourceId: payload.assetId }) };
  } catch (error) {
    await u.db("o_image").where("id", payload.imageId).update({
      state: "生成失败",
      errorReason: u.error(error).message,
    });
    throw error;
  } finally {
    if (payload.referencePath) {
      const localPath = await u.oss.getLocalFilePath(payload.referencePath).catch(() => "");
      if (localPath) await fs.rm(localPath, { force: true }).catch(() => {});
    }
  }
}

export async function executeAssetPromptTask(payload: any) {
  const asset = await u.db("o_assets").where({ id: payload.assetId, projectId: payload.projectId }).first();
  if (!asset) throw new Error("资产不存在");
  const project = await u.db("o_project").where("id", payload.projectId).select("artStyle").first();
  if (!project) throw new Error("项目不存在");
  const config = assetTypeConfig[payload.type as AssetType];
  if (!config) throw new Error(`不支持的资产类型: ${payload.type}`);
  const visualManual = await u.getArtPrompt(
    project.artStyle as string,
    "art_skills",
    asset.assetsId ? config.derivativeManual : config.visualManual,
  );
  if (!visualManual) throw new Error("视觉手册未定义");
  try {
    const { _output } = (await u.Ai.Text("universalAi").invoke({
      system: `${visualManual}\n${payload.otherTextPrompt || ""}`,
      messages: [
        {
          role: "user",
          content: `${config.label}名称: ${payload.name}\n${config.label}描述: ${payload.describe}`,
        },
      ],
    })) as any;
    if (!_output) throw new Error("模型未返回润色结果");
    await u.db("o_assets").where("id", payload.assetId).update({
      prompt: _output,
      promptState: "已完成",
      promptErrorReason: null,
    });
    return { businessId: payload.assetId };
  } catch (error) {
    await u.db("o_assets").where("id", payload.assetId).update({
      promptState: "生成失败",
      promptErrorReason: u.error(error).message,
    });
    throw error;
  }
}

export async function executeStoryboardImageTask(payload: any, task?: any) {
  const storyboard = await u
    .db("o_storyboard")
    .where({ id: payload.storyboardId, projectId: payload.projectId, scriptId: payload.scriptId })
    .first();
  if (!storyboard) throw new Error("分镜不存在");
  const project = await u
    .db("o_project")
    .where("id", payload.projectId)
    .select("imageModel", "imageQuality", "videoRatio")
    .first();
  if (!project?.imageModel) throw new Error("项目未配置图片模型");
  const referenceList = [];
  if (!task?.providerTaskId) {
    const imageRows = await u
      .db("o_assets2Storyboard")
      .join("o_assets", "o_assets.id", "o_assets2Storyboard.assetId")
      .join("o_image", "o_image.id", "o_assets.imageId")
      .where("o_assets2Storyboard.storyboardId", payload.storyboardId)
      .orderBy("o_assets2Storyboard.rowid")
      .select("o_image.filePath");
    for (const row of imageRows) {
      if (row.filePath) referenceList.push({ type: "image" as const, base64: await u.oss.getImageBase64(row.filePath) });
    }
  }
  try {
    const imageResult = await u.Ai.Image(project.imageModel as `${string}:${string}`).runRecoverable({
      prompt: storyboard.prompt || "",
      referenceList,
      size: (project.imageQuality || "2K") as "1K" | "2K" | "4K",
      aspectRatio: (project.videoRatio || "16:9") as `${number}:${number}`,
    }, task);
    if (imageResult.pending) return { __taskPending: true };
    const image = imageResult.image!;
    const outputPath = `/${payload.projectId}/assets/${payload.scriptId}/${u.uuid()}.jpg`;
    await image.save(outputPath);
    await u.db("o_storyboard").where("id", payload.storyboardId).update({
      filePath: outputPath,
      state: "已完成",
      reason: null,
    });
    return { businessId: payload.storyboardId, media: await u.mediaRef.toMediaRef(outputPath, { source: "storyboard", sourceId: payload.storyboardId }) };
  } catch (error) {
    await u.db("o_storyboard").where("id", payload.storyboardId).update({
      filePath: "",
      state: "生成失败",
      reason: u.error(error).message,
    });
    throw error;
  }
}

export async function executeAudioBindingTask(payload: any) {
  const asset = await u.db("o_assets").where({ id: payload.assetId, projectId: payload.projectId }).first();
  if (!asset) throw new Error("资产不存在");
  const audioData = await u
    .db("o_assets")
    .where({ type: "audio", projectId: payload.projectId })
    .whereNull("assetsId")
    .select("id", "name", "describe");
  if (!audioData.length) throw new Error("暂无设置音频");
  const promptData = await u.db("o_prompt").where("type", "audioBindPrompt").first();
  const resultTool = tool({
    description: "匹配完成后必须调用此工具提交结果",
    inputSchema: jsonSchema<{ audioId?: number | null }>(
      z.object({ audioId: z.number().nullable().optional() }).toJSONSchema(),
    ),
    execute: async (result) => {
      await u.db.transaction(async (trx: any) => {
        await trx("o_assetsRole2Audio").where("assetsRoleId", asset.id).delete();
        if (result.audioId) {
          await trx("o_assetsRole2Audio").insert({ assetsRoleId: asset.id, assetsAudioId: result.audioId });
        }
        await trx("o_assets").where("id", asset.id).update({ audioBindState: "已完成" });
      });
      return "已保存";
    },
  });
  try {
    await u.Ai.Text("universalAi").invoke({
      messages: [
        { role: "system", content: promptData?.useData || promptData?.data || "" },
        {
          role: "user",
          content: `候选音频：\n${audioData
            .map((item) => `- ID:${item.id} | 名称:${item.name} | 描述:${item.describe || "无"}`)
            .join("\n")}\n待匹配资产：${asset.name}，${asset.describe || "无"}`,
        },
      ],
      tools: { resultTool },
    });
    return { businessId: payload.assetId };
  } catch (error) {
    await u.db("o_assets").where("id", payload.assetId).update({ audioBindState: "生成失败" } as any);
    throw error;
  }
}

export async function executeThumbnailTask(payload: {
  originalPath: string;
  thumbnailPath: string;
  size?: ThumbnailSize;
}) {
  const originalPath = await u.oss.getLocalFilePath(payload.originalPath);
  const thumbnailPath =
    storageMode() === "workspace"
      ? path.join(cacheDataPath("thumbnails"), payload.thumbnailPath.replace(/^[/\\]+/, ""))
      : path.join(getPath("oss"), payload.thumbnailPath.replace(/^[/\\]+/, ""));
  const result = await ensureThumbnail(originalPath, thumbnailPath, payload.size);
  if (!result) throw new Error(`缩略图生成失败: ${payload.originalPath}`);
  return {};
}

export function taskInputPath(projectId: number, extension: string) {
  return `/${projectId}/task-input/${u.uuid()}${extension.startsWith(".") ? extension : `.${extension}`}`;
}

export function extensionFromDataUrl(value: string) {
  const mime = value.match(/^data:([^;]+);base64,/i)?.[1]?.toLowerCase() || "";
  if (mime.includes("png")) return ".png";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  return ".jpg";
}
