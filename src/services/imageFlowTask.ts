import axios from "axios";
import u from "@/utils";
import { toLegacyTaskState, type TaskStatus } from "@/lib/taskStatus";
import {
  DERIVE_ASSET_DEFAULT_RATIO,
  ensureDeriveAssetImageFlow,
  ensureStoryboardImageFlow,
  updateImageFlowNodeWithDb,
  type ImageFlowTargetType,
} from "@/services/imageFlow";
import { adoptLegacyTask, updateUnifiedTask } from "@/services/taskCoordinator";

export interface CreateImageFlowTaskInput {
  projectId: number;
  scriptId: number;
  targetType?: ImageFlowTargetType;
  targetId?: number;
  deriveAssetId?: number;
  flowId?: number | null;
  nodeId?: string;
  references: string[];
  referenceMediaPaths?: string[];
  model: string;
  quality: string;
  ratio: string;
  prompt: string;
}

type ImageFlowPromptSource = "request" | "node" | "asset";

interface ResolvedImageFlowPrompt {
  prompt: string;
  source: ImageFlowPromptSource;
  shouldBackfillNodePrompt: boolean;
}

function normalizePrompt(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRatio(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isValidRatio(value: string): boolean {
  return /^\d+:\d+$/.test(value);
}

function getStoredNodePrompt(flowData: unknown, nodeId: string): string {
  if (!flowData || !nodeId) return "";
  try {
    const flow = JSON.parse(String(flowData));
    const node = (Array.isArray(flow.nodes) ? flow.nodes : []).find((item: any) => item?.id === nodeId && item?.type === "generated");
    return normalizePrompt(node?.data?.prompt);
  } catch {
    return "";
  }
}

export async function resolveImageFlowPrompt(
  db: any,
  input: {
    prompt: string;
    flowId?: number | null;
    targetType?: ImageFlowTargetType;
    targetId?: number | null;
    deriveAssetId?: number | null;
  },
  nodeId: string,
): Promise<ResolvedImageFlowPrompt> {
  const requestPrompt = normalizePrompt(input.prompt);
  if (requestPrompt) return { prompt: requestPrompt, source: "request", shouldBackfillNodePrompt: false };

  let nodePrompt = "";
  if (input.flowId && nodeId) {
    const flowRow = await db("o_imageFlow").where("id", input.flowId).first("flowData");
    nodePrompt = getStoredNodePrompt(flowRow?.flowData, nodeId);
    if (nodePrompt) return { prompt: nodePrompt, source: "node", shouldBackfillNodePrompt: false };
  }

  const targetType = input.targetType || (input.deriveAssetId ? "deriveAsset" : undefined);
  const targetId = input.targetId ?? input.deriveAssetId ?? null;
  if (targetType === "deriveAsset" && targetId != null) {
    const asset = await db("o_assets").where("id", targetId).first("prompt");
    const assetPrompt = normalizePrompt(asset?.prompt);
    if (assetPrompt) return { prompt: assetPrompt, source: "asset", shouldBackfillNodePrompt: Boolean(input.flowId && nodeId && !nodePrompt) };
  }

  throw new Error("请先填写生图提示语");
}

async function urlToBase64(imageUrl: string): Promise<string> {
  const internalPath = u.mediaRef.normalizeMediaPath(imageUrl);
  if (internalPath) return u.oss.getImageBase64(internalPath);
  const url = await u.oss.getFileUrl(u.replaceUrl(imageUrl));
  const response = await axios.get(url, { responseType: "arraybuffer" });
  const contentType = response.headers["content-type"] || "image/png";
  return `data:${contentType};base64,${Buffer.from(response.data).toString("base64")}`;
}

async function finishTask(
  taskId: number,
  taskCenterId: number,
  flowId: number | null | undefined,
  nodeId: string,
  status: TaskStatus,
  nodePatch: Record<string, unknown>,
  reason = "",
  url = "",
  target?: {
    targetType?: ImageFlowTargetType;
    targetId: number | null;
    projectId: number;
    model: string;
    quality: string;
  },
  options: { allowMissingNode?: boolean } = {},
) {
  const currentTask = await u.db("o_editImageTask").where("id", taskId).first("status", "reason");
  if (currentTask?.status === "cancelled" && status !== "cancelled") {
    await updateUnifiedTask(taskCenterId, {
      status: "cancelled",
      phase: "cancelled",
      reason: currentTask.reason || "任务已取消",
      clearLease: true,
    });
    return;
  }
  const state = toLegacyTaskState(status);
  await u.db.transaction(async (trx: any) => {
    await trx("o_editImageTask").where("id", taskId).update({
      status,
      state,
      reason,
      url,
      updateTime: Date.now(),
    });
    const updated = await updateImageFlowNodeWithDb(trx, flowId, nodeId, nodePatch);
    if (flowId && !updated && !options.allowMissingNode) throw new Error("图片任务对应的画布节点不存在");
    if (status === "completed" && url && target?.targetType === "deriveAsset" && target.targetId != null && flowId) {
      const asset = await trx("o_assets")
        .where({ id: target.targetId, projectId: target.projectId })
        .first("id", "type");
      if (!asset) throw new Error("衍生资产不存在");
      const [imageId] = await trx("o_image").insert({
        filePath: url,
        state: "已完成",
        assetsId: target.targetId,
        type: asset.type,
        model: target.model.split(/:(.+)/)[1] || target.model,
        resolution: target.quality,
      });
      await trx("o_assets").where({ id: target.targetId, projectId: target.projectId }).update({ flowId, imageId });
      const flowRow = await trx("o_imageFlow").where("id", flowId).first("flowData");
      if (flowRow?.flowData) {
        const flow = JSON.parse(flowRow.flowData);
        flow.selectedImageUrl = url;
        await trx("o_imageFlow").where("id", flowId).update({ flowData: JSON.stringify(flow) });
      }
    }
    if (target?.targetType === "storyboard" && target.targetId != null) {
      if (status === "completed" && url && flowId) {
        await trx("o_storyboard")
          .where({ id: target.targetId, projectId: target.projectId })
          .update({
            flowId,
            filePath: url,
            state: toLegacyTaskState("completed"),
            reason: null,
            shouldGenerateImage: 1,
          });
        const flowRow = await trx("o_imageFlow").where("id", flowId).first("flowData");
        if (flowRow?.flowData) {
          const flow = JSON.parse(flowRow.flowData);
          flow.selectedImageUrl = url;
          await trx("o_imageFlow").where("id", flowId).update({ flowData: JSON.stringify(flow) });
        }
      } else if (status === "failed") {
        await trx("o_storyboard")
          .where({ id: target.targetId, projectId: target.projectId })
          .update({
            state: toLegacyTaskState("failed"),
            reason,
          });
      }
    }
  });
  await updateUnifiedTask(taskCenterId, {
    status,
    phase: status,
    progress: status === "completed" ? 100 : undefined,
    reason,
    result: url ? { media: await u.mediaRef.toMediaRef(url, { source: "generated", sourceId: taskId }), historyId: taskId, businessId: taskId } : undefined,
    clearLease: status === "completed" || status === "failed" || status === "cancelled",
  });
}

export async function failInterruptedImageFlowTask(input: {
  taskCenterId: number;
  taskId?: number | null;
  reason: string;
}) {
  const legacyTask = await u
    .db("o_editImageTask")
    .where((builder: any) => {
      if (input.taskId != null) builder.where("id", input.taskId);
      builder.orWhere("taskCenterId", input.taskCenterId);
    })
    .orderBy("updateTime", "desc")
    .orderBy("id", "desc")
    .first();
  if (!legacyTask) {
    await updateUnifiedTask(input.taskCenterId, {
      status: "failed",
      phase: "failed",
      reason: input.reason,
      clearLease: true,
    });
    return;
  }
  if (["completed", "failed", "cancelled"].includes(String(legacyTask.status || ""))) return;
  const targetType =
    legacyTask.targetType === "storyboard" || legacyTask.targetType === "deriveAsset"
      ? legacyTask.targetType
      : undefined;
  await finishTask(
    Number(legacyTask.id),
    input.taskCenterId,
    legacyTask.flowId == null ? null : Number(legacyTask.flowId),
    String(legacyTask.nodeId || ""),
    "failed",
    {
      taskId: null,
      status: "failed",
      state: "failed",
      reason: input.reason,
    },
    input.reason,
    "",
    {
      targetType,
      targetId: legacyTask.targetId == null ? null : Number(legacyTask.targetId),
      projectId: Number(legacyTask.projectId || 0),
      model: legacyTask.model || "",
      quality: legacyTask.quality || "",
    },
    { allowMissingNode: true },
  );
}

interface ExecuteImageFlowPayload {
  input: CreateImageFlowTaskInput;
  taskId: number;
  taskCenterId: number;
  nodeId: string;
  targetType?: ImageFlowTargetType;
  targetId: number | null;
  deriveAssetId: number | null;
}

export async function executeImageFlowTask(payload: ExecuteImageFlowPayload, task?: any) {
  const { input, taskId, taskCenterId, nodeId, targetType, targetId, deriveAssetId } = payload;
  const model = input.model as `${string}:${string}`;
  const quality = input.quality as "1K" | "2K" | "4K";
  const ratio = input.ratio as `${number}:${number}`;
  try {
    await updateUnifiedTask(taskCenterId, { status: "processing", phase: "references", progress: 10 });
    const referenceList = task?.providerTaskId
      ? []
      : await Promise.all(
          (input.referenceMediaPaths || input.references || []).map(async (url) => ({ type: "image" as const, base64: await urlToBase64(url) })),
        );
    await updateUnifiedTask(taskCenterId, { status: "processing", phase: "provider-request", progress: 35 });
    const imageResult = await u.Ai.Image(model).runRecoverable({
      prompt: input.prompt,
      referenceList,
      size: quality,
      aspectRatio: ratio,
    }, task);
    if (imageResult.pending) return { __taskPending: true, taskId, nodeId, targetType, targetId, deriveAssetId };
    const image = imageResult.image!;
    const savePath = `/${input.projectId}/imageFlow/${input.scriptId}/${u.uuid()}.jpg`;
    await image.save(savePath);
    await finishTask(
      taskId,
      taskCenterId,
      input.flowId,
      nodeId,
      "completed",
      {
        taskId: null,
        status: "completed",
        state: "success",
        reason: "",
        generatedImage: savePath,
        historyId: taskId,
        selectedResult: {
          id: taskId,
          url: savePath,
          prompt: input.prompt,
          model: input.model,
          ratio: input.ratio,
          quality: input.quality,
          createTime: Date.now(),
        },
        prompt: input.prompt,
      },
      "",
      savePath,
      {
        targetType,
        targetId,
        projectId: input.projectId,
        model: input.model,
        quality: input.quality,
      },
    );
  } catch (err) {
    const reason = u.error(err).message;
    await finishTask(
      taskId,
      taskCenterId,
      input.flowId,
      nodeId,
      "failed",
      {
        taskId: null,
        status: "failed",
        state: "failed",
        reason,
      },
      reason,
      "",
      {
        targetType,
        targetId,
        projectId: input.projectId,
        model: input.model,
        quality: input.quality,
      },
    );
    throw err;
  }
  return { taskId, nodeId, targetType, targetId, deriveAssetId };
}

export async function createImageFlowTask(input: CreateImageFlowTaskInput) {
  const targetType = input.targetType || (input.deriveAssetId ? "deriveAsset" : undefined);
  const targetId = input.targetId ?? input.deriveAssetId ?? null;
  const deriveAssetId = input.deriveAssetId ?? (targetType === "deriveAsset" ? targetId : null);
  const requestedNodeId = input.nodeId;
  if (!input.model.includes(":")) throw new Error("模型标识必须使用 vendorId:modelName 格式");
  if (!["1K", "2K", "4K"].includes(input.quality)) throw new Error(`不支持的图片质量: ${input.quality}`);
  const inputRatio = normalizeRatio(input.ratio);
  if (inputRatio && !isValidRatio(inputRatio)) throw new Error(`不支持的图片比例: ${input.ratio}`);
  if (targetType !== "deriveAsset" && targetType !== "storyboard" && !isValidRatio(inputRatio)) throw new Error(`不支持的图片比例: ${input.ratio}`);
  input = { ...input, ratio: inputRatio };
  if (targetType === "deriveAsset" && targetId != null) {
    const ensured = await ensureDeriveAssetImageFlow({
      projectId: input.projectId,
      scriptId: input.scriptId,
      targetId,
      model: input.model,
      quality: input.quality,
      ratio: input.ratio || DERIVE_ASSET_DEFAULT_RATIO,
    });
    input = {
      ...input,
      flowId: ensured.flowId,
      nodeId: requestedNodeId || ensured.nodeId,
      ratio: requestedNodeId ? inputRatio || ensured.ratio : ensured.ratio,
      referenceMediaPaths: input.referenceMediaPaths?.length ? input.referenceMediaPaths : ensured.referenceMediaPaths,
    };
  }
  if (targetType === "storyboard" && targetId != null) {
    const ensured = await ensureStoryboardImageFlow({
      projectId: input.projectId,
      scriptId: input.scriptId,
      targetId,
      model: input.model,
      quality: input.quality,
      ratio: input.ratio,
    });
    input = {
      ...input,
      flowId: ensured.flowId,
      nodeId: requestedNodeId || ensured.nodeId,
      ratio: requestedNodeId ? inputRatio || ensured.ratio : ensured.ratio,
      referenceMediaPaths: input.referenceMediaPaths?.length ? input.referenceMediaPaths : ensured.referenceMediaPaths,
    };
  }
  if (!isValidRatio(input.ratio)) throw new Error(`不支持的图片比例: ${input.ratio}`);
  const legacy = !input.flowId || !input.nodeId || !targetType || !targetId;
  const nodeId = input.nodeId || `legacy:${u.uuid()}`;
  if (legacy) {
    console.warn("[deprecated] generateFlowImageTask should include flowId, nodeId, targetType and targetId");
  }

  const { taskCenterId, taskId, resolvedInput } = await u.db.transaction(async (trx: any) => {
    const promptResolution = await resolveImageFlowPrompt(trx, { ...input, targetType, targetId, deriveAssetId }, nodeId);
    const resolvedInput = { ...input, prompt: promptResolution.prompt };
    const [rawTaskCenterId] = await trx("o_tasks").insert({
      projectId: input.projectId,
      taskClass: "编辑生图",
      relatedObjects: targetType && targetId ? `${targetType}:${targetId}` : `deriveAsset:${deriveAssetId || ""}`,
      model: input.model.split(/:(.+)/)[1] || input.model,
      describe: resolvedInput.prompt,
      state: "进行中",
      episode: input.scriptId,
      startTime: Date.now(),
    });
    const taskCenterId = Number(rawTaskCenterId);
    const [rawTaskId] = await trx("o_editImageTask").insert({
      projectId: input.projectId,
      scriptId: input.scriptId,
      deriveAssetId: deriveAssetId || null,
      targetType: targetType || null,
      targetId,
      flowId: input.flowId || null,
      nodeId,
      references: JSON.stringify(input.referenceMediaPaths || input.references || []),
      model: input.model,
      quality: input.quality,
      ratio: input.ratio,
      prompt: resolvedInput.prompt,
      status: "processing",
      state: "生成中",
      taskCenterId,
      createTime: Date.now(),
      updateTime: Date.now(),
    });
    const taskId = Number(rawTaskId);
    const nodePatch: Record<string, unknown> = {
      taskId,
      status: "processing",
      state: "generating",
      reason: "",
    };
    if (targetType === "deriveAsset" || targetType === "storyboard") nodePatch.ratio = resolvedInput.ratio;
    if (promptResolution.shouldBackfillNodePrompt) nodePatch.prompt = resolvedInput.prompt;
    const nodeUpdated = await updateImageFlowNodeWithDb(trx, input.flowId, nodeId, nodePatch);
    if (!legacy && !nodeUpdated) throw new Error("未找到对应的画布生成节点");
    return { taskCenterId, taskId, resolvedInput };
  });

  const unified = await adoptLegacyTask(taskCenterId, {
    projectId: input.projectId,
    scriptId: input.scriptId,
    taskClass: "编辑生图",
    taskType: "image",
    status: "queued",
    phase: "queued",
    targetType,
    targetId: targetId ?? undefined,
    nodeId,
    businessType: "image-flow",
    businessId: taskId,
    handler: "image-flow",
    payload: { input: resolvedInput, taskId, taskCenterId, nodeId, targetType, targetId, deriveAssetId },
    priority: 100,
    maxAttempts: 1,
    model: resolvedInput.model,
    describe: resolvedInput.prompt,
  });

  return {
    taskId,
    legacyTaskId: taskId,
    unifiedTaskId: unified.taskId,
    nodeId,
    flowId: input.flowId || null,
    status: "processing" as const,
    state: "生成中",
    legacy,
    prompt: resolvedInput.prompt,
    model: resolvedInput.model,
    quality: resolvedInput.quality,
    ratio: resolvedInput.ratio,
  };
}
