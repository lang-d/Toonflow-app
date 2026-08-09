import { randomUUID } from "node:crypto";
import db from "@/utils/db";
import { toLegacyTaskState, toTaskStatus, type TaskStatus } from "@/lib/taskStatus";
import { normalizeTaskResultSync } from "@/services/mediaRef";
import { createLogger } from "@/logger";

export type UnifiedTaskType =
  | "image"
  | "asset"
  | "storyboard"
  | "video"
  | "prompt"
  | "audio"
  | "media"
  | "maintenance";

export interface TaskEvent {
  eventId: number;
  taskId: string;
  legacyTaskId?: number;
  version: number;
  taskType: UnifiedTaskType;
  projectId: number;
  scriptId?: number;
  targetType?: string;
  targetId?: string;
  nodeId?: string;
  /** Business object affected by the task (for video generation, this is videoId). */
  businessId?: number;
  status: TaskStatus;
  phase?: string;
  progress?: number | null;
  result?: Record<string, unknown>;
  reason?: string;
  updatedAt: number;
}

export interface CreateUnifiedTaskInput {
  taskId?: string;
  projectId: number;
  scriptId?: number;
  taskClass: string;
  taskType: UnifiedTaskType;
  status?: TaskStatus;
  phase?: string;
  progress?: number | null;
  targetType?: string;
  targetId?: string | number;
  nodeId?: string;
  businessType?: string;
  businessId?: number;
  handler?: string;
  payload?: unknown;
  result?: Record<string, unknown>;
  priority?: number;
  availableAt?: number;
  maxAttempts?: number;
  providerTaskId?: string;
  providerSubmittedAt?: number;
  idempotencyKey?: string;
  model?: string;
  describe?: string;
  relatedObjects?: unknown;
}

export interface UnifiedTaskEnvelope {
  taskId: string;
  legacyTaskId: number;
  status: string;
  targetType: string;
  targetId: string | number | null;
}

const taskLog = createLogger("task");

function compactJson(value: unknown, maxBytes = 64 * 1024): string | null {
  if (value == null) return null;
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > maxBytes) throw new Error(`任务数据超过 ${maxBytes} 字节限制`);
  if (/data:[^;]+;base64,/i.test(json)) throw new Error("统一任务数据禁止保存 Base64 媒体");
  return json;
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function taskEventRow(task: any, resultJson?: string | null, reason?: string) {
  return {
    taskId: task.taskId,
    legacyTaskId: task.id,
    version: Number(task.version || 1),
    taskType: task.taskType || "prompt",
    projectId: task.projectId,
    scriptId: task.scriptId ?? task.episode ?? null,
    targetType: task.targetType || null,
    targetId: task.targetId == null ? null : String(task.targetId),
    nodeId: task.nodeId || null,
    businessId: task.businessId ?? null,
    status: task.status || toTaskStatus(task.state) || "pending",
    phase: task.phase || null,
    progress: task.progress ?? null,
    resultJson: resultJson ?? task.resultJson ?? null,
    reason: reason ?? task.reason ?? null,
    createdAt: Date.now(),
  };
}

