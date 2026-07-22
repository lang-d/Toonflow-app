import { randomUUID } from "node:crypto";
import db, { dbReady } from "@/utils/db";
import u from "@/utils";
import { executeImageFlowTask, failInterruptedImageFlowTask } from "@/services/imageFlowTask";
import { generateWorkbenchVideoPromptResult } from "@/services/workbenchVideoPrompt";
import {
  executeAssetImageTask,
  executeAssetPromptTask,
  executeAudioBindingTask,
  executeStoryboardImageTask,
  executeThumbnailTask,
} from "@/services/backgroundTaskHandlers";
import { executeAssetFoundationTask } from "@/services/assetFoundation";
import {
  claimUnifiedTask,
  createUnifiedTask,
  pruneTaskEvents,
  renewUnifiedTaskLease,
  updateUnifiedTask,
  type UnifiedTaskType,
} from "@/services/taskCoordinator";
import { generateProjectSnapshot, importPortableProject } from "@/services/projectPortable";
import { performStorageMigration } from "@/services/storageMigration";
import { isImageGenerationTask, shouldDeferImageFlowCandidate } from "@/services/unifiedTaskDispatchPolicy";
import {
  executeMusicBibleGenerateTask,
  executeMusicBibleReviewTask,
  executeMusicCueCompilePromptTask,
  executeMusicCueGenerateTask,
  executeMusicCueReviewPromptTask,
  executeMusicPlanGenerateTask,
  executeMusicPlanReviewTask,
  executeMusicLyricsGenerateTask,
  executeMusicLyricsReviewTask,
  executeMusicLibraryCompilePromptTask,
  executeMusicLibraryGenerateTask,
  executeMusicAudioTrimTask,
  executeProjectContextPackGenerateTask,
} from "@/services/musicTaskHandlers";
import { executeScriptAssetExtractionTask } from "@/services/scriptAssetExtraction";
import { executeNovelEventExtractionTask, failPendingNovelEventExtraction } from "@/services/novelEventExtraction";

type TaskHandler = (payload: any, task: any) => Promise<Record<string, unknown> | void>;
const TASK_PENDING_FLAG = "__taskPending";
const IMAGE_FLOW_PROVIDER_PHASES = new Set(["provider-processing", "resume-provider-query"]);
const TASK_LEASE_MS = 120_000;
const TASK_LEASE_RENEW_MS = 30_000;
const MUSIC_TASK_TIMEOUT_MS = 20 * 60 * 1000;
const MUSIC_AUDIO_TASK_TIMEOUT_MS = 60 * 60 * 1000;

export interface ActiveUnifiedTaskSnapshot {
  taskId: number;
  taskKey?: string;
  handler?: string;
  taskType?: string;
  businessType?: string;
  businessId?: number;
  phase?: string;
  providerTaskId?: string | null;
  projectId?: number;
  scriptId?: number | null;
  startedAt: number;
  runningMs: number;
}

const activeTasks = new Map<number, Omit<ActiveUnifiedTaskSnapshot, "runningMs">>();

