import axios from "axios";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import u from "@/utils";
import dreaminaCli, { type QueueConfig } from "@/utils/dreaminaCli";
import {
  resolveQueuedWorkbenchReferences,
  type QueuedWorkbenchReference,
  type ResolvedLocalWorkbenchReference,
} from "@/services/workbenchReference";
import type { ReferenceList } from "@/utils/ai";
import { adoptLegacyTask, updateUnifiedTask } from "@/services/taskCoordinator";
import { createLogger } from "@/logger";

type QueueStatus = "queued" | "submitting" | "confirming" | "processing" | "completed" | "failed" | "cancelled";
type QueueState = "排队中" | "提交中" | "生成中" | "已完成" | "生成失败" | "已取消";

interface VideoInput {
  prompt: string;
  references: QueuedWorkbenchReference[];
  mode: unknown;
  duration: number;
  aspectRatio: `${number}:${number}`;
  resolution: string;
  audio?: boolean;
}

interface EnqueueParams {
  videoId: number;
  videoPath: string;
  projectId: number;
  scriptId: number;
  model: string;
  input: VideoInput;
  relatedObjects: Record<string, any>;
}

interface StoredRequest {
  version: 2;
  videoPath: string;
  input: Omit<VideoInput, "references">;
  references: QueuedWorkbenchReference[];
  relatedObjects: Record<string, any>;
  legacyReferences?: Array<{ type: "image" | "video" | "audio"; filePath: string }>;
}

interface QueueRow {
  id: number;
  videoId: number;
  projectId: number;
  scriptId: number;
  model: string;
  vendorId: string;
  taskCenterId?: number | null;
  requestJson: string;
  submitId?: string | null;
  officialTaskId?: string | null;
  historyRecordId?: string | null;
  providerAccountId?: string | null;
  providerModelKey?: string | null;
  providerSubmittedAt?: number | null;
  remoteConfirmedAt?: number | null;
  phase?: string | null;
  status: QueueStatus;
  state: QueueState;
  errorReason?: string | null;
  rawOutput?: string | null;
  nextPollTime?: number | null;
  nextSubmitTime?: number | null;
  pollCount?: number | null;
  submitAttemptCount?: number | null;
  capacityWaitStartedAt?: number | null;
  confirmStartedAt?: number | null;
  lastProviderCode?: string | null;
  providerQueueStatus?: number | null;
  providerQueueIndex?: number | null;
  providerQueueLength?: number | null;
  startTime: number;
}

const RAW_OUTPUT_LIMIT = 32 * 1024;
const CAPACITY_RETRY_MS = 90_000;
const SCHEDULER_LEASE_KEY = "runtime:video-queue-scheduler-lease";
const SCHEDULER_LEASE_TTL_MS = 90_000;
const submissionModels = new Set<string>();
const pollingTasks = new Set<number>();
const videoQueueLog = createLogger("video-queue");
let timer: NodeJS.Timeout | null = null;
let tickRunning = false;
let schedulerStarted = false;
let schedulerHasLease = false;
const schedulerOwner = `${process.pid}:${randomUUID()}`;

type QueueLogLevel = "info" | "warn" | "error";

function queueLog(event: string, details: Record<string, unknown> = {}, level: QueueLogLevel = "info") {
  videoQueueLog[level](`video-queue ${event}`, {
    event,
    ...details,
  });
}

function taskLogDetails(row: Pick<QueueRow, "id" | "videoId" | "model" | "providerModelKey" | "submitId">) {
  return {
    queueTaskId: row.id,
    videoId: row.videoId,
    model: row.model,
    providerModelKey: row.providerModelKey || getVideoProviderModelKey(row.model),
    submitId: row.submitId || undefined,
  };
}

function truncateDiagnostic(value?: string | null) {
  if (!value) return "";
  return value.length > RAW_OUTPUT_LIMIT ? value.slice(-RAW_OUTPUT_LIMIT) : value;
}

function summarizeError(value: string) {
  if (value.length <= 4096) return value;
  const firstLine = value.split(/\r?\n/, 1)[0].slice(0, 1024);
  return `${firstLine}\n\n诊断摘要（末尾）：\n${value.slice(-3000)}`;
}

function parseModelKey(model: string) {
  const [vendorId, modelName] = model.split(/:(.+)/);
  return { vendorId, modelName };
}

export function getVideoProviderModelKey(model: string) {
  const { vendorId, modelName } = parseModelKey(model);
  return vendorId === "dreamina" ? dreaminaCli.getDreaminaProviderModelKey(modelName) : `${vendorId}:${modelName}`;
}

async function getModelConfig(model: string): Promise<any> {
  const { vendorId, modelName } = parseModelKey(model);
  const models = await u.vendor.getModelList(vendorId);
  return models.find((item: any) => item.modelName === modelName) || { modelName, type: "video" };
}

