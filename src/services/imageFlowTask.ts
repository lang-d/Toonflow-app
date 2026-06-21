import axios from "axios";
import u from "@/utils";
import { toLegacyTaskState, type TaskStatus } from "@/lib/taskStatus";
import { updateImageFlowNodeWithDb, type ImageFlowTargetType } from "@/services/imageFlow";
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
) {
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
    if (flowId && !updated) throw new Error("图片任务对应的画布节点不存在");
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
      },
      "",
      savePath,
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
    );
    throw err;
  }
  return { taskId, nodeId, targetType, targetId, deriveAssetId };
}

export async function createImageFlowTask(input: CreateImageFlowTaskInput) {
  const targetType = input.targetType || (input.deriveAssetId ? "deriveAsset" : undefined);
  const targetId = input.targetId ?? input.deriveAssetId ?? null;
  const deriveAssetId = input.deriveAssetId ?? (targetType === "deriveAsset" ? targetId : null);
  const legacy = !input.flowId || !input.nodeId || !targetType || !targetId;
  const nodeId = input.nodeId || `legacy:${u.uuid()}`;
  if (legacy) {
    console.warn("[deprecated] generateFlowImageTask should include flowId, nodeId, targetType and targetId");
  }
  if (!input.model.includes(":")) throw new Error("模型标识必须使用 vendorId:modelName 格式");
  if (!["1K", "2K", "4K"].includes(input.quality)) throw new Error(`不支持的图片质量: ${input.quality}`);
  if (!/^\d+:\d+$/.test(input.ratio)) throw new Error(`不支持的图片比例: ${input.ratio}`);

  const { taskCenterId, taskId } = await u.db.transaction(async (trx: any) => {
    const [rawTaskCenterId] = await trx("o_tasks").insert({
      projectId: input.projectId,
      taskClass: "编辑生图",
      relatedObjects: targetType && targetId ? `${targetType}:${targetId}` : `deriveAsset:${deriveAssetId || ""}`,
      model: input.model.split(/:(.+)/)[1] || input.model,
      describe: input.prompt,
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
      prompt: input.prompt,
      status: "processing",
      state: "生成中",
      taskCenterId,
      createTime: Date.now(),
      updateTime: Date.now(),
    });
    const taskId = Number(rawTaskId);
    const nodeUpdated = await updateImageFlowNodeWithDb(trx, input.flowId, nodeId, {
      taskId,
      status: "processing",
      state: "generating",
      reason: "",
    });
    if (!legacy && !nodeUpdated) throw new Error("未找到对应的画布生成节点");
    return { taskCenterId, taskId };
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
    payload: { input, taskId, taskCenterId, nodeId, targetType, targetId, deriveAssetId },
    priority: 100,
    maxAttempts: 1,
    model: input.model,
    describe: input.prompt,
  });

  return {
    taskId,
    unifiedTaskId: unified.taskId,
    nodeId,
    flowId: input.flowId || null,
    status: "processing" as const,
    state: "生成中",
    legacy,
  };
}