const handlers: Record<string, TaskHandler> = {
  "image-flow": async (payload, task) => executeImageFlowTask(payload, task),
  "workbench-prompt": async (payload, task) => {
    const result = await generateWorkbenchVideoPromptResult(payload, { taskId: task.taskId, legacyTaskId: task.id });
    await u.db("o_videoTrack").where({ id: payload.trackId }).update({ prompt: result.text, state: "已完成", reason: "" });
    return {
      businessId: payload.trackId,
      diagnosticFile: result.diagnosticFile,
      factSourceSummary: result.factSourceSummary,
      groupSummary: result.groupSummary,
    };
  },
  "asset-image": async (payload, task) => executeAssetImageTask(payload, task),
  "asset-prompt": async (payload) => executeAssetPromptTask(payload),
  "asset-foundation": async (payload) => executeAssetFoundationTask(payload),
  "storyboard-image": async (payload, task) => executeStoryboardImageTask(payload, task),
  "audio-binding": async (payload) => executeAudioBindingTask(payload),
  "novel-event": async (payload, task) => executeNovelEventExtractionTask(payload, task),
  thumbnail: async (payload) => executeThumbnailTask(payload),
  "project-snapshot": async (payload) => generateProjectSnapshot(Number(payload.projectId)),
  "project-import": async (payload) => importPortableProject(String(payload.sourceDirectory)),
  "storage-migration": async (payload, task) => performStorageMigration(payload, task.id),
  "music-bible-generate": async (payload, task) => executeMusicBibleGenerateTask(payload, task),
  "music-bible-review": async (payload, task) => executeMusicBibleReviewTask(payload, task),
  "music-plan-generate": async (payload, task) => executeMusicPlanGenerateTask(payload, task),
  "music-plan-review": async (payload, task) => executeMusicPlanReviewTask(payload, task),
  "music-cue-compile-prompt": async (payload, task) => executeMusicCueCompilePromptTask(payload, task),
  "music-cue-review-prompt": async (payload, task) => executeMusicCueReviewPromptTask(payload, task),
  "music-cue-generate": async (payload, task) => executeMusicCueGenerateTask(payload, task),
  "music-lyrics-generate": async (payload, task) => executeMusicLyricsGenerateTask(payload, task),
  "music-lyrics-review": async (payload, task) => executeMusicLyricsReviewTask(payload, task),
  "music-library-compile-prompt": async (payload, task) => executeMusicLibraryCompilePromptTask(payload, task),
  "music-library-generate": async (payload, task) => executeMusicLibraryGenerateTask(payload, task),
  "music-audio-trim": async (payload, task) => executeMusicAudioTrimTask(payload, task),
  "project-context-pack-generate": async (payload, task) => executeProjectContextPackGenerateTask(payload, task),
  "script-asset-extract": async (payload, task) => executeScriptAssetExtractionTask(payload, task),
};

function getTaskExecutionTimeoutMs(task: any) {
  const handler = String(task?.handler || "");
  if (["music-cue-generate", "music-library-generate", "music-audio-trim"].includes(handler)) return MUSIC_AUDIO_TASK_TIMEOUT_MS;
  if (handler.startsWith("music-")) return MUSIC_TASK_TIMEOUT_MS;
  return 0;
}

async function runTaskHandlerWithTimeout<T>(task: any, promise: Promise<T>): Promise<T> {
  const timeoutMs = getTaskExecutionTimeoutMs(task);
  if (!timeoutMs) return promise;
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`任务执行超过 ${Math.round(timeoutMs / 60000)} 分钟未完成，请减少输入资料或稍后重试。`));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DEFAULT_LIMITS: Record<UnifiedTaskType, number> = {
  prompt: 4,
  image: 5,
  asset: 2,
  storyboard: 2,
  video: 1,
  audio: 2,
  media: 2,
  maintenance: 1,
};

const ACTIVE_STATUSES = ["pending", "queued", "submitting", "processing"] as const;
const PRODUCTION_TASK_TYPES: UnifiedTaskType[] = ["prompt", "image", "asset", "storyboard", "video", "audio", "media"];
const AUTO_SNAPSHOT_IDLE_MS = 2 * 60 * 1000;
const MISSING_PROVIDER_TASK_ID_REASON = "\u4f9b\u5e94\u5546\u4efb\u52a1ID\u672a\u4fdd\u5b58\uff0c\u8bf7\u91cd\u65b0\u751f\u6210";

export function isImageFlowProviderPendingTask(task: any): boolean {
  return (
    task?.businessType === "image-flow" &&
    task?.taskType === "image" &&
    task?.status === "queued" &&
    Boolean(task?.providerTaskId) &&
    IMAGE_FLOW_PROVIDER_PHASES.has(String(task?.phase || ""))
  );
}