function normalizeQueueConfig(config?: QueueConfig, vendorId?: string) {
  return dreaminaCli.normalizeQueueConfig(config, vendorId === "dreamina" ? 1 : 2);
}

export function providerWorkElapsedMs(
  row: Pick<QueueRow, "providerSubmittedAt" | "confirmStartedAt" | "remoteConfirmedAt">,
  now = Date.now(),
) {
  const submittedAt = Number(row.providerSubmittedAt || row.confirmStartedAt || row.remoteConfirmedAt || 0);
  return submittedAt > 0 ? Math.max(0, now - submittedAt) : 0;
}

export function isProviderWorkTimedOut(
  row: Pick<QueueRow, "providerSubmittedAt" | "confirmStartedAt" | "remoteConfirmedAt">,
  maxWorkHours: number,
  now = Date.now(),
) {
  const elapsed = providerWorkElapsedMs(row, now);
  return elapsed > 0 && elapsed >= maxWorkHours * 60 * 60 * 1000;
}

function queueTimingDetails(row: QueueRow, now = Date.now(), maxWorkHours?: number) {
  const providerWorkMs = providerWorkElapsedMs(row, now);
  return {
    providerSubmittedAt: row.providerSubmittedAt || row.confirmStartedAt || undefined,
    localQueueWaitSec: row.providerSubmittedAt
      ? Math.max(0, Math.round((row.providerSubmittedAt - row.startTime) / 1000))
      : Math.max(0, Math.round((now - row.startTime) / 1000)),
    providerWorkSec: Math.round(providerWorkMs / 1000),
    maxWorkHours,
  };
}

export function nextProviderPollDelayMs(
  config: ReturnType<typeof normalizeQueueConfig>,
  queueStatus?: number,
  confirmed = true,
) {
  if (!confirmed) return config.pollInitialDelaySec * 1000;
  if (queueStatus === 1) return config.pollMaxIntervalSec * 1000;
  return config.pollMinIntervalSec * 1000;
}

function capacityRetryDelayMs() {
  return CAPACITY_RETRY_MS + Math.floor(Math.random() * 15_001);
}

function capacityAccountId(value?: string | null) {
  return value || "default";
}

function parseSchedulerLease(value?: string | null) {
  try {
    const parsed = JSON.parse(value || "{}");
    return {
      owner: String(parsed.owner || ""),
      expiresAt: Number(parsed.expiresAt || 0),
    };
  } catch {
    return { owner: "", expiresAt: 0 };
  }
}

export async function tryAcquireVideoQueueSchedulerLease(
  database: any,
  owner: string,
  now = Date.now(),
  ttlMs = SCHEDULER_LEASE_TTL_MS,
) {
  const nextValue = JSON.stringify({ owner, expiresAt: now + ttlMs });
  await database("o_setting")
    .insert({ key: SCHEDULER_LEASE_KEY, value: nextValue })
    .onConflict("key")
    .ignore();

  const current = await database("o_setting").where("key", SCHEDULER_LEASE_KEY).first();
  const lease = parseSchedulerLease(current?.value);
  if (lease.owner !== owner && lease.expiresAt > now) return false;

  const updated = await database("o_setting")
    .where({ key: SCHEDULER_LEASE_KEY, value: current?.value })
    .update({ value: nextValue });
  return Boolean(updated);
}

async function releaseVideoQueueSchedulerLease(database: any = u.db, owner = schedulerOwner) {
  const current = await database("o_setting").where("key", SCHEDULER_LEASE_KEY).first();
  if (parseSchedulerLease(current?.value).owner !== owner) return false;
  const removed = await database("o_setting")
    .where({ key: SCHEDULER_LEASE_KEY, value: current.value })
    .delete();
  return Boolean(removed);
}

async function setCapacityBlocked(row: QueueRow, blockedUntil: number, providerCode = "1310") {
  const providerModelKey = row.providerModelKey || getVideoProviderModelKey(row.model);
  const now = Date.now();
  await u
    .db("o_videoProviderCapacity")
    .insert({
      vendorId: row.vendorId,
      providerAccountId: capacityAccountId(row.providerAccountId),
      providerModelKey,
      capacityBlocked: 1,
      blockedUntil,
      lastProviderCode: providerCode,
      createTime: now,
      updateTime: now,
    })
    .onConflict(["vendorId", "providerAccountId", "providerModelKey"])
    .merge({
      capacityBlocked: 1,
      blockedUntil,
      lastProviderCode: providerCode,
      updateTime: now,
    });
}

async function clearCapacityBlocked(row: QueueRow) {
  const providerModelKey = row.providerModelKey || getVideoProviderModelKey(row.model);
  await u
    .db("o_videoProviderCapacity")
    .where({
      vendorId: row.vendorId,
      providerAccountId: capacityAccountId(row.providerAccountId),
      providerModelKey,
    })
    .update({
      capacityBlocked: 0,
      blockedUntil: null,
      updateTime: Date.now(),
    });
}