export async function createUnifiedTask(input: CreateUnifiedTaskInput, database: any = db) {
  const now = Date.now();
  const taskId = input.taskId || randomUUID();
  const status = input.status || (input.handler ? "queued" : "processing");
  const payloadJson = compactJson(input.payload);
  const resultJson = compactJson(input.result);
  const relatedObjects =
    input.relatedObjects == null
      ? null
      : typeof input.relatedObjects === "string"
        ? input.relatedObjects
        : compactJson(input.relatedObjects, 16 * 1024);

  return database.transaction(async (trx: any) => {
    const [rawId] = await trx("o_tasks").insert({
      taskId,
      projectId: input.projectId,
      scriptId: input.scriptId ?? null,
      episode: input.scriptId ?? null,
      taskClass: input.taskClass,
      taskType: input.taskType,
      status,
      phase: input.phase || status,
      progress: input.progress === undefined ? 0 : input.progress,
      targetType: input.targetType || null,
      targetId: input.targetId == null ? null : String(input.targetId),
      nodeId: input.nodeId || null,
      businessType: input.businessType || null,
      businessId: input.businessId ?? null,
      handler: input.handler || null,
      payloadJson,
      resultJson,
      priority: input.priority ?? 0,
      availableAt: input.availableAt ?? now,
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 1,
      version: 1,
      providerTaskId: input.providerTaskId || null,
      providerSubmittedAt: input.providerSubmittedAt ?? null,
      idempotencyKey: input.idempotencyKey || null,
      model: input.model || null,
      describe: input.describe || "",
      relatedObjects,
      state: toLegacyTaskState(status),
      startTime: now,
      createdAt: now,
      updateTime: now,
      finishTime: ["completed", "failed", "cancelled"].includes(status) ? now : null,
      reason: null,
    });
    const id = Number(rawId);
    const task = await trx("o_tasks").where("id", id).first();
    const [eventId] = await trx("o_taskEvent").insert(taskEventRow(task, resultJson));
    taskLog.info("Unified task created", {
      event: "task.created",
      taskId,
      businessId: id,
      projectId: input.projectId,
      scriptId: input.scriptId,
      taskType: input.taskType,
      status,
      handler: input.handler,
    });
    return { id, legacyTaskId: id, taskId, eventId: Number(eventId), status };
  });
}

export function formatUnifiedTaskEnvelope(
  task: { taskId: string; legacyTaskId?: number; id?: number; status: string },
  targetType: string,
  targetId?: string | number | null,
): UnifiedTaskEnvelope {
  const legacyTaskId = Number(task.legacyTaskId ?? task.id);
  if (!task.taskId) throw new Error("Unified task envelope requires taskId");
  if (!Number.isFinite(legacyTaskId)) throw new Error("Unified task envelope requires legacyTaskId");
  return {
    taskId: task.taskId,
    legacyTaskId,
    status: task.status,
    targetType,
    targetId: targetId ?? null,
  };
}

export async function adoptLegacyTask(
  legacyTaskId: number,
  input: Omit<CreateUnifiedTaskInput, "taskId" | "projectId" | "taskClass"> & {
    projectId?: number;
    taskClass?: string;
  },
  database: any = db,
) {
  const current = await database("o_tasks").where("id", legacyTaskId).first();
  if (!current) throw new Error(`任务中心记录不存在: ${legacyTaskId}`);
  if (current.taskId) return { id: legacyTaskId, legacyTaskId, taskId: current.taskId, status: current.status };
  const now = Date.now();
  const taskId = randomUUID();
  const status = input.status || toTaskStatus(current.state) || (input.handler ? "queued" : "processing");
  const update = {
    taskId,
    projectId: input.projectId ?? current.projectId,
    scriptId: input.scriptId ?? current.episode ?? null,
    taskClass: input.taskClass ?? current.taskClass,
    taskType: input.taskType,
    status,
    phase: input.phase || status,
    progress: input.progress === undefined ? 0 : input.progress,
    targetType: input.targetType || null,
    targetId: input.targetId == null ? null : String(input.targetId),
    nodeId: input.nodeId || null,
    businessType: input.businessType || null,
    businessId: input.businessId ?? null,
    handler: input.handler || null,
    payloadJson: compactJson(input.payload),
    resultJson: compactJson(input.result),
    priority: input.priority ?? 0,
    availableAt: input.availableAt ?? now,
    attempt: 0,
    maxAttempts: input.maxAttempts ?? 1,
    version: 1,
    providerTaskId: input.providerTaskId || null,
    providerSubmittedAt: input.providerSubmittedAt ?? null,
    idempotencyKey: input.idempotencyKey || null,
    createdAt: current.startTime || now,
    updateTime: now,
    finishTime: ["completed", "failed", "cancelled"].includes(status) ? now : null,
    state: toLegacyTaskState(status),
  };
  await database.transaction(async (trx: any) => {
    await trx("o_tasks").where("id", legacyTaskId).whereNull("taskId").update(update);
    const task = await trx("o_tasks").where("id", legacyTaskId).first();
    if (task?.taskId === taskId) await trx("o_taskEvent").insert(taskEventRow(task));
  });
  const saved = await database("o_tasks").where("id", legacyTaskId).first();
  taskLog.info("Legacy task adopted", {
    event: "task.adopted",
    taskId: saved.taskId,
    businessId: legacyTaskId,
    projectId: saved.projectId,
    scriptId: saved.scriptId,
    taskType: saved.taskType,
    status: saved.status,
  });
  return { id: legacyTaskId, legacyTaskId, taskId: saved.taskId, status: saved.status };
}

