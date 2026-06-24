import { randomUUID } from "node:crypto";
import db, { dbReady } from "@/utils/db";
import u from "@/utils";
import { executeImageFlowTask } from "@/services/imageFlowTask";
import { generateWorkbenchVideoPromptResult } from "@/services/workbenchVideoPrompt";
import {
  executeAssetImageTask,
  executeAssetPromptTask,
  executeAudioBindingTask,
  executeNovelEventTask,
  executeStoryboardImageTask,
  executeThumbnailTask,
} from "@/services/backgroundTaskHandlers";
import {
  claimUnifiedTask,
  createUnifiedTask,
  pruneTaskEvents,
  updateUnifiedTask,
  type UnifiedTaskType,
} from "@/services/taskCoordinator";
import { generateProjectSnapshot, importPortableProject } from "@/services/projectPortable";
import { performStorageMigration } from "@/services/storageMigration";

type TaskHandler = (payload: any, task: any) => Promise<Record<string, unknown> | void>;
const TASK_PENDING_FLAG = "__taskPending";

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

export interface UnifiedTaskWorker {
  stop(): Promise<void>;
}

export async function recoverInterruptedUnifiedTasks(database: any = db) {
  const now = Date.now();
  const rows = await database("o_tasks")
    .whereNotNull("handler")
    .whereIn("status", ["submitting", "processing"])
    .where((builder: any) => builder.whereNull("leaseExpiresAt").orWhere("leaseExpiresAt", "<", now));
  for (const task of rows) {
    if (task.providerTaskId) {
      await updateUnifiedTask(task.id, {
        status: "queued",
        phase: "resume-provider-query",
        availableAt: now,
        clearLease: true,
      }, database);
    } else {
      await updateUnifiedTask(task.id, {
        status: "failed",
        phase: "interrupted",
        reason: "任务执行进程重启，且缺少可安全恢复的供应商任务凭据",
        clearLease: true,
      }, database);
    }
  }
  return rows.length;
}

export async function startUnifiedTaskWorker(
  options: { limits?: Partial<Record<UnifiedTaskType, number>>; onWake?: () => void } = {},
): Promise<UnifiedTaskWorker> {
  await dbReady;
  const workerId = `${process.pid}:${randomUUID()}`;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const running = new Map<UnifiedTaskType, number>();
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
    try {
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
      running.set(type, Math.max(0, (running.get(type) || 1) - 1));
      options.onWake?.();
      schedule(0);
    }
  };

  const loop = async () => {
    if (stopped || loopRunning) return;
    loopRunning = true;
    try {
      const candidates = await (db as any)("o_tasks")
        .where("status", "queued")
        .whereNotNull("handler")
        .where((builder: any) => builder.whereNull("availableAt").orWhere("availableAt", "<=", Date.now()))
        .orderBy("priority", "desc")
        .orderBy("createdAt", "asc")
        .limit(50);
      const seenProjects = new Set<number>();
      for (const candidate of candidates) {
        const type = (candidate.taskType || "prompt") as UnifiedTaskType;
        if ((running.get(type) || 0) >= (limits[type] || 1)) continue;
        const projectId = Number(candidate.projectId || 0);
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