async function createTaskCenterRecord(params: EnqueueParams) {
  const [taskCenterId] = await u.db("o_tasks").insert({
    projectId: params.projectId,
    taskClass: "视频生成",
    relatedObjects: JSON.stringify(params.relatedObjects),
    model: params.model,
    describe: params.input.prompt,
    state: "进行中",
    episode: params.scriptId,
    startTime: Date.now(),
  });
  const unified = await adoptLegacyTask(Number(taskCenterId), {
    projectId: params.projectId,
    scriptId: params.scriptId,
    taskClass: "视频生成",
    taskType: "video",
    status: "queued",
    phase: "queued",
    targetType: "videoTrack",
    targetId: params.relatedObjects.trackId,
    businessType: "video-generation",
    businessId: params.videoId,
    priority: 50,
    maxAttempts: 1,
    model: params.model,
    describe: params.input.prompt,
  });
  return { taskCenterId: Number(taskCenterId), taskId: unified.taskId };
}

export async function enqueueVideoGeneration(params: EnqueueParams) {
  const { vendorId } = parseModelKey(params.model);
  const providerModelKey = getVideoProviderModelKey(params.model);
  const taskRecord = await createTaskCenterRecord(params);
  const taskCenterId = taskRecord.taskCenterId;
  const now = Date.now();
  const request: StoredRequest = {
    version: 2,
    videoPath: params.videoPath,
    input: {
      prompt: params.input.prompt,
      mode: params.input.mode,
      duration: params.input.duration,
      aspectRatio: params.input.aspectRatio,
      resolution: params.input.resolution,
      audio: params.input.audio,
    },
    references: params.input.references.map((item, order) => ({
      sources: item.sources,
      id: Number(item.id),
      order: Number.isFinite(item.order) ? item.order : order,
    })),
    relatedObjects: params.relatedObjects,
  };
  const [id] = await u.db("o_videoGenerationTask").insert({
    videoId: params.videoId,
    projectId: params.projectId,
    scriptId: params.scriptId,
    model: params.model,
    vendorId,
    providerModelKey,
    taskCenterId,
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
  queueLog("task.enqueued", {
    queueTaskId: Number(id),
    videoId: params.videoId,
    projectId: params.projectId,
    scriptId: params.scriptId,
    model: params.model,
    providerModelKey,
    referenceCount: request.references.length,
    taskCenterId,
  });
  scheduleQueue(0);
  return { queueTaskId: Number(id), taskId: taskRecord.taskId };
}

export async function occupiedProviderSlotCount(providerModelKey: string, database: any = u.db) {
  const row = await database("o_videoGenerationTask")
    .where({ providerModelKey })
    .whereIn("status", ["submitting", "confirming", "processing"])
    .count("* as total")
    .first();
  return Number((row as any)?.total || 0);
}

async function failTask(row: QueueRow, reason: string, rawOutput?: string) {
  const now = Date.now();
  const errorReason = summarizeError(reason);
  await u.db.transaction(async (trx: any) => {
    await trx("o_videoGenerationTask").where("id", row.id).update({
      phase: "failed",
      status: "failed",
      state: "生成失败",
      errorReason,
      rawOutput: truncateDiagnostic(rawOutput || row.rawOutput),
      updateTime: now,
      finishTime: now,
    });
    await trx("o_video").where("id", row.videoId).update({ state: "生成失败", errorReason });
    if (row.taskCenterId) {
      await trx("o_tasks").where("id", row.taskCenterId).update({ state: "生成失败", reason: errorReason });
    }
  });
  await clearCapacityBlocked(row);
  await cleanupLegacyReferences(row);
  if (row.taskCenterId) {
    await updateUnifiedTask(row.taskCenterId, {
      status: "failed",
      phase: "failed",
      reason: errorReason,
      clearLease: true,
    });
  }
  queueLog(
    "task.failed",
    {
      ...taskLogDetails(row),
      ...queueTimingDetails(row, now),
      reason: errorReason,
      elapsedSec: Math.round((now - row.startTime) / 1000),
    },
    "error",
  );
}

async function completeTask(row: QueueRow, rawOutput?: string) {
  const now = Date.now();
  await u.db.transaction(async (trx: any) => {
    await trx("o_video").where("id", row.videoId).update({ state: "生成成功", errorReason: "" });
    await trx("o_videoGenerationTask").where("id", row.id).update({
      phase: "completed",
      status: "completed",
      state: "已完成",
      rawOutput: truncateDiagnostic(rawOutput || row.rawOutput),
      updateTime: now,
      finishTime: now,
    });
    if (row.taskCenterId) {
      await trx("o_tasks").where("id", row.taskCenterId).update({ state: "已完成", reason: "" });
    }
  });
  await clearCapacityBlocked(row);
  await cleanupLegacyReferences(row);
  if (row.taskCenterId) {
    await updateUnifiedTask(row.taskCenterId, {
      status: "completed",
      phase: "completed",
      progress: 100,
      result: { businessId: row.videoId },
      clearLease: true,
    });
  }
  queueLog("task.completed", {
    ...taskLogDetails(row),
    ...queueTimingDetails(row, now),
    elapsedSec: Math.round((now - row.startTime) / 1000),
  });
}

export class VideoQueueCancelError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = "VideoQueueCancelError";
    this.statusCode = statusCode;
  }
}