export async function readImageFlowProviderBacklog(
  database: any = db,
): Promise<{ count: number; taskIds: Set<number> }> {
  const rows = await database("o_tasks")
    .where({
      businessType: "image-flow",
      taskType: "image",
      status: "queued",
    })
    .whereNotNull("providerTaskId")
    .whereIn("phase", [...IMAGE_FLOW_PROVIDER_PHASES])
    .select("id");
  return {
    count: rows.length,
    taskIds: new Set(rows.map((row: any) => Number(row.id))),
  };
}

export function getActiveUnifiedTaskSnapshots(): ActiveUnifiedTaskSnapshot[] {
  const now = Date.now();
  return [...activeTasks.values()].map((task) => ({ ...task, runningMs: now - task.startedAt }));
}

function getRunningImageGenerationCount(): number {
  let count = 0;
  for (const task of activeTasks.values()) {
    if (isImageGenerationTask(task)) count += 1;
  }
  return count;
}

function getRunningScriptAssetExtractionProjectIds(): Set<number> {
  const projectIds = new Set<number>();
  for (const task of activeTasks.values()) {
    if (task.handler === "script-asset-extract" && Number(task.projectId || 0) > 0) {
      projectIds.add(Number(task.projectId));
    }
  }
  return projectIds;
}

export interface UnifiedTaskWorker {
  stop(): Promise<void>;
}

export async function recoverInterruptedUnifiedTasks(database: any = db, excludeTaskIds: Set<number> = new Set()) {
  const now = Date.now();
  const rows = await database("o_tasks")
    .whereNotNull("handler")
    .whereIn("status", ["submitting", "processing"])
    .where((builder: any) => builder.whereNull("leaseExpiresAt").orWhere("leaseExpiresAt", "<", now));
  let recoveredCount = 0;
  for (const task of rows) {
    if (excludeTaskIds.has(Number(task.id))) continue;
    recoveredCount += 1;
    if (task.providerTaskId) {
      console.warn("[unified-task-worker] recovering provider task", {
        taskId: task.id,
        businessType: task.businessType,
        businessId: task.businessId,
        phase: task.phase,
        providerTaskId: task.providerTaskId,
      });
      await updateUnifiedTask(task.id, {
        status: "queued",
        phase: "resume-provider-query",
        availableAt: now,
        clearLease: true,
      }, database);
    } else {
      console.warn("[unified-task-worker] failing interrupted task without provider id", {
        taskId: task.id,
        businessType: task.businessType,
        businessId: task.businessId,
        phase: task.phase,
      });
      if (task.businessType === "image-flow" && task.businessId) {
        await failInterruptedImageFlowTask({
          taskCenterId: Number(task.id),
          taskId: Number(task.businessId),
          reason: MISSING_PROVIDER_TASK_ID_REASON,
        });
      } else {
        if (task.handler === "novel-event") {
          let payload: any = {};
          try {
            payload = task.payloadJson ? JSON.parse(task.payloadJson) : {};
          } catch {
            // Keep the task failure path available even when a legacy payload is malformed.
          }
          await failPendingNovelEventExtraction(payload, MISSING_PROVIDER_TASK_ID_REASON, database);
        }
        await updateUnifiedTask(task.id, {
          status: "failed",
          phase: "interrupted",
          reason: MISSING_PROVIDER_TASK_ID_REASON,
          clearLease: true,
        }, database);
      }
      continue;
    }
  }
  return recoveredCount;
}