export interface UpdateUnifiedTaskInput {
  status?: TaskStatus;
  phase?: string;
  progress?: number | null;
  payload?: unknown;
  result?: Record<string, unknown>;
  reason?: string;
  providerTaskId?: string | null;
  providerSubmittedAt?: number | null;
  availableAt?: number | null;
  leaseExpiresAt?: number | null;
  clearLease?: boolean;
  expectedVersion?: number;
  expectedStatus?: TaskStatus | TaskStatus[];
  expectedProviderTaskId?: string | null;
}

export async function updateUnifiedTask(taskIdOrLegacyId: string | number, patch: UpdateUnifiedTaskInput, database: any = db) {
  const now = Date.now();
  return database.transaction(async (trx: any) => {
    const query = trx("o_tasks");
    const current =
      typeof taskIdOrLegacyId === "number"
        ? await query.where("id", taskIdOrLegacyId).first()
        : await query.where("taskId", taskIdOrLegacyId).first();
    if (!current) return null;
    const terminal = patch.status && ["completed", "failed", "cancelled"].includes(patch.status);
    if (patch.expectedVersion !== undefined && Number(current.version || 0) !== patch.expectedVersion) return null;
    if (patch.expectedStatus !== undefined) {
      const statuses = Array.isArray(patch.expectedStatus) ? patch.expectedStatus : [patch.expectedStatus];
      if (!statuses.includes(current.status)) return null;
    }
    if (patch.expectedProviderTaskId !== undefined && (current.providerTaskId || null) !== patch.expectedProviderTaskId) return null;
    const payloadJson = patch.payload === undefined ? current.payloadJson : compactJson(patch.payload);
    const resultJson = patch.result === undefined ? current.resultJson : compactJson(patch.result);
    const nextVersion = Number(current.version || 0) + 1;
    const update: Record<string, unknown> = {
      version: nextVersion,
      updateTime: now,
      resultJson,
      payloadJson,
    };
    if (patch.status) {
      update.status = patch.status;
      update.state = toLegacyTaskState(patch.status);
    }
    if (patch.phase !== undefined) update.phase = patch.phase;
    if (patch.progress !== undefined) update.progress = patch.progress == null ? null : Math.max(0, Math.min(100, patch.progress));
    if (patch.reason !== undefined) update.reason = patch.reason.slice(0, 4096);
    if (patch.providerTaskId !== undefined) update.providerTaskId = patch.providerTaskId;
    if (patch.providerSubmittedAt !== undefined) update.providerSubmittedAt = patch.providerSubmittedAt;
    if (patch.availableAt !== undefined) update.availableAt = patch.availableAt;
    if (patch.leaseExpiresAt !== undefined) update.leaseExpiresAt = patch.leaseExpiresAt;
    if (terminal) update.finishTime = now;
    if (patch.clearLease || terminal) {
      update.leaseOwner = null;
      update.leaseExpiresAt = null;
    }
    const updated = await trx("o_tasks")
      .where("id", current.id)
      .where("version", current.version)
      .update(update);
    if (!updated) return null;
    const task = { ...current, ...update };
    const [eventId] = await trx("o_taskEvent").insert(taskEventRow(task, resultJson, patch.reason));
    taskLog.info("Unified task updated", {
      event: "task.updated",
      taskId: task.taskId,
      businessId: task.id,
      projectId: task.projectId,
      scriptId: task.scriptId,
      taskType: task.taskType,
      status: task.status,
      phase: task.phase,
      progress: task.progress,
      reason: patch.reason,
    });
    return { eventId: Number(eventId), taskId: task.taskId, version: nextVersion, status: task.status };
  });
}