export async function cancelQueuedVideoGenerationTask(
  taskId: number,
  db: any = u.db,
  options: { schedule?: boolean } = {},
) {
  const now = Date.now();
  let cancelledTask: QueueRow | null = null;
  await db.transaction(async (trx: any) => {
    const task = (await trx("o_videoGenerationTask").where("id", taskId).first()) as QueueRow | undefined;
    if (!task) throw new VideoQueueCancelError("视频生成任务不存在", 404);
    const updated = await trx("o_videoGenerationTask")
      .where("id", taskId)
      .where("status", "queued")
      .whereNull("submitId")
      .whereIn("phase", ["queued", "capacity_wait"])
      .update({
        phase: "cancelled",
        status: "cancelled",
        state: "已取消",
        errorReason: "用户取消本地排队",
        nextSubmitTime: null,
        nextPollTime: null,
        updateTime: now,
        finishTime: now,
      });
    if (!updated) {
      throw new VideoQueueCancelError("任务可能已经提交即梦，当前阶段无法安全取消");
    }
    await trx("o_video").where("id", task.videoId).update({
      state: "已取消",
      errorReason: "用户取消本地排队",
    });
    if (task.taskCenterId) {
      await trx("o_tasks").where("id", task.taskCenterId).update({
        state: "已取消",
        reason: "用户取消本地排队",
      });
    }
    cancelledTask = task;
  });
  if (!cancelledTask) throw new VideoQueueCancelError("任务取消失败");
  const resultTask = cancelledTask as QueueRow;
  if (resultTask.taskCenterId) {
    const taskCenter = await db("o_tasks").where("id", resultTask.taskCenterId).first();
    if (taskCenter?.taskId) {
      await updateUnifiedTask(
        resultTask.taskCenterId,
        {
          status: "cancelled",
          phase: "cancelled",
          reason: "用户取消本地排队",
          clearLease: true,
        },
        db,
      );
    }
  }
  await cleanupLegacyReferences(resultTask);
  queueLog("task.cancelled", {
    ...taskLogDetails(resultTask),
    ...queueTimingDetails(resultTask, now),
  });
  if (options.schedule !== false) scheduleQueue(0);
  return {
    taskId: resultTask.id,
    videoId: resultTask.videoId,
    status: "cancelled" as const,
    state: "已取消" as const,
  };
}

async function saveResult(row: QueueRow, data: string, dataType: "file" | "url" | "base64" = "base64", rawOutput?: string) {
  const request = JSON.parse(row.requestJson || "{}") as StoredRequest;
  if (!request.videoPath) throw new Error("视频任务缺少结果保存路径");
  if (dataType === "file") {
    await u.oss.copyLocalFile(data, request.videoPath);
  } else if (dataType === "url") {
    const response = await axios.get(data, { responseType: "stream", timeout: 180000 });
    await u.oss.writeStream(request.videoPath, response.data);
  } else {
    await u.oss.writeFile(request.videoPath, data);
  }
  queueLog("result.saved", {
    ...taskLogDetails(row),
    dataType,
    targetPath: request.videoPath,
  });
  await completeTask(row, rawOutput);
}

function mimeFromPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".bmp": "image/bmp",
      ".tif": "image/tiff",
      ".tiff": "image/tiff",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".webm": "video/webm",
      ".mkv": "video/x-matroska",
      ".avi": "video/x-msvideo",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
      ".aac": "audio/aac",
      ".flac": "audio/flac",
      ".ogg": "audio/ogg",
      ".aiff": "audio/aiff",
    }[ext] || "application/octet-stream"
  );
}

async function toLegacyAiReferences(items: Array<{ type: "image" | "video" | "audio"; filePath: string }>) {
  const result: ReferenceList[] = [];
  for (const item of items) {
    const data = await fs.readFile(item.filePath);
    result.push({
      type: item.type,
      base64: `data:${mimeFromPath(item.filePath)};base64,${data.toString("base64")}`,
    } as ReferenceList);
  }
  return result;
}

