import { randomUUID } from "node:crypto";
import db, { dbReady } from "@/utils/db";
import u from "@/utils";
import { executeImageFlowTask, failInterruptedImageFlowTask } from "@/services/imageFlowTask";
import { generateWorkbenchVideoPromptResult } from "@/services/workbenchVideoPrompt";
import {
  executeAssetImageTask,
  executeAssetPromptTask,
  executeAudioBindingTask,
  executeNovelEventTask,
  executeStoryboardImageTask,
  executeThumbnailTask,
} from "@/services/backgroundTaskHandlers";
import { executeAssetFoundationTask } from "@/services/assetFoundation";
import {
  claimUnifiedTask,
  createUnifiedTask,
  pruneTaskEvents,
  updateUnifiedTask,
  type UnifiedTaskType,
} from "@/services/taskCoordinator";
import { generateProjectSnapshot, importPortableProject } from "@/services/projectPortable";
import { performStorageMigration } from "@/services/storageMigration";
import { shouldDeferImageFlowCandidate } from "@/services/unifiedTaskDispatchPolicy";

type TaskHandler = (payload: any, task: any) => Promise<Record<string, unknown> | void>;
const TASK_PENDING_FLAG = "__taskPending";
const IMAGE_FLOW_PROVIDER_PHASES = new Set(["provider-processing", "resume-provider-query"]);

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
  "novel-event": async (payload) => executeNovelEventTask(payload),
  thumbnail: async (payload) => executeThumbnailTask(payload),
  "project-snapshot": async (payload) => generateProjectSnapshot(Number(payload.projectId)),
  "project-import": async (payload) => importPortableProject(String(payload.sourceDirectory)),
  "storage-migration": async (payload, task) => performStorageMigration(payload, task.id),
};

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
): Promise<{ count: number; taskIds: Set<number>; projectIds: Set<number>; tasks: any[] }> {
  const rows = await database("o_tasks")
    .where({
      businessType: "image-flow",
      taskType: "image",
      status: "queued",
    })
    .whereNotNull("providerTaskId")
    .whereIn("phase", [...IMAGE_FLOW_PROVIDER_PHASES])
    .select("id", "projectId", "providerTaskId", "phase", "availableAt");
  const projectIds = rows.map((row: any) => Number(row.projectId || 0)).filter((value: number) => Boolean(value));
  return {
    count: rows.length,
    taskIds: new Set(rows.map((row: any) => Number(row.id))),
    projectIds: new Set(projectIds),
    tasks: rows,
  };
}

export function getActiveUnifiedTaskSnapshots(): ActiveUnifiedTaskSnapshot[] {
  const now = Date.now();
  return [...activeTasks.values()].map((task) => ({ ...task, runningMs: now - task.startedAt }));
}

function getRunningImageFlowProjectIds(): Set<number> {
  const projectIds = new Set<number>();
  for (const task of activeTasks.values()) {
    if (task.businessType === "image-flow" && Number(task.projectId || 0) > 0) {
      projectIds.add(Number(task.projectId));
    }
  }
  return projectIds;
}

function getRunningImageFlowSubmitCount(): number {
  let count = 0;
  for (const task of activeTasks.values()) {
    if (task.businessType === "image-flow" && !task.providerTaskId) count += 1;
  }
  return count;
}

function getRunningImageFlowTasks(): ActiveUnifiedTaskSnapshot[] {
  return getActiveUnifiedTaskSnapshots().filter((task) => task.businessType === "image-flow");
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
      const result = await handler(payload, task);
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
      const runningImageFlowProjectIds = getRunningImageFlowProjectIds();
      const runningImageFlowSubmitCount = getRunningImageFlowSubmitCount();
      const runningImageFlowTasks = getRunningImageFlowTasks();
      const seenProjects = new Set<number>();
      for (const candidate of candidates) {
        const type = (candidate.taskType || "prompt") as UnifiedTaskType;
        if ((running.get(type) || 0) >= (limits[type] || 1)) continue;
        const projectId = Number(candidate.projectId || 0);
        if (
          shouldDeferImageFlowCandidate(candidate, {
            imageLimit: limits.image || 1,
            providerBacklogCount: imageFlowProviderBacklog.count,
            providerBacklogProjectIds: imageFlowProviderBacklog.projectIds,
            runningImageFlowProjectIds,
            runningImageFlowSubmitCount,
          })
        ) {
          const blockedByProvider = imageFlowProviderBacklog.tasks.find((row: any) => Number(row.projectId || 0) === projectId);
          const blockedByRunning = runningImageFlowTasks.find((row) => Number(row.projectId || 0) === projectId);
          console.info("[unified-task-worker] deferred image-flow provider submit", {
            taskId: candidate.id,
            projectId,
            reason: blockedByProvider ? "provider-backlog" : blockedByRunning ? "running-submit" : "image-limit",
            blockedByTaskId: blockedByProvider?.id ?? blockedByRunning?.taskId,
            blockedByProviderTaskId: blockedByProvider?.providerTaskId ?? blockedByRunning?.providerTaskId,
            providerBacklogCount: imageFlowProviderBacklog.count,
            runningImageFlowSubmitCount,
          });
          continue;
        }
        if (projectId && seenProjects.has(projectId)) continue;
        if (projectId) seenProjects.add(projectId);
        const task = await claimUnifiedTask(workerId, 120_000, db, Number(candidate.id));
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