export function whereRunnableUnifiedTask(query: any, now = Date.now()) {
  return query
    .where((builder: any) => {
      builder.where("status", "queued").orWhere((video: any) => {
        video
          .where("handler", "video-generation")
          .where("status", "processing")
          .whereIn("phase", [
            "confirming",
            "processing",
            "remote_reconcile",
            "remote_unavailable_reconcile",
            "resume-provider-query",
          ]);
      });
    })
    .whereNotNull("handler")
    .where((builder: any) => builder.whereNull("availableAt").orWhere("availableAt", "<=", now))
    .where((builder: any) => builder.whereNull("leaseExpiresAt").orWhere("leaseExpiresAt", "<", now));
}

export async function claimUnifiedTask(workerId: string, leaseMs = 120_000, database: any = db, candidateId?: number) {
  const now = Date.now();
  const candidateQuery = whereRunnableUnifiedTask(database("o_tasks"), now);
  if (candidateId != null) candidateQuery.where("id", candidateId);
  const candidate = await candidateQuery.orderBy("priority", "desc").orderBy("createdAt", "asc").first();
  if (!candidate) return null;
  const claimed = await database("o_tasks")
    .where({ id: candidate.id, status: candidate.status, version: candidate.version })
    .where((builder: any) => builder.whereNull("leaseExpiresAt").orWhere("leaseExpiresAt", "<", now))
    .update({
      status: "processing",
      phase: candidate.status === "queued" ? "claimed" : candidate.phase,
      state: toLegacyTaskState("processing"),
      leaseOwner: workerId,
      leaseExpiresAt: now + leaseMs,
      attempt: Number(candidate.attempt || 0) + 1,
      version: Number(candidate.version || 0) + 1,
      updateTime: now,
    });
  if (!claimed) return null;
  const task = await database("o_tasks").where("id", candidate.id).first();
  await database("o_taskEvent").insert(taskEventRow(task));
  taskLog.info("Unified task claimed", {
    event: "task.claimed",
    taskId: task.taskId,
    businessId: task.id,
    projectId: task.projectId,
    scriptId: task.scriptId,
    taskType: task.taskType,
    workerId,
  });
  return task;
}

export async function renewUnifiedTaskLease(taskIdOrLegacyId: string | number, leaseMs = 120_000, database: any = db) {
  const now = Date.now();
  const query = database("o_tasks");
  const current =
    typeof taskIdOrLegacyId === "number"
      ? await query.where("id", taskIdOrLegacyId).first()
      : await query.where("taskId", taskIdOrLegacyId).first();
  if (!current || !["pending", "queued", "submitting", "processing"].includes(String(current.status || ""))) return null;
  await database("o_tasks").where("id", current.id).update({
    leaseExpiresAt: now + leaseMs,
    updateTime: now,
  });
  return {
    taskId: current.taskId,
    legacyTaskId: Number(current.id),
    leaseExpiresAt: now + leaseMs,
  };
}