async function resolveRequestReferences(row: QueueRow, request: StoredRequest) {
  if (request.references?.length) {
    const trackId = Number(request.relatedObjects?.trackId || 0) || undefined;
    const items = await resolveQueuedWorkbenchReferences(request.references, {
      projectId: row.projectId,
      scriptId: row.scriptId,
      trackId,
    });
    return items.map((item: ResolvedLocalWorkbenchReference) => ({
      type: item.fileType,
      filePath: item.localFilePath,
    }));
  }
  if (request.legacyReferences?.length) {
    for (const item of request.legacyReferences) {
      const stat = await fs.stat(item.filePath);
      if (!stat.isFile()) throw new Error(`旧任务临时原始素材不存在: ${item.filePath}`);
    }
    return request.legacyReferences;
  }
  return [];
}

async function submitDreamina(row: QueueRow, request: StoredRequest) {
  const modelConfig = await getModelConfig(row.model);
  const queueConfig = normalizeQueueConfig(modelConfig.queueConfig, "dreamina");
  const referenceList = await resolveRequestReferences(row, request);
  queueLog("submit.started", {
    ...taskLogDetails(row),
    referenceCount: referenceList.length,
    referenceTypes: referenceList.reduce<Record<string, number>>((acc, item) => {
      acc[item.type] = (acc[item.type] || 0) + 1;
      return acc;
    }, {}),
    submitAttemptCount: Number(row.submitAttemptCount || 0) + 1,
  });
  const submit = await dreaminaCli.videoSubmit({ ...request.input, referenceList }, modelConfig);
  const now = Date.now();
  const providerModelKey = row.providerModelKey || getVideoProviderModelKey(row.model);

  if (submit.state === "capacity_wait") {
    const nextSubmitTime = now + capacityRetryDelayMs();
    await u.db("o_videoGenerationTask").where("id", row.id).update({
      providerModelKey,
      providerAccountId: submit.providerAccountId || row.providerAccountId || null,
      phase: "capacity_wait",
      status: "queued",
      state: "排队中",
      submitId: null,
      officialTaskId: null,
      historyRecordId: null,
      remoteConfirmedAt: null,
      capacityWaitStartedAt: row.capacityWaitStartedAt || now,
      lastProviderCode: submit.providerCode || "1310",
      rawOutput: truncateDiagnostic(submit.rawOutput),
      nextSubmitTime,
      nextPollTime: null,
      updateTime: now,
    });
    await setCapacityBlocked(
      {
        ...row,
        providerModelKey,
        providerAccountId: submit.providerAccountId || row.providerAccountId,
      },
      nextSubmitTime,
      submit.providerCode || "1310",
    );
    if (row.taskCenterId) {
      await updateUnifiedTask(row.taskCenterId, {
        status: "queued",
        phase: "capacity_wait",
        availableAt: nextSubmitTime,
      });
    }
    queueLog(
      "submit.capacity_wait",
      {
        ...taskLogDetails(row),
        providerModelKey,
        providerAccountId: submit.providerAccountId || row.providerAccountId || undefined,
        providerCode: submit.providerCode || "1310",
        nextSubmitTime,
      },
      "warn",
    );
    return;
  }

  if (!submit.submitId) throw new Error("即梦 CLI 未返回 submit_id。");
  const confirmed = Boolean(submit.confirmed);
  await u.db("o_videoGenerationTask").where("id", row.id).update({
    providerModelKey,
    submitId: submit.submitId,
    officialTaskId: submit.officialTaskId || null,
    historyRecordId: submit.historyRecordId || null,
    providerAccountId: submit.providerAccountId || null,
    providerSubmittedAt: row.providerSubmittedAt || now,
    remoteConfirmedAt: confirmed ? now : null,
    confirmStartedAt: now,
    phase: confirmed ? "processing" : "confirming",
    status: confirmed ? "processing" : "confirming",
    state: confirmed ? "生成中" : "提交中",
    lastProviderCode: submit.providerCode || null,
    rawOutput: truncateDiagnostic(submit.rawOutput),
    nextSubmitTime: null,
    nextPollTime: now + queueConfig.pollInitialDelaySec * 1000,
    pollCount: 0,
    updateTime: now,
  });
  await clearCapacityBlocked({
    ...row,
    providerModelKey,
    providerAccountId: submit.providerAccountId || row.providerAccountId,
  });
  if (row.taskCenterId) {
    await updateUnifiedTask(row.taskCenterId, {
      status: confirmed ? "processing" : "submitting",
      phase: confirmed ? "processing" : "confirming",
      progress: confirmed ? 20 : 10,
      providerTaskId: submit.submitId,
    });
  }
  queueLog("submit.accepted", {
    ...taskLogDetails({ ...row, providerModelKey, submitId: submit.submitId }),
    providerAccountId: submit.providerAccountId || undefined,
    officialTaskId: submit.officialTaskId || undefined,
    historyRecordId: submit.historyRecordId || undefined,
    confirmed,
    providerSubmittedAt: row.providerSubmittedAt || now,
    localQueueWaitSec: Math.max(0, Math.round(((row.providerSubmittedAt || now) - row.startTime) / 1000)),
    nextPollTime: now + queueConfig.pollInitialDelaySec * 1000,
  });
}

