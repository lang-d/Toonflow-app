import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import u from "@/utils";
import { updateUnifiedTask } from "@/services/taskCoordinator";
import { createLogger } from "@/logger";
import type {
  StoredVideoRequest,
  VideoCapacityCandidate,
  VideoExecutionOutcome,
  VideoProviderPatch,
  VideoOutputType,
  VideoQueueRow,
} from "./contracts";
import { getVideoProviderExecutor } from "./registry";
import {
  cleanupLegacyVideoReferences,
  mergeVideoDiagnostics,
  parseVideoModelKey,
  resolveVideoReferences,
  summarizeVideoError,
  truncateVideoDiagnostic,
  videoCapacityRetryAt,
} from "./shared";

const videoTaskLog = createLogger("video-task");
const ACTIVE_UNIFIED_STATUSES = ["submitting", "processing"];

function legacyState(status: "queued" | "processing" | "completed" | "failed" | "cancelled") {
  return ({ queued: "排队中", processing: "生成中", completed: "已完成", failed: "生成失败", cancelled: "已取消" })[status];
}

async function getModelConfig(model: string) {
  const { vendorId, modelName } = parseVideoModelKey(model);
  const models = await u.vendor.getModelList(vendorId);
  return { modelName, config: models.find((item: any) => item.modelName === modelName) || { modelName, type: "video" } };
}

