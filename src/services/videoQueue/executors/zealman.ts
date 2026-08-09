import u from "@/utils";
import {
  getZealmanWorkflow,
  inspectZealmanAvailability,
  inspectZealmanEndpoint,
  inspectZealmanPendingTask,
  parseZealmanInstanceUrls,
  pollZealmanVideo,
  submitZealmanVideo,
  type ZealmanEndpoint,
  type ZealmanPendingTaskProbe,
} from "@/services/zealmanVideo";
import { getZealmanWorkflowExecutionOverrides } from "@/services/zealmanWorkflowSettings";
import type { VideoExecutionOutcome, VideoProviderExecutor } from "../contracts";
import {
  isProviderWorkTimedOut,
  mergeVideoDiagnostics,
  providerWorkElapsedMs,
  videoCapacityRetryAt,
} from "../shared";

export const ZEALMAN_PENDING_GRACE_MS = 60_000;

export function isZealmanPendingTaskMissing(
  row: Parameters<typeof providerWorkElapsedMs>[0],
  probe: Pick<ZealmanPendingTaskProbe, "queueIdle" | "historyHasPrompt">,
  now = Date.now(),
) {
  return providerWorkElapsedMs(row, now) >= ZEALMAN_PENDING_GRACE_MS && probe.queueIdle && !probe.historyHasPrompt;
}

function queueConfig(context: Parameters<VideoProviderExecutor["submit"]>[0]) {
  const source = context.modelConfig?.queueConfig || {};
  return {
    pollMinIntervalSec: Math.max(2, Number(source.pollMinIntervalSec || 15)),
    maxWorkHours: Math.max(1, Number(source.maxWorkHours || source.maxWaitHours || 6)),
  };
}

function evidence(kind: "remote_reconcile" | "remote_unavailable_reconcile", stage: "first" | "confirmed", raw: string) {
  return JSON.stringify({ [kind]: { stage, observedAt: Date.now() }, probe: raw });
}