export async function startUnifiedTaskWorker(
  options: { limits?: Partial<Record<UnifiedTaskType, number>>; onWake?: () => void } = {},
): Promise<UnifiedTaskWorker> {
  await dbReady;
  const workerId = `${process.pid}:${randomUUID()}`;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const running = new Map<UnifiedTaskType, number>();
  const runningTaskIds = new Set<number>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let loopRunning = false;

  await recoverInterruptedUnifiedTasks();

  const projectHasActiveProductionTasks = async (projectId: number) => {
    const activeUnifiedTask = await (db as any)("o_tasks")
      .where("projectId", projectId)
      .whereIn("status", ACTIVE_STATUSES)
      .whereIn("taskType", PRODUCTION_TASK_TYPES)
      .where((builder: any) => builder.whereNull("businessType").orWhereNot("businessType", "project-snapshot"))
      .first();
    if (activeUnifiedTask) return true;
    const activeVideoTask = await (db as any)("o_videoGenerationTask")
      .where("projectId", projectId)
      .whereIn("status", ["queued", "submitting", "confirming", "processing"])
      .first();
    return Boolean(activeVideoTask);
  };

  const execute = async (task: any) => {
    const type = (task.taskType || "prompt") as UnifiedTaskType;
    running.set(type, (running.get(type) || 0) + 1);
    runningTaskIds.add(Number(task.id));
    activeTasks.set(Number(task.id), {
      taskId: Number(task.id),
      taskKey: task.taskId,
      handler: task.handler,
      taskType: task.taskType,
      businessType: task.businessType,
      businessId: task.businessId == null ? undefined : Number(task.businessId),
      phase: task.phase,
      providerTaskId: task.providerTaskId || null,
      projectId: task.projectId == null ? undefined : Number(task.projectId),
      scriptId: task.scriptId == null ? null : Number(task.scriptId),
      startedAt: Date.now(),
    });
    const refreshActiveTask = async () => {
      const active = activeTasks.get(Number(task.id));
      if (!active) return;
      const latest = await (db as any)("o_tasks")
        .where("id", task.id)
        .select("phase", "providerTaskId", "status", "progress")
        .first();
      if (!latest) return;
      activeTasks.set(Number(task.id), {
        ...active,
        phase: latest.phase || active.phase,
        providerTaskId: latest.providerTaskId || null,
      });
    };
    const activeRefreshTimer = setInterval(() => void refreshActiveTask().catch(() => undefined), 5000);
    activeRefreshTimer.unref();
    const leaseRenewTimer = setInterval(() => {
      void renewUnifiedTaskLease(Number(task.id), TASK_LEASE_MS).catch((error) => {
        console.warn("[unified-task-worker] lease renew failed:", u.error(error).message);
      });
    }, TASK_LEASE_RENEW_MS);
    leaseRenewTimer.unref();
    try {
      console.info("[unified-task-worker] executing task", {
        taskId: task.id,
        taskKey: task.taskId,
        handler: task.handler,
        businessType: task.businessType,
        businessId: task.businessId,
        phase: task.phase,
        providerTaskId: task.providerTaskId,
      });
      const handler = handlers[task.handler];
      if (!handler) throw new Error(`未注册任务处理器: ${task.handler}`);
      const payload = task.payloadJson ? JSON.parse(task.payloadJson) : {};
      await renewUnifiedTaskLease(Number(task.id), TASK_LEASE_MS);
      const result = await runTaskHandlerWithTimeout(task, handler(payload, task));
      if (result?.[TASK_PENDING_FLAG]) return;
      const latest = await (db as any)("o_tasks").where("id", task.id).first();
      if (!["completed", "failed", "cancelled"].includes(latest?.status)) {
        await updateUnifiedTask(task.id, {
          status: "completed",
          phase: "completed",
          progress: 100,
          result: result || undefined,
          clearLease: true,
        });
      }
    } catch (error) {
      const latest = await (db as any)("o_tasks").where("id", task.id).first();
      if (!["completed", "failed", "cancelled"].includes(latest?.status)) {
        await updateUnifiedTask(task.id, {
          status: "failed",
          phase: "failed",
          reason: u.error(error).message,
          clearLease: true,
        });
      }
    } finally {
      clearInterval(activeRefreshTimer);
      clearInterval(leaseRenewTimer);
      running.set(type, Math.max(0, (running.get(type) || 1) - 1));
      runningTaskIds.delete(Number(task.id));
      activeTasks.delete(Number(task.id));
      options.onWake?.();
      schedule(0);
    }
  };

  const loop = async () => {
    if (stopped || loopRunning) return;
    loopRunning = true;
    try {
      const recovered = await recoverInterruptedUnifiedTasks(db, runningTaskIds);
      if (recovered) console.warn("[unified-task-worker] recovered interrupted tasks before dispatch", { recovered });
      const candidates = await (db as any)("o_tasks")
        .where("status", "queued")
        .whereNotNull("handler")
        .where((builder: any) => builder.whereNull("availableAt").orWhere("availableAt", "<=", Date.now()))
        .orderBy("priority", "desc")
        .orderBy("createdAt", "asc")
        .limit(50);
      const imageFlowProviderBacklog = await readImageFlowProviderBacklog(db);
      const runningScriptAssetExtractionProjectIds = getRunningScriptAssetExtractionProjectIds();
      const seenProjects = new Set<number>();
      for (const candidate of candidates) {
        const type = (candidate.taskType || "prompt") as UnifiedTaskType;
        if ((running.get(type) || 0) >= (limits[type] || 1)) continue;
        const projectId = Number(candidate.projectId || 0);
        const queuedImageProviderCount = [...imageFlowProviderBacklog.taskIds].filter((taskId) => !runningTaskIds.has(taskId)).length;
        const runningImageGenerationCount = getRunningImageGenerationCount();
        if (candidate.handler === "script-asset-extract" && projectId && runningScriptAssetExtractionProjectIds.has(projectId)) {
          continue;
        }
        if (
          shouldDeferImageFlowCandidate(candidate, {
            imageLimit: limits.image || 1,
            occupiedImageCount: queuedImageProviderCount + runningImageGenerationCount,
          })
        ) {
          console.info("[unified-task-worker] deferred image-flow provider submit", {
            taskId: candidate.id,
            projectId,
            reason: "image-limit",
            providerBacklogCount: queuedImageProviderCount,
            runningImageGenerationCount,
            imageLimit: limits.image || 1,
          });
          continue;
        }
        if (projectId && seenProjects.has(projectId)) continue;
        if (projectId) seenProjects.add(projectId);
        const task = await claimUnifiedTask(workerId, TASK_LEASE_MS, db, Number(candidate.id));
        if (task) void execute(task);
      }
    } catch (error) {
      console.error("[unified-task-worker] dispatch failed:", u.error(error).message);
    } finally {
      loopRunning = false;
      schedule(1000);
    }
  };

  const schedule = (delay: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void loop(), delay);
    timer.unref();
  };

  const pruneTimer = setInterval(() => void pruneTaskEvents(), 60 * 60 * 1000);
  pruneTimer.unref();
  const snapshotTimer = setInterval(async () => {
    if (stopped) return;
    try {
      const stale = await (db as any)("o_projectStorage")
        .where("snapshotState", "stale")
        .whereRaw("revision > snapshotRevision")
        .where((builder: any) =>
          builder.whereNull("lastChangedAt").orWhere("lastChangedAt", "<=", Date.now() - AUTO_SNAPSHOT_IDLE_MS),
        )
        .orderBy("projectId")
        .limit(5);
      for (const item of stale) {
        const projectId = Number(item.projectId);
        if (await projectHasActiveProductionTasks(projectId)) continue;
        const exists = await (db as any)("o_tasks")
          .where({
            projectId,
            businessType: "project-snapshot",
          })
          .whereIn("status", ["queued", "submitting", "processing"])
          .first();
        if (exists) continue;
        await createUnifiedTask({
          projectId,
          taskClass: "Project snapshot",
          taskType: "maintenance",
          businessType: "project-snapshot",
          businessId: projectId,
          handler: "project-snapshot",
          payload: { projectId },
          priority: -10,
        });
      }
      if (stale.length) schedule(0);
    } catch (error) {
      console.warn("[project-snapshot] scan failed:", u.error(error).message);
    }
  }, 5000);
  snapshotTimer.unref();
  schedule(0);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(pruneTimer);
      clearInterval(snapshotTimer);
      const deadline = Date.now() + 15_000;
      while ([...running.values()].some((count) => count > 0) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}