export async function cancelUnifiedTask(taskId: string, database: any = db) {
  const task = await database("o_tasks").where({ taskId }).first();
  if (!task) return { ok: false as const, statusCode: 404, message: "任务不存在" };
  if (!["pending", "queued"].includes(task.status)) {
    return { ok: false as const, statusCode: 409, message: "任务可能已经执行，无法安全取消" };
  }
  const changed = await database("o_tasks")
    .where({ id: task.id })
    .whereIn("status", ["pending", "queued"])
    .update({ status: "cancelled" });
  if (!changed) return { ok: false as const, statusCode: 409, message: "任务状态已发生变化" };
  await updateUnifiedTask(task.id, { status: "cancelled", phase: "cancelled", reason: "用户取消", clearLease: true }, database);
  if (task.handler === "script-asset-extract") {
    try {
      const payload = parseJsonObject(task.payloadJson);
      const scriptIds = Array.isArray(payload?.scriptIds)
        ? payload.scriptIds.map(Number).filter(Number.isFinite)
        : [];
      if (scriptIds.length) {
        await database("o_script").where("projectId", task.projectId).whereIn("id", scriptIds).update({
          extractState: -1,
          errorReason: "用户取消",
        });
      }
    } catch {
      // Best-effort compatibility update only; task cancellation has already succeeded.
    }
  }
  if (task.handler === "novel-event") {
    try {
      const payload = parseJsonObject(task.payloadJson);
      const novelIds = Array.isArray(payload?.novelIds)
        ? payload.novelIds.map(Number).filter(Number.isFinite)
        : payload?.novelId == null
          ? []
          : [Number(payload.novelId)].filter(Number.isFinite);
      if (novelIds.length) {
        await database("o_novel")
          .where("projectId", task.projectId)
          .whereIn("id", novelIds)
          .where("eventState", 0)
          .update({ eventState: -1, errorReason: "用户取消" });
      }
    } catch {
      // Best-effort compatibility update only; task cancellation has already succeeded.
    }
  }
  taskLog.info("Unified task cancelled", {
    event: "task.cancelled",
    taskId,
    businessId: task.id,
    projectId: task.projectId,
    scriptId: task.scriptId,
    taskType: task.taskType,
  });
  return { ok: true as const, taskId, legacyTaskId: task.id, status: "cancelled" as const };
}

export function formatTaskEvent(row: any): TaskEvent {
  return {
    eventId: Number(row.id),
    taskId: row.taskId,
    legacyTaskId: row.legacyTaskId == null ? undefined : Number(row.legacyTaskId),
    version: Number(row.version || 1),
    taskType: row.taskType,
    projectId: Number(row.projectId),
    scriptId: row.scriptId == null ? undefined : Number(row.scriptId),
    targetType: row.targetType || undefined,
    targetId: row.targetId || undefined,
    nodeId: row.nodeId || undefined,
    businessId: row.businessId == null ? undefined : Number(row.businessId),
    status: row.status,
    phase: row.phase || undefined,
    progress: row.progress == null ? null : Number(row.progress),
    result: normalizeTaskResultSync(parseJsonObject(row.resultJson)),
    reason: row.reason || undefined,
    updatedAt: Number(row.createdAt),
  };
}

export async function getTaskSnapshot(
  input: {
    projectId: number;
    scriptId?: number;
    taskIds?: string[];
    targetTypes?: string[];
    includeTerminal?: boolean;
    limit?: number;
  },
  database: any = db,
) {
  const query = database("o_tasks").where("projectId", input.projectId);
  if (input.scriptId != null) query.where((builder: any) => builder.where("scriptId", input.scriptId).orWhere("episode", input.scriptId));
  if (input.taskIds?.length) query.whereIn("taskId", input.taskIds);
  else if (!input.includeTerminal) query.whereIn("status", ["pending", "queued", "submitting", "processing"]);
  if (input.targetTypes?.length) query.whereIn("targetType", input.targetTypes);
  const limit = Math.min(Math.max(Number(input.limit || 500), 1), 500);
  const rows = await query.orderBy("updateTime", "desc").limit(limit);
  return rows.map((row: any) =>
    formatTaskEvent({
      id: 0,
      taskId: row.taskId,
      legacyTaskId: row.id,
      version: row.version,
      taskType: row.taskType || "prompt",
      projectId: row.projectId,
      scriptId: row.scriptId ?? row.episode,
      targetType: row.targetType,
      targetId: row.targetId,
      nodeId: row.nodeId,
      businessId: row.businessId,
      status: row.status || toTaskStatus(row.state) || "pending",
      phase: row.phase,
      progress: row.progress,
      resultJson: row.resultJson,
      reason: row.reason,
      createdAt: row.updateTime || row.startTime,
    }),
  );
}

export async function pruneTaskEvents(database: any = db) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  await database("o_taskEvent").where("createdAt", "<", cutoff).delete();
  await database("o_tasks")
    .whereIn("status", ["completed", "failed", "cancelled"])
    .where("finishTime", "<", cutoff)
    .update({ payloadJson: null, resultJson: null });
}