async function submitLegacy(row: QueueRow, request: StoredRequest) {
  const references = await resolveRequestReferences(row, request);
  const referenceList = await toLegacyAiReferences(references);
  const aiVideo = u.Ai.Video(row.model as `${string}:${string}`);
  await aiVideo.run({ ...request.input, referenceList } as any);
  await aiVideo.save(request.videoPath);
  await completeTask(row);
}

async function submitTask(row: QueueRow) {
  try {
    const request = JSON.parse(row.requestJson || "{}") as StoredRequest;
    if (row.vendorId === "dreamina") await submitDreamina(row, request);
    else await submitLegacy(row, request);
  } catch (error) {
    const message = u.error(error).message;
    queueLog("submit.exception", { ...taskLogDetails(row), message }, "error");
    await failTask(row, message, message);
  }
}

async function schedulePollRetry(row: QueueRow, message: string, delayMs: number) {
  const pollCount = Number(row.pollCount || 0) + 1;
  const nextPollTime = Date.now() + delayMs;
  await u.db("o_videoGenerationTask").where("id", row.id).update({
    rawOutput: truncateDiagnostic(`${row.rawOutput || ""}\n${message}`),
    pollCount,
    nextPollTime,
    updateTime: Date.now(),
  });
  if (row.taskCenterId) {
    await updateUnifiedTask(row.taskCenterId, {
      status: row.status === "processing" ? "processing" : "submitting",
      phase: row.status,
      reason: message,
      availableAt: nextPollTime,
    });
  }
  queueLog(
    "poll.retry_scheduled",
    {
      ...taskLogDetails(row),
      status: row.status,
      pollCount,
      nextPollTime,
      message,
    },
    "warn",
  );
}

async function pollDreamina(row: QueueRow) {
  if (!row.submitId) {
    await failTask(row, "即梦任务缺少 submit_id，无法继续确认或轮询。", row.rawOutput || "");
    return;
  }
  const modelConfig = await getModelConfig(row.model);
  const config = normalizeQueueConfig(modelConfig.queueConfig, "dreamina");
  const providerSubmittedAt = Number(row.providerSubmittedAt || row.confirmStartedAt || row.remoteConfirmedAt || 0);
  const workTimedOut = isProviderWorkTimedOut({ ...row, providerSubmittedAt }, config.maxWorkHours);
  let poll;
  try {
    queueLog("poll.started", {
      ...taskLogDetails(row),
      ...queueTimingDetails({ ...row, providerSubmittedAt }, Date.now(), config.maxWorkHours),
      status: row.status,
      pollCount: Number(row.pollCount || 0) + 1,
      finalTimeoutCheck: workTimedOut,
    });
    poll =
      row.status === "confirming"
        ? await dreaminaCli.videoConfirm(row.submitId)
        : await dreaminaCli.videoPoll(row.submitId);
  } catch (error) {
    if (workTimedOut) {
      await failTask(
        { ...row, providerSubmittedAt },
        `官方任务工作超过 ${config.maxWorkHours} 小时，最终状态查询失败：${u.error(error).message}。submit_id=${row.submitId}`,
        row.rawOutput || "",
      );
      return;
    }
    await schedulePollRetry(
      row,
      `即梦任务查询暂时失败，将继续重试：${u.error(error).message}`,
      nextProviderPollDelayMs(config, row.providerQueueStatus ?? undefined, row.status === "processing"),
    );
    return;
  }
  if (row.providerAccountId && poll.providerAccountId && row.providerAccountId !== poll.providerAccountId) {
    await failTask(
      row,
      `即梦登录账号已变化，提交账号 ${row.providerAccountId}，当前账号 ${poll.providerAccountId}。`,
      poll.rawOutput,
    );
    return;
  }
  if (poll.state === "success" && poll.data) {
    await saveResult(row, poll.data, poll.dataType || "base64", poll.rawOutput);
    return;
  }
  if (poll.state === "failed") {
    await failTask(row, poll.errorReason || "即梦视频生成失败", poll.rawOutput);
    return;
  }
  if (workTimedOut) {
    await failTask(
      { ...row, providerSubmittedAt },
      `官方任务工作超过 ${config.maxWorkHours} 小时，最终查询仍未完成。submit_id=${row.submitId}`,
      poll.rawOutput,
    );
    return;
  }

  const now = Date.now();
  const pollCount = Number(row.pollCount || 0) + 1;
  const confirmed = poll.evidence.confirmed || Boolean(row.officialTaskId || row.historyRecordId || row.remoteConfirmedAt);
  const status: QueueStatus = confirmed ? "processing" : "confirming";
  const phase = confirmed ? "processing" : "confirming";
  const nextPollTime = now + nextProviderPollDelayMs(config, poll.queueInfo.status, confirmed);
  await u.db("o_videoGenerationTask").where("id", row.id).update({
    providerSubmittedAt: providerSubmittedAt || row.confirmStartedAt || now,
    officialTaskId: poll.evidence.officialTaskId || row.officialTaskId || null,
    historyRecordId: poll.evidence.historyRecordId || row.historyRecordId || null,
    providerAccountId: poll.providerAccountId || row.providerAccountId || null,
    remoteConfirmedAt: confirmed ? row.remoteConfirmedAt || now : null,
    phase,
    status,
    state: confirmed ? "生成中" : "提交中",
    lastProviderStatus: poll.queueInfo.status === 1 ? "queued" : poll.queueInfo.status === 2 ? "processing" : "confirming",
    lastProviderCode: poll.providerCode || row.lastProviderCode || null,
    providerQueueStatus: poll.queueInfo.status ?? null,
    providerQueueIndex: poll.queueInfo.index ?? null,
    providerQueueLength: poll.queueInfo.length ?? null,
    rawOutput: truncateDiagnostic(poll.rawOutput || row.rawOutput),
    pollCount,
    nextPollTime,
    updateTime: now,
  });
  if (row.taskCenterId) {
    await updateUnifiedTask(row.taskCenterId, {
      status: confirmed ? "processing" : "submitting",
      phase,
      progress: confirmed ? Math.max(20, Math.min(90, 20 + pollCount)) : 10,
      providerTaskId: row.submitId,
      availableAt: nextPollTime,
    });
  }
  queueLog("poll.updated", {
    ...taskLogDetails(row),
    ...queueTimingDetails(
      { ...row, providerSubmittedAt: providerSubmittedAt || row.confirmStartedAt || now },
      now,
      config.maxWorkHours,
    ),
    status,
    confirmed,
    officialTaskId: poll.evidence.officialTaskId || row.officialTaskId || undefined,
    historyRecordId: poll.evidence.historyRecordId || row.historyRecordId || undefined,
    providerCode: poll.providerCode || row.lastProviderCode || undefined,
    queueStatus: poll.queueInfo.status,
    queueIndex: poll.queueInfo.index,
    queueLength: poll.queueInfo.length,
    pollCount,
    nextPollTime,
  });
}

