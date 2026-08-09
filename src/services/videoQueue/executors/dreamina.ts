import dreaminaCli from "@/utils/dreaminaCli";
import u from "@/utils";
import type { VideoExecutionOutcome, VideoProviderExecutor } from "../contracts";
import {
  isProviderWorkTimedOut,
  mergeVideoDiagnostics,
  providerWorkElapsedMs,
  scopedVideoProviderCapacityKey,
  videoCapacityRetryAt,
} from "../shared";

const DREAMINA_CONFIRM_TIMEOUT_MS = 20 * 60 * 1000;

function queueConfig(context: Parameters<VideoProviderExecutor["submit"]>[0]) {
  return dreaminaCli.normalizeQueueConfig(context.modelConfig?.queueConfig, 1);
}

function nextPollDelay(config: ReturnType<typeof dreaminaCli.normalizeQueueConfig>, queueStatus?: number, confirmed = true) {
  if (!confirmed) return config.pollInitialDelaySec * 1000;
  if (queueStatus === 1) return config.pollMaxIntervalSec * 1000;
  return config.pollMinIntervalSec * 1000;
}

async function markCapacityBlocked(providerModelKey: string, providerAccountId: string | null | undefined, blockedUntil: number, code?: string | null) {
  const now = Date.now();
  await u.db("o_videoProviderCapacity")
    .insert({
      vendorId: "dreamina",
      providerAccountId: providerAccountId || "default",
      providerModelKey,
      capacityBlocked: 1,
      blockedUntil,
      lastProviderCode: code || null,
      createTime: now,
      updateTime: now,
    })
    .onConflict(["vendorId", "providerAccountId", "providerModelKey"])
    .merge({ capacityBlocked: 1, blockedUntil, lastProviderCode: code || null, updateTime: now });
}

async function clearCapacityBlock(providerModelKey: string) {
  await u.db("o_videoProviderCapacity")
    .where({ vendorId: "dreamina", providerModelKey })
    .update({ capacityBlocked: 0, blockedUntil: null, updateTime: Date.now() });
}

