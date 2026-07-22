import u from "@/utils";
import { createUnifiedTask, formatUnifiedTaskEnvelope } from "@/services/taskCoordinator";
import { extensionFromDataUrl, taskInputPath } from "@/services/backgroundTaskHandlers";

export type GeneratableAssetType = "role" | "scene" | "tool";

type AssetImageRequestItem = {
  id: number;
  type: string;
  name: string;
  prompt: string;
  base64?: string | null;
};

const ASSET_TYPE_CONFIG: Record<GeneratableAssetType, { label: string; taskClass: string }> = {
  role: { label: "角色", taskClass: "角色图生成" },
  scene: { label: "场景", taskClass: "场景图生成" },
  tool: { label: "道具", taskClass: "道具图生成" },
};

function assertAssetType(type: string): asserts type is GeneratableAssetType {
  if (!Object.hasOwn(ASSET_TYPE_CONFIG, type)) {
    throw new Error("Unsupported asset image type: " + type + ". Supported types: role, scene, tool.");
  }
}

export async function enqueueAssetImageGeneration(input: {
  projectId: number;
  items: AssetImageRequestItem[];
  model?: string | null;
  resolution?: string | null;
}) {
  if (!input.items.length) return { total: 0, tasks: [] as any[] };
  for (const item of input.items) {
    if (item.type === "storyboard") {
      throw new Error("storyboard image generation must use /production/storyboard/batchGenerateImage.");
    }
    assertAssetType(item.type);
  }

  const project = await u.db("o_project").where("id", input.projectId).select("imageModel", "imageQuality").first();
  if (!project) throw new Error("Project does not exist");
  const model = String(input.model || project.imageModel || "").trim();
  const resolution = String(input.resolution || project.imageQuality || "").trim();
  if (!model) throw new Error("Project image model is not configured");
  if (!resolution) throw new Error("Project image quality is not configured");

  const tasks = [] as any[];
  for (const item of input.items) {
    const config = ASSET_TYPE_CONFIG[item.type as GeneratableAssetType];
    const asset = await u.db("o_assets").where({ id: item.id, projectId: input.projectId }).first("id", "type");
    if (!asset || asset.type !== item.type) {
      throw new Error(`Asset ${item.id} is not a ${item.type} asset in this project`);
    }

    const [imageId] = await u.db("o_image").insert({
      type: item.type,
      state: "排队中",
      assetsId: item.id,
      model: model.split(/:(.+)/)[1],
      resolution,
    });
    await u.db("o_assets").where({ id: item.id, projectId: input.projectId }).update({ imageId });

    let referencePath: string | undefined;
    if (item.base64) {
      referencePath = taskInputPath(input.projectId, extensionFromDataUrl(item.base64));
      await u.oss.writeFile(referencePath, item.base64);
    }

    const task = await createUnifiedTask({
      projectId: input.projectId,
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
        projectId: input.projectId,
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
    tasks.push({ assetId: item.id, imageId: Number(imageId), ...formatUnifiedTaskEnvelope(task, "asset", item.id) });
  }
  return { total: tasks.length, tasks };
}