async function cleanupLegacyReferences(row: QueueRow) {
  try {
    const request = JSON.parse(row.requestJson || "{}") as StoredRequest;
    const dirs = new Set(
      (request.legacyReferences || [])
        .map((item) => path.dirname(item.filePath))
        .filter((dir) => dir.startsWith(u.getPath(["temp", "video-queue-legacy"]))),
    );
    await Promise.all([...dirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  } catch {}
}

async function launchSubmissions() {
  const now = Date.now();
  const rows = (await u
    .db("o_videoGenerationTask")
    .where("status", "queued")
    .where((builder: any) => builder.whereNull("nextSubmitTime").orWhere("nextSubmitTime", "<=", now))
    .orderBy("startTime", "asc")
    .limit(50)) as QueueRow[];
  if (!rows.length) return;

  const providerKeys = [...new Set(rows.map((row) => row.providerModelKey || getVideoProviderModelKey(row.model)))];
  const vendorIds = [...new Set(rows.map((row) => row.vendorId))];
  const vendorModels = new Map<string, any[]>();
  await Promise.all(
    vendorIds.map(async (vendorId) => {
      vendorModels.set(vendorId, await u.vendor.getModelList(vendorId));
    }),
  );
  const blockedRows = await u
    .db("o_videoProviderCapacity")
    .whereIn("providerModelKey", providerKeys)
    .where("capacityBlocked", 1)
    .where("blockedUntil", ">", now)
    .select("vendorId", "providerModelKey");
  const blockedModels = new Set(blockedRows.map((row: any) => `${row.vendorId}:${row.providerModelKey}`));
  const occupiedRows = await u
    .db("o_videoGenerationTask")
    .whereIn("providerModelKey", providerKeys)
    .whereIn("status", ["submitting", "confirming", "processing"])
    .groupBy("providerModelKey")
    .select("providerModelKey")
    .count("* as total");
  const occupiedByModel = new Map(
    occupiedRows.map((row: any) => [String(row.providerModelKey), Number(row.total || 0)]),
  );
  const visitedModels = new Set<string>();
  for (const row of rows) {
    const providerModelKey = row.providerModelKey || getVideoProviderModelKey(row.model);
    if (visitedModels.has(providerModelKey)) continue;
    visitedModels.add(providerModelKey);
    if (submissionModels.has(providerModelKey)) continue;
    const { modelName } = parseModelKey(row.model);
    const modelConfig =
      vendorModels.get(row.vendorId)?.find((item: any) => item.modelName === modelName) ||
      { modelName, type: "video" };
    const config = normalizeQueueConfig(modelConfig.queueConfig, row.vendorId);
    if (blockedModels.has(`${row.vendorId}:${providerModelKey}`)) continue;
    const occupiedSlots = occupiedByModel.get(providerModelKey) || 0;
    if (occupiedSlots >= config.maxConcurrent) continue;
    const claimed = await u
      .db("o_videoGenerationTask")
      .where({ id: row.id, status: "queued" })
      .update({
        providerModelKey,
        phase: "submitting",
        status: "submitting",
        state: "提交中",
        nextSubmitTime: null,
        submitAttemptCount: Number(row.submitAttemptCount || 0) + 1,
        updateTime: Date.now(),
      });
    if (!claimed) continue;
    occupiedByModel.set(providerModelKey, occupiedSlots + 1);
    if (row.taskCenterId) {
      await updateUnifiedTask(row.taskCenterId, {
        status: "submitting",
        phase: "submitting",
        progress: 5,
      });
    }
    queueLog("slot.claimed", {
      ...taskLogDetails({ ...row, providerModelKey }),
      configuredConcurrent: config.maxConcurrent,
      occupiedSlotsBeforeClaim: occupiedSlots,
      availableSlotsBeforeClaim: Math.max(0, config.maxConcurrent - occupiedSlots),
      ...queueTimingDetails(row, now, config.maxWorkHours),
      submitAttemptCount: Number(row.submitAttemptCount || 0) + 1,
    });
    submissionModels.add(providerModelKey);
    void submitTask({ ...row, providerModelKey, phase: "submitting", status: "submitting", state: "提交中" }).finally(() => {
      submissionModels.delete(providerModelKey);
      scheduleQueue(0);
    });
  }
}

async function launchPolls() {
  const available = Math.max(0, 4 - pollingTasks.size);
  if (!available) return;
  const rows = (await u
    .db("o_videoGenerationTask")
    .whereIn("status", ["confirming", "processing"])
    .where("nextPollTime", "<=", Date.now())
    .orderBy("nextPollTime", "asc")
    .limit(available)) as QueueRow[];
  for (const row of rows) {
    if (pollingTasks.has(row.id)) continue;
    pollingTasks.add(row.id);
    void (row.vendorId === "dreamina" ? pollDreamina(row) : Promise.resolve()).finally(() => {
      pollingTasks.delete(row.id);
      scheduleQueue(0);
    });
  }
}

async function processQueue() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const acquired = await tryAcquireVideoQueueSchedulerLease(u.db, schedulerOwner);
    if (!acquired) {
      if (schedulerHasLease) {
        queueLog("scheduler.lease_lost", { schedulerOwner }, "warn");
      }
      schedulerHasLease = false;
      return;
    }
    if (!schedulerHasLease) {
      queueLog("scheduler.lease_acquired", { schedulerOwner });
    }
    schedulerHasLease = true;
    await launchPolls();
    await launchSubmissions();
  } catch (cause) {
    queueLog("scheduler.tick_failed", { schedulerOwner, reason: u.error(cause).message }, "error");
  } finally {
    tickRunning = false;
    scheduleNextTick();
  }
}