export const zealmanVideoExecutor: VideoProviderExecutor = {
  vendorId: "zealman",

  getProviderModelKey(modelName) {
    return `zealman:${modelName}`;
  },

  async reserveSubmission(context) {
    const vendor = await u.db("o_vendorConfig").where("id", "zealman").first();
    let inputValues: Record<string, unknown> = {};
    try { inputValues = JSON.parse(String(vendor?.inputValues || "{}")); } catch {}
    const urls = parseZealmanInstanceUrls(inputValues.instanceUrls);
    const probes = await Promise.all(urls.map(async (url) => {
      try { return { endpoint: await inspectZealmanEndpoint(url, context.row.providerModelKey || this.getProviderModelKey(context.modelName)) }; }
      catch (cause: any) { return { url, error: cause?.message || String(cause) }; }
    }));
    const ready = probes.filter((item): item is { endpoint: ZealmanEndpoint } => Boolean((item as any).endpoint)).map((item) => item.endpoint);
    const groups = new Map<string, ZealmanEndpoint[]>();
    for (const item of ready) groups.set(item.workflowHash, [...(groups.get(item.workflowHash) || []), item]);
    const compatible = [...groups.values()].sort((a, b) => b.length - a.length || a[0].workflowHash.localeCompare(b[0].workflowHash))[0] || [];
    if (!compatible.length) {
      return {
        kind: "wait",
        phase: "remote_unavailable",
        reason: "No healthy Zealman instance is currently available.",
        retryAt: videoCapacityRetryAt(),
        diagnostic: JSON.stringify({ zealmanEndpoints: probes }),
      };
    }
    return {
      kind: "ready",
      candidates: compatible
        .sort((a, b) => a.url.localeCompare(b.url))
        .map((item) => ({ key: `zealman:${item.url}`, limit: 1, providerAccountId: item.url, metadata: { workflowHash: item.workflowHash } })),
    };
  },

  async submit(context, reservation): Promise<VideoExecutionOutcome> {
    const endpoint = String(reservation.providerAccountId || "");
    if (!endpoint) return { kind: "failed", reason: "Zealman task was not bound to an instance." };
    const modelKey = context.row.providerModelKey || this.getProviderModelKey(context.modelName);
    const workflow = getZealmanWorkflow(modelKey);
    const vendor = await u.db("o_vendorConfig").where("id", "zealman").first("inputValues");
    let inputValues: Record<string, unknown> = {};
    try { inputValues = JSON.parse(String(vendor?.inputValues || "{}")); } catch { return { kind: "failed", reason: "Zealman supplier settings are invalid JSON." }; }
    const executionOverrides = getZealmanWorkflowExecutionOverrides(inputValues, workflow.workflowId);
    const submitted = await submitZealmanVideo(endpoint, modelKey, {
      ...context.request.input,
      references: await context.references(),
    }, undefined, executionOverrides);
    return {
      kind: "accepted",
      providerTaskId: submitted.promptId,
      phase: "processing",
      retryAt: Date.now() + 2_000,
      progress: null,
      diagnostic: JSON.stringify({ promptId: submitted.promptId, workflow: submitted.workflowId, workflowHash: submitted.workflowHash }),
      patch: { providerAccountId: endpoint, officialTaskId: submitted.promptId, remoteConfirmedAt: Date.now() },
    };
  },

  async poll(context): Promise<VideoExecutionOutcome> {
    const row = context.row;
    const promptId = String(context.task.providerTaskId || row.submitId || "");
    const endpoint = String(row.providerAccountId || "");
    if (!promptId || !endpoint) return { kind: "failed", reason: "Zealman task is missing instance address or prompt_id." };
    const config = queueConfig(context);
    if (isProviderWorkTimedOut(row, config.maxWorkHours)) {
      return { kind: "failed", reason: `Zealman task exceeded ${config.maxWorkHours} hours. prompt_id=${promptId}`, diagnostic: row.rawOutput || "" };
    }
    try {
      const result = await pollZealmanVideo(endpoint, promptId, { audio: context.request.input.audio });
      if (result.state === "success") return {
        kind: "completed",
        data: result.urls[0],
        dataType: "url",
        additionalOutputs: result.urls.slice(1).map((data: string) => ({ data, dataType: "url" as const })),
        diagnostic: result.rawOutput,
      };
      if (result.state === "failed") return { kind: "failed", reason: result.error, diagnostic: result.rawOutput };
      if (providerWorkElapsedMs(row) >= ZEALMAN_PENDING_GRACE_MS) {
        const probe = await inspectZealmanPendingTask(endpoint, promptId);
        const diagnostics = mergeVideoDiagnostics(result.rawOutput, probe.rawOutput);
        if (isZealmanPendingTaskMissing(row, probe)) {
          if (context.task.phase === "remote_reconcile") {
            return { kind: "failed", reason: `Zealman cloud ComfyUI lost prompt_id; it was not resubmitted. prompt_id=${promptId}`, diagnostic: evidence("remote_reconcile", "confirmed", diagnostics) };
          }
          return {
            kind: "pending",
            phase: "remote_reconcile",
            reason: "Zealman task is absent from queue/history; confirming once more without resubmission.",
            retryAt: Date.now() + config.pollMinIntervalSec * 1000,
            progress: null,
            diagnostic: evidence("remote_reconcile", "first", diagnostics),
          };
        }
      }
      return {
        kind: "pending",
        phase: "processing",
        retryAt: Date.now() + config.pollMinIntervalSec * 1000,
        progress: null,
        diagnostic: result.rawOutput,
      };
    } catch (cause: any) {
      const availability = await inspectZealmanAvailability(endpoint);
      const diagnostics = mergeVideoDiagnostics(row.rawOutput, availability.rawOutput);
      if (availability.unavailable) {
        if (context.task.phase === "remote_unavailable_reconcile") {
          return { kind: "failed", reason: `Zealman cloud instance is unavailable; task was not resubmitted. prompt_id=${promptId}`, diagnostic: evidence("remote_unavailable_reconcile", "confirmed", diagnostics) };
        }
        return {
          kind: "pending",
          phase: "remote_unavailable_reconcile",
          reason: "Confirming whether the Zealman instance is unavailable; task was not resubmitted.",
          retryAt: Date.now() + config.pollMinIntervalSec * 1000,
          progress: null,
          diagnostic: evidence("remote_unavailable_reconcile", "first", diagnostics),
        };
      }
      return {
        kind: "pending",
        phase: "processing",
        reason: `Zealman query temporarily failed and will retry on the original instance: ${cause?.message || cause}`,
        retryAt: Date.now() + config.pollMinIntervalSec * 1000,
        progress: null,
        diagnostic: diagnostics,
      };
    }
  },
};
