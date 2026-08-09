import u from "@/utils";
import { createUnifiedTask, updateUnifiedTask } from "@/services/taskCoordinator";
import { cleanupLegacyVideoReferences, parseVideoModelKey } from "@/services/videoQueue/shared";
import { getVideoProviderModelKey } from "@/services/videoQueue/registry";
import type { QueuedWorkbenchReference } from "@/services/workbenchReference";
import type { StoredVideoRequest, VideoQueueRow } from "@/services/videoQueue/contracts";

export interface VideoInput {
  prompt: string;
  references: QueuedWorkbenchReference[];
  mode: unknown;
  duration: number;
  aspectRatio: `${number}:${number}`;
  resolution: string;
  audio?: boolean;
  promptProfile?: {
    model: string;
    modelId: string | null;
    videoPromptType: string | null;
    systemPromptSource?: string | null;
  };
}

export interface EnqueueParams {
  videoId: number;
  videoPath: string;
  projectId: number;
  scriptId: number;
  model: string;
  input: VideoInput;
  relatedObjects: Record<string, any>;
}

export class VideoQueueCancelError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = "VideoQueueCancelError";
    this.statusCode = statusCode;
  }
}

export async function enqueueVideoGeneration(params: EnqueueParams) {
  const now = Date.now();
  const { vendorId } = parseVideoModelKey(params.model);
  const providerModelKey = getVideoProviderModelKey(params.model);
  const request: StoredVideoRequest = {
    version: 2,
    videoPath: params.videoPath,
    input: {
      prompt: params.input.prompt,
      mode: params.input.mode,
      duration: params.input.duration,
      aspectRatio: params.input.aspectRatio,
      resolution: params.input.resolution,
      audio: params.input.audio,
      promptProfile: params.input.promptProfile,
    },
    references: params.input.references.map((item, order) => ({
      sources: item.sources,
      id: Number(item.id),
      order: Number.isFinite(item.order) ? item.order : order,
    })),
    relatedObjects: params.relatedObjects,
  };

  const unified = await createUnifiedTask({
    projectId: params.projectId,
    scriptId: params.scriptId,
    taskClass: "视频生成",
    taskType: "video",
    status: "pending",
    phase: "initializing",
    progress: null,
    targetType: "videoTrack",
    targetId: params.relatedObjects.trackId,
    businessType: "video-generation",
    businessId: params.videoId,
    handler: "video-generation",
    priority: 50,
    maxAttempts: 1,
    model: params.model,
    describe: params.input.prompt,
    relatedObjects: params.relatedObjects,
  });

  let queueTaskId = 0;
  try {
    const [rawId] = await u.db("o_videoGenerationTask").insert({
      videoId: params.videoId,
      projectId: params.projectId,
      scriptId: params.scriptId,
      model: params.model,
      vendorId,
      providerModelKey,
      providerCapacityKey: null,
      taskCenterId: unified.id,
      payloadVersion: 2,
      requestJson: JSON.stringify(request),
      phase: "queued",
      status: "queued",
      state: "排队中",
      nextSubmitTime: now,
      submitAttemptCount: 0,
      startTime: now,
      updateTime: now,
    });
    queueTaskId = Number(rawId);
    const activated = await updateUnifiedTask(unified.id, {
      status: "queued",
      phase: "queued",
      progress: null,
      payload: { queueTaskId },
      availableAt: now,
      expectedVersion: 1,
      expectedStatus: "pending",
    });
    if (!activated) throw new Error("Video task activation lost its initialization lease.");
  } catch (cause) {
    await updateUnifiedTask(unified.id, {
      status: "failed",
      phase: "failed",
      reason: `Video task initialization failed: ${u.error(cause).message}`,
      clearLease: true,
    });
    throw cause;
  }
  return { queueTaskId, taskId: unified.taskId };
}

export async function cancelQueuedVideoGenerationTask(
  taskId: number,
  database: any = u.db,
  _options: { schedule?: boolean } = {},
) {
  const row = await database("o_videoGenerationTask").where("id", taskId).first() as VideoQueueRow | undefined;
  if (!row) throw new VideoQueueCancelError("视频生成任务不存在", 404);
  if (row.submitId) {
    throw new VideoQueueCancelError("任务已经提交到供应商，当前阶段不能安全取消");
  }
  const task = row.taskCenterId ? await database("o_tasks").where("id", row.taskCenterId).first() : null;
  if (
    !task ||
    task.providerTaskId ||
    !["pending", "queued"].includes(task.status) ||
    !["initializing", "queued", "capacity_wait", "remote_unavailable"].includes(String(task.phase || ""))
  ) {
    throw new VideoQueueCancelError("任务已经被 Worker 领取，当前阶段不能安全取消");
  }
  const reason = "用户取消本地排队";
  const cancelled = await updateUnifiedTask(row.taskCenterId!, {
    status: "cancelled",
    phase: "cancelled",
    progress: null,
    reason,
    clearLease: true,
    expectedVersion: task.version,
    expectedStatus: task.status,
    expectedProviderTaskId: null,
  }, database);
  if (!cancelled) throw new VideoQueueCancelError("任务状态已经变化，请刷新后重试");
  const now = Date.now();
  await database("o_videoGenerationTask").where("id", row.id).update({
    phase: "cancelled", status: "cancelled", state: "已取消", errorReason: reason,
    nextSubmitTime: null, nextPollTime: null, updateTime: now, finishTime: now,
  });
  await database("o_video").where("id", row.videoId).update({ state: "已取消", errorReason: reason });
  await cleanupLegacyVideoReferences(row);
  return { taskId: row.id, videoId: row.videoId, status: "cancelled" as const, state: "已取消" as const };
}