function providerPatch(patch?: VideoProviderPatch) {
  if (!patch) return {};
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

async function applyDetailPatch(row: VideoQueueRow, patch: Record<string, unknown>) {
  await u.db("o_videoGenerationTask").where({ id: row.id, taskCenterId: row.taskCenterId }).update({
    ...patch,
    updateTime: Date.now(),
  });
}

async function claimCapacity(row: VideoQueueRow, task: any, candidates: VideoCapacityCandidate[]) {
  for (const candidate of candidates) {
    const claimed = await u.db.transaction(async (trx: any) => {
      const latest = await trx("o_tasks").where({ id: task.id, version: task.version, status: "processing" }).first();
      if (!latest || latest.providerTaskId) return false;
      const occupied = await trx("o_videoGenerationTask as detail")
        .join("o_tasks as task", "task.id", "detail.taskCenterId")
        .where("detail.providerCapacityKey", candidate.key)
        .whereIn("task.status", ACTIVE_UNIFIED_STATUSES)
        .whereNot("detail.id", row.id)
        .count("detail.id as total")
        .first();
      if (Number(occupied?.total || 0) >= candidate.limit) return false;
      const now = Date.now();
      const nextVersion = Number(latest.version || 0) + 1;
      const reserved = await trx("o_tasks")
        .where({ id: latest.id, version: latest.version, status: "processing" })
        .whereNull("providerTaskId")
        .update({ phase: "submitting", version: nextVersion, updateTime: now });
      if (!reserved) return false;
      await trx("o_videoGenerationTask").where("id", row.id).update({
        providerCapacityKey: candidate.key,
        providerAccountId: candidate.providerAccountId ?? row.providerAccountId ?? null,
        updateTime: now,
      });
      await trx("o_taskEvent").insert({
        taskId: latest.taskId,
        legacyTaskId: latest.id,
        version: nextVersion,
        taskType: latest.taskType || "video",
        projectId: latest.projectId,
        scriptId: latest.scriptId ?? latest.episode ?? null,
        targetType: latest.targetType || null,
        targetId: latest.targetId == null ? null : String(latest.targetId),
        nodeId: latest.nodeId || null,
        status: "processing",
        phase: "submitting",
        progress: latest.progress ?? null,
        resultJson: latest.resultJson || null,
        reason: null,
        createdAt: now,
      });
      return { candidate, taskVersion: nextVersion };
    });
    if (claimed) return claimed;
  }
  return null;
}

async function saveVideoOutput(data: string, dataType: VideoOutputType, targetPath: string) {
  if (dataType === "file") {
    if (data !== targetPath) await u.oss.copyLocalFile(data, targetPath);
  } else if (dataType === "url") {
    const response = await axios.get(data, { responseType: "stream", timeout: 180_000 });
    await u.oss.writeStream(targetPath, response.data);
  } else {
    await u.oss.writeFile(targetPath, data);
  }
}

function outputExtension(data: string) {
  return data.match(/\.(mp4|mov|webm|mkv|avi)(?:[?#]|$)/i)?.[1]?.toLowerCase() || "mp4";
}

async function saveOutput(row: VideoQueueRow, request: StoredVideoRequest, outcome: Extract<VideoExecutionOutcome, { kind: "completed" }>) {
  if (!request.videoPath) throw new Error("Video task is missing its result path.");
  await saveVideoOutput(outcome.data, outcome.dataType, request.videoPath);
  const extraCandidates: Array<{ filePath: string }> = [];
  for (const output of outcome.additionalOutputs || []) {
    const filePath = `/${row.projectId}/video/${uuidv4()}.${outputExtension(output.data)}`;
    await saveVideoOutput(output.data, output.dataType, filePath);
    extraCandidates.push({ filePath });
  }
  videoTaskLog.info("Video result saved", {
    event: "video.result.saved",
    queueTaskId: row.id,
    videoId: row.videoId,
    dataType: outcome.dataType,
    additionalCandidateCount: extraCandidates.length,
  });
  return extraCandidates;
}

async function terminalFailure(row: VideoQueueRow, task: any, reason: string, diagnostic?: string) {
  const errorReason = summarizeVideoError(reason);
  const updated = await updateUnifiedTask(task.id, {
    status: "failed",
    phase: "failed",
    reason: errorReason,
    progress: null,
    clearLease: true,
    expectedVersion: task.version,
    expectedStatus: "processing",
    expectedProviderTaskId: task.providerTaskId || null,
  });
  if (!updated) return false;
  const now = Date.now();
  await applyDetailPatch(row, {
    phase: "failed", status: "failed", state: legacyState("failed"), errorReason,
    rawOutput: mergeVideoDiagnostics(row.rawOutput, diagnostic), finishTime: now,
  });
  await u.db("o_video").where("id", row.videoId).update({ state: legacyState("failed"), errorReason });
  await cleanupLegacyVideoReferences(row);
  return true;
}

async function terminalSuccess(row: VideoQueueRow, task: any, request: StoredVideoRequest, outcome: Extract<VideoExecutionOutcome, { kind: "completed" }>) {
  const finalizing = await updateUnifiedTask(task.id, {
    status: "processing",
    phase: "finalizing",
    progress: null,
    expectedVersion: task.version,
    expectedStatus: "processing",
    expectedProviderTaskId: task.providerTaskId || null,
  });
  if (!finalizing) return false;
  let extraCandidates: Array<{ filePath: string }>;
  try {
    extraCandidates = await saveOutput(row, request, outcome);
  } catch (cause: any) {
    const latest = await u.db("o_tasks").where("id", task.id).first();
    return terminalFailure(row, latest, `Video result download/save failed: ${cause?.message || cause}`, outcome.diagnostic);
  }
  const completed = await updateUnifiedTask(task.id, {
    status: "completed",
    phase: "completed",
    progress: 100,
    result: { businessId: row.videoId },
    reason: "",
    clearLease: true,
    expectedVersion: finalizing.version,
    expectedStatus: "processing",
    expectedProviderTaskId: task.providerTaskId || null,
  });
  if (!completed) return false;
  const now = Date.now();
  await applyDetailPatch(row, {
    phase: "completed", status: "completed", state: legacyState("completed"), errorReason: "",
    rawOutput: mergeVideoDiagnostics(row.rawOutput, outcome.diagnostic), finishTime: now,
  });
  await u.db.transaction(async (trx: any) => {
    await trx("o_video").where("id", row.videoId).update({ state: legacyState("completed"), errorReason: "" });
    if (extraCandidates.length) {
      await trx("o_video").insert(extraCandidates.map((item) => ({
        filePath: item.filePath,
        time: now,
        state: legacyState("completed"),
        scriptId: row.scriptId,
        projectId: row.projectId,
        videoTrackId: request.relatedObjects.trackId,
      })));
    }
  });
  await cleanupLegacyVideoReferences(row);
  return true;
}

async function applyNonTerminal(row: VideoQueueRow, task: any, outcome: Exclude<VideoExecutionOutcome, { kind: "completed" | "failed" }>) {
  const now = Date.now();
  const providerTaskId = outcome.kind === "accepted" ? outcome.providerTaskId : task.providerTaskId || null;
  const queued = outcome.kind === "wait";
  const progress = "progress" in outcome ? outcome.progress : null;
  const unified = await updateUnifiedTask(task.id, {
    status: queued ? "queued" : "processing",
    phase: outcome.phase,
    progress: progress === undefined ? null : progress,
    reason: outcome.kind === "pending" ? outcome.reason || "" : outcome.kind === "wait" ? outcome.reason : "",
    providerTaskId,
    providerSubmittedAt: outcome.kind === "accepted" ? now : undefined,
    availableAt: outcome.retryAt,
    clearLease: true,
    expectedVersion: task.version,
    expectedStatus: "processing",
    expectedProviderTaskId: task.providerTaskId || null,
  });
  if (!unified) return false;
  const status = queued ? "queued" : outcome.phase === "confirming" ? "confirming" : "processing";
  await applyDetailPatch(row, {
    ...providerPatch(outcome.patch),
    providerCapacityKey: queued ? null : row.providerCapacityKey,
    submitId: providerTaskId,
    providerSubmittedAt: outcome.kind === "accepted" ? now : row.providerSubmittedAt,
    confirmStartedAt: outcome.kind === "accepted" ? now : row.confirmStartedAt,
    phase: outcome.phase,
    status,
    state: queued ? legacyState("queued") : legacyState("processing"),
    errorReason: "",
    rawOutput: mergeVideoDiagnostics(row.rawOutput, outcome.diagnostic),
    pollCount: Number(row.pollCount || 0) + (outcome.kind === "pending" ? 1 : 0),
    submitAttemptCount: Number(row.submitAttemptCount || 0) + (outcome.kind === "accepted" ? 1 : 0),
    nextSubmitTime: queued ? outcome.retryAt : null,
    nextPollTime: queued ? null : outcome.retryAt,
  });
  return true;
}

export async function executeVideoGenerationTask(payload: any, task: any) {
  const queueTaskId = Number(payload?.queueTaskId || 0);
  const row = await u.db("o_videoGenerationTask").where({ id: queueTaskId, taskCenterId: task.id }).first() as VideoQueueRow | undefined;
  if (!row) throw new Error(`Video task detail not found: ${queueTaskId}`);
  try {
  if (!task.providerTaskId && row.submitId) {
    const adopted = await updateUnifiedTask(task.id, {
      status: "processing",
      phase: "resume-provider-query",
      progress: task.progress ?? null,
      providerTaskId: row.submitId,
      providerSubmittedAt: row.providerSubmittedAt || row.confirmStartedAt || row.startTime,
      expectedVersion: task.version,
      expectedStatus: "processing",
      expectedProviderTaskId: null,
    });
    if (!adopted) return { __taskPending: true };
    task.version = adopted.version;
    task.providerTaskId = row.submitId;
    task.phase = "resume-provider-query";
  }
  const request = JSON.parse(row.requestJson || "{}") as StoredVideoRequest;
  const { vendorId, modelName } = parseVideoModelKey(row.model);
  const executor = getVideoProviderExecutor(vendorId);
  const { config: modelConfig } = await getModelConfig(row.model);
  let referencePromise: Promise<any> | null = null;
  const context = {
    row,
    task,
    request,
    modelName,
    modelConfig,
    references: () => referencePromise ||= resolveVideoReferences(row, request),
  };

  let outcome: VideoExecutionOutcome;
  if (task.providerTaskId || row.submitId) {
    outcome = await executor.poll(context);
  } else {
    const reservation = await executor.reserveSubmission(context);
    if (reservation.kind === "failed") outcome = reservation;
    else if (reservation.kind === "wait") outcome = reservation;
    else {
      const reservationClaim = await claimCapacity(row, task, reservation.candidates);
      if (!reservationClaim) {
        outcome = { kind: "wait", phase: "capacity_wait", reason: "Provider capacity is currently occupied.", retryAt: videoCapacityRetryAt() };
      } else {
        const slot = reservationClaim.candidate;
        task.version = reservationClaim.taskVersion;
        task.phase = "submitting";
        row.providerCapacityKey = slot.key;
        row.providerAccountId = slot.providerAccountId || row.providerAccountId;
        outcome = await executor.submit(context, slot);
      }
    }
  }

  if (outcome.kind === "failed") await terminalFailure(row, task, outcome.reason, outcome.diagnostic);
  else if (outcome.kind === "completed") await terminalSuccess(row, task, request, outcome);
  else await applyNonTerminal(row, task, outcome);
  if ((outcome.kind === "failed" || outcome.kind === "completed") && executor.release) {
    try {
      await executor.release(context);
    } catch (cause: any) {
      videoTaskLog.warn("Video provider release failed after terminal state", {
        event: "video.capacity.release.failed",
        queueTaskId: row.id,
        reason: cause?.message || String(cause),
      });
    }
  }
  } catch (cause: any) {
    const latest = await u.db("o_tasks").where("id", task.id).first();
    if (latest && !["completed", "failed", "cancelled"].includes(String(latest.status || ""))) {
      await terminalFailure(
        row,
        latest,
        `Video provider execution failed: ${cause?.message || cause}`,
        truncateVideoDiagnostic(cause?.stack || cause?.message || String(cause)),
      );
    }
  }
  return { __taskPending: true };
}

export { applyNonTerminal as applyVideoNonTerminalOutcome, claimCapacity as claimVideoProviderCapacity };