export const dreaminaVideoExecutor: VideoProviderExecutor = {
  vendorId: "dreamina",

  getProviderModelKey(modelName) {
    return dreaminaCli.getDreaminaProviderModelKey(modelName);
  },

  async reserveSubmission(context) {
    const config = queueConfig(context);
    const key = scopedVideoProviderCapacityKey("dreamina", context.row.providerModelKey || this.getProviderModelKey(context.modelName));
    const blocked = await u.db("o_videoProviderCapacity")
      .where({ vendorId: "dreamina", providerModelKey: key, capacityBlocked: 1 })
      .where("blockedUntil", ">", Date.now())
      .orderBy("blockedUntil", "desc")
      .first();
    if (blocked) {
      return {
        kind: "wait",
        phase: "capacity_wait",
        reason: "Dreamina provider capacity is cooling down.",
        retryAt: Number(blocked.blockedUntil),
      };
    }
    return { kind: "ready", candidates: [{ key, limit: config.maxConcurrent }] };
  },

  async submit(context, reservation): Promise<VideoExecutionOutcome> {
    const config = queueConfig(context);
    const submit = await dreaminaCli.videoSubmit(
      { ...context.request.input, referenceList: await context.references() },
      context.modelConfig,
    );
    if (submit.state === "capacity_wait") {
      const retryAt = videoCapacityRetryAt();
      await markCapacityBlocked(reservation.key, submit.providerAccountId, retryAt, submit.providerCode || "1310");
      return {
        kind: "wait",
        phase: "capacity_wait",
        reason: "Dreamina provider capacity is temporarily unavailable.",
        retryAt,
        diagnostic: submit.rawOutput,
        patch: {
          providerAccountId: submit.providerAccountId || context.row.providerAccountId || null,
          lastProviderCode: submit.providerCode || "1310",
        },
      };
    }
    if (submit.state === "failed") {
      return { kind: "failed", reason: submit.errorReason || "Dreamina video submission failed.", diagnostic: submit.rawOutput };
    }
    if (!submit.submitId) return { kind: "failed", reason: "Dreamina did not return submit_id.", diagnostic: submit.rawOutput };
    await clearCapacityBlock(reservation.key);
    const confirmed = Boolean(submit.confirmed);
    return {
      kind: "accepted",
      providerTaskId: submit.submitId,
      phase: confirmed ? "processing" : "confirming",
      retryAt: Date.now() + config.pollInitialDelaySec * 1000,
      diagnostic: submit.rawOutput,
      progress: confirmed ? 20 : 10,
      patch: {
        providerAccountId: submit.providerAccountId || null,
        officialTaskId: submit.officialTaskId || null,
        historyRecordId: submit.historyRecordId || null,
        remoteConfirmedAt: confirmed ? Date.now() : null,
        lastProviderCode: submit.providerCode || null,
      },
    };
  },

  async poll(context): Promise<VideoExecutionOutcome> {
    const row = context.row;
    const submitId = String(context.task.providerTaskId || row.submitId || "");
    if (!submitId) return { kind: "failed", reason: "Dreamina task is missing submit_id." };
    const config = queueConfig(context);
    const providerSubmittedAt = Number(row.providerSubmittedAt || row.confirmStartedAt || row.remoteConfirmedAt || 0);
    const timedOut = isProviderWorkTimedOut({ ...row, providerSubmittedAt }, config.maxWorkHours);
    let poll: Awaited<ReturnType<typeof dreaminaCli.videoPoll>>;
    try {
      poll = context.task.phase === "confirming"
        ? await dreaminaCli.videoConfirm(submitId)
        : await dreaminaCli.videoPoll(submitId);
    } catch (cause: any) {
      if (timedOut) {
        return { kind: "failed", reason: `Dreamina task exceeded ${config.maxWorkHours} hours and final query failed: ${cause?.message || cause}. submit_id=${submitId}` };
      }
      return {
        kind: "pending",
        phase: context.task.phase === "confirming" ? "confirming" : "processing",
        retryAt: Date.now() + nextPollDelay(config, row.providerQueueStatus ?? undefined, context.task.phase !== "confirming"),
        reason: `Dreamina query temporarily failed and will retry: ${cause?.message || cause}`,
      };
    }
    if (row.providerAccountId && poll.providerAccountId && row.providerAccountId !== poll.providerAccountId) {
      return { kind: "failed", reason: `Dreamina account changed from ${row.providerAccountId} to ${poll.providerAccountId}.`, diagnostic: poll.rawOutput };
    }
    if (poll.state === "success" && poll.data) {
      return { kind: "completed", data: poll.data, dataType: poll.dataType || "base64", diagnostic: mergeVideoDiagnostics(row.rawOutput, poll.rawOutput) };
    }
    if (poll.state === "failed") {
      return { kind: "failed", reason: poll.errorReason || "Dreamina video generation failed.", diagnostic: poll.rawOutput };
    }
    const confirmed = poll.evidence.confirmed || Boolean(row.officialTaskId || row.historyRecordId || row.remoteConfirmedAt);
    const confirmStartedAt = Number(row.confirmStartedAt || providerSubmittedAt || 0);
    if (!confirmed && confirmStartedAt > 0 && Date.now() - confirmStartedAt >= DREAMINA_CONFIRM_TIMEOUT_MS) {
      return { kind: "failed", reason: `Dreamina did not confirm the submission. submit_id=${submitId}`, diagnostic: poll.rawOutput };
    }
    if (timedOut) {
      return { kind: "failed", reason: `Dreamina task exceeded ${config.maxWorkHours} hours. submit_id=${submitId}`, diagnostic: poll.rawOutput };
    }
    const now = Date.now();
    return {
      kind: "pending",
      phase: confirmed ? "processing" : "confirming",
      retryAt: now + nextPollDelay(config, poll.queueInfo.status, confirmed),
      diagnostic: mergeVideoDiagnostics(row.rawOutput, poll.rawOutput),
      progress: confirmed ? Math.max(20, Math.min(90, 20 + Number(row.pollCount || 0) + 1)) : 10,
      patch: {
        providerAccountId: poll.providerAccountId || row.providerAccountId || null,
        officialTaskId: poll.evidence.officialTaskId || row.officialTaskId || null,
        historyRecordId: poll.evidence.historyRecordId || row.historyRecordId || null,
        remoteConfirmedAt: confirmed ? row.remoteConfirmedAt || now : null,
        lastProviderStatus: poll.queueInfo.status === 1 ? "queued" : poll.queueInfo.status === 2 ? "processing" : "confirming",
        lastProviderCode: poll.providerCode || row.lastProviderCode || null,
        providerQueueStatus: poll.queueInfo.status ?? null,
        providerQueueIndex: poll.queueInfo.index ?? null,
        providerQueueLength: poll.queueInfo.length ?? null,
      },
    };
  },

  async release(context) {
    const key = scopedVideoProviderCapacityKey("dreamina", context.row.providerModelKey || this.getProviderModelKey(context.modelName));
    await clearCapacityBlock(key);
  },
};

export { nextPollDelay as nextDreaminaPollDelayMs, providerWorkElapsedMs };