async function scheduleNextTick() {
  if (timer) clearTimeout(timer);
  if (!schedulerStarted) {
    timer = null;
    return;
  }
  const [pollRow, submitRow, capacityRow] = await Promise.all([
    u.db("o_videoGenerationTask").whereIn("status", ["confirming", "processing"]).min("nextPollTime as time").first(),
    u.db("o_videoGenerationTask").where("status", "queued").min("nextSubmitTime as time").first(),
    u.db("o_videoProviderCapacity").where("capacityBlocked", 1).min("blockedUntil as time").first(),
  ]);
  const times = [pollRow, submitRow, capacityRow]
    .map((item: any) => Number(item?.time || 0))
    .filter((time) => time > 0);
  const nextTime = times.length ? Math.min(...times) : 0;
  const delay = nextTime ? Math.max(1000, Math.min(30_000, nextTime - Date.now())) : 5000;
  timer = setTimeout(() => void processQueue(), delay);
}

export function scheduleQueue(delayMs = 1000) {
  if (!schedulerStarted) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void processQueue(), delayMs);
}

export function startVideoGenerationQueue() {
  if (schedulerStarted) {
    queueLog("scheduler.start_skipped", { reason: "already_started" }, "warn");
    return;
  }
  schedulerStarted = true;
  queueLog("scheduler.started");
  scheduleQueue(0);
}

export async function stopVideoGenerationQueue() {
  schedulerStarted = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const released = await releaseVideoQueueSchedulerLease().catch(() => false);
  schedulerHasLease = false;
  queueLog("scheduler.stopped", { schedulerOwner, leaseReleased: released });
}
