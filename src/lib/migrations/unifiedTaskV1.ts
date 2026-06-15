import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import getPath from "@/utils/getPath";
import { toTaskStatus, type TaskStatus } from "@/lib/taskStatus";

const MIGRATION_KEY = "migration:unified-task-v1";
const TERMINAL = new Set<TaskStatus>(["completed", "failed", "cancelled"]);

function inferTaskType(taskClass: unknown) {
  const value = String(taskClass || "");
  if (/视频/.test(value)) return "video";
  if (/分镜/.test(value)) return "storyboard";
  if (/角色|场景|道具|资产/.test(value)) return "asset";
  if (/图片|生图/.test(value)) return "image";
  if (/音频|配音/.test(value)) return "audio";
  return "prompt";
}

async function createBackup(knex: Knex) {
  const backupDir = getPath("backups");
  await fs.mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `db2-before-unified-task-v1-${Date.now()}.sqlite`);
  await knex.raw(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  return backupPath;
}

export async function migrateUnifiedTaskV1(knex: Knex) {
  const existing = await knex("o_setting").where("key", MIGRATION_KEY).first();
  if (existing) return { skipped: true };

  const backupPath = await createBackup(knex);
  const now = Date.now();
  const tasks = await knex("o_tasks").orderBy("id", "asc");
  const videoRows = await knex("o_videoGenerationTask").whereNotNull("taskCenterId");
  const imageRows = await knex("o_editImageTask").whereNotNull("taskCenterId");
  const videoByTask = new Map(videoRows.map((row: any) => [Number(row.taskCenterId), row]));
  const imageByTask = new Map(imageRows.map((row: any) => [Number(row.taskCenterId), row]));
  let interrupted = 0;

  await knex.transaction(async (trx) => {
    for (const task of tasks) {
      const linked = videoByTask.get(Number(task.id)) || imageByTask.get(Number(task.id));
      let status = (linked?.status || toTaskStatus(linked?.state) || task.status || toTaskStatus(task.state) || "completed") as TaskStatus;
      let reason = task.reason || linked?.reason || linked?.errorReason || "";
      if (!linked && ["pending", "queued", "submitting", "processing"].includes(status)) {
        status = "failed";
        reason = "软件升级时发现任务缺少可恢复的执行记录，已安全终止";
        interrupted += 1;
      }
      const taskId = task.taskId || randomUUID();
      const taskType = task.taskType || inferTaskType(task.taskClass);
      const version = Math.max(1, Number(task.version || 1));
      const update = {
        taskId,
        taskType,
        status,
        phase: task.phase || status,
        progress: status === "completed" ? 100 : Number(task.progress || 0),
        scriptId: task.scriptId ?? task.episode ?? linked?.scriptId ?? null,
        businessType: task.businessType || (linked ? (videoByTask.has(Number(task.id)) ? "video-generation" : "image-flow") : null),
        businessId: task.businessId ?? linked?.id ?? null,
        version,
        priority: Number(task.priority || 0),
        attempt: Number(task.attempt || 0),
        maxAttempts: Math.max(1, Number(task.maxAttempts || 1)),
        availableAt: task.availableAt || task.startTime || now,
        createdAt: task.createdAt || task.startTime || now,
        updateTime: task.updateTime || linked?.updateTime || task.startTime || now,
        finishTime: TERMINAL.has(status) ? task.finishTime || linked?.finishTime || now : null,
        state:
          status === "completed"
            ? "已完成"
            : status === "failed"
              ? "生成失败"
              : status === "cancelled"
                ? "已取消"
                : "进行中",
        reason,
      };
      await trx("o_tasks").where("id", task.id).update(update);
      await trx("o_taskEvent").insert({
        taskId,
        legacyTaskId: task.id,
        version,
        taskType,
        projectId: task.projectId,
        scriptId: update.scriptId,
        targetType: task.targetType || null,
        targetId: task.targetId || null,
        nodeId: task.nodeId || null,
        status,
        phase: update.phase,
        progress: update.progress,
        resultJson: task.resultJson || null,
        reason: reason || null,
        createdAt: update.updateTime,
      });
    }
    await trx("o_setting").insert({
      key: MIGRATION_KEY,
      value: JSON.stringify({ completedAt: now, backupPath, scanned: tasks.length, interrupted }),
    });
  });

  console.info(`[unified-task-v1] ${JSON.stringify({ scanned: tasks.length, interrupted, backupPath })}`);
  return { skipped: false, scanned: tasks.length, interrupted, backupPath };
}

export async function recoverInterruptedEphemeralTasks(knex: Knex) {
  const rows = await knex("o_tasks")
    .whereIn("status", ["submitting", "processing"])
    .whereNull("handler")
    .whereNull("providerTaskId")
    .where((builder) => builder.whereNull("businessType").orWhereNot("businessType", "video-generation"));
  if (!rows.length) return 0;
  const now = Date.now();
  await knex.transaction(async (trx) => {
    for (const task of rows) {
      const version = Number(task.version || 0) + 1;
      const reason = "软件重启导致任务中断，且没有可安全恢复的供应商任务凭据";
      await trx("o_tasks").where("id", task.id).update({
        status: "failed",
        phase: "interrupted",
        state: "生成失败",
        reason,
        version,
        updateTime: now,
        finishTime: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      if (task.taskId) {
        await trx("o_taskEvent").insert({
          taskId: task.taskId,
          legacyTaskId: task.id,
          version,
          taskType: task.taskType || inferTaskType(task.taskClass),
          projectId: task.projectId,
          scriptId: task.scriptId ?? task.episode ?? null,
          targetType: task.targetType || null,
          targetId: task.targetId || null,
          nodeId: task.nodeId || null,
          status: "failed",
          phase: "interrupted",
          progress: Number(task.progress || 0),
          resultJson: task.resultJson || null,
          reason,
          createdAt: now,
        });
      }
    }
  });
  console.warn(`[unified-task] recovered ${rows.length} interrupted non-recoverable tasks`);
  return rows.length;
}
