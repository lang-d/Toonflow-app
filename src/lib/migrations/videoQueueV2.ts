import fs from "node:fs/promises";
import path from "node:path";
import knexFactory, { type Knex } from "knex";
import getPath from "@/utils/getPath";

const MIGRATION_KEY = "migration:video-queue-v2";
const RECOVERY_KEY = "migration:video-queue-v2-recover-interrupted-queued";
const RAW_OUTPUT_LIMIT = 32 * 1024;
const ACTIVE_STATUSES = ["queued", "submitting", "confirming", "processing"];

interface MigrationOptions {
  createBackup?: boolean;
  vacuum?: boolean;
}

function truncateDiagnostic(value: unknown) {
  const text = String(value || "");
  return text.length > RAW_OUTPUT_LIMIT ? text.slice(-RAW_OUTPUT_LIMIT) : text;
}

function statusOf(task: any) {
  if (task.status) return task.status;
  return (
    {
      排队中: "queued",
      提交中: "submitting",
      生成中: "processing",
      已完成: "completed",
      生成失败: "failed",
    }[task.state as string] || "failed"
  );
}

function extensionFromDataUrl(dataUrl: string, type: string) {
  const mime = dataUrl.match(/^data:([^;]+);base64,/)?.[1]?.toLowerCase();
  return (
    {
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "image/bmp": ".bmp",
      "image/tiff": ".tiff",
      "video/mp4": ".mp4",
      "video/quicktime": ".mov",
      "video/webm": ".webm",
      "video/x-matroska": ".mkv",
      "video/x-msvideo": ".avi",
      "audio/wav": ".wav",
      "audio/x-wav": ".wav",
      "audio/mpeg": ".mp3",
      "audio/mp4": ".m4a",
      "audio/aac": ".aac",
      "audio/flac": ".flac",
      "audio/ogg": ".ogg",
      "audio/aiff": ".aiff",
    }[mime || ""] || (type === "video" ? ".mp4" : type === "audio" ? ".bin" : ".png")
  );
}

function parseRequest(value: unknown) {
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return {};
  }
}

async function createSqliteBackup(knex: Knex) {
  const filename = (knex.client.config.connection as any)?.filename;
  if (!filename || filename === ":memory:") return "";
  const backupDir = path.join(path.dirname(filename), "backups");
  await fs.mkdir(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `db2-before-video-queue-v2-${timestamp}.sqlite`);
  const connection: any = await knex.client.acquireConnection();
  try {
    await connection.backup(backupPath);
  } finally {
    await knex.client.releaseConnection(connection);
  }
  return backupPath;
}

async function migrateQueuedReferences(task: any, request: any) {
  const oldReferences = Array.isArray(request?.input?.referenceList) ? request.input.referenceList : [];
  if (!oldReferences.length) return null;
  const taskDir = getPath(["temp", "video-queue-legacy", String(task.id)]);
  await fs.mkdir(taskDir, { recursive: true });
  const legacyReferences: Array<{ type: "image" | "video" | "audio"; filePath: string }> = [];
  for (let index = 0; index < oldReferences.length; index += 1) {
    const reference = oldReferences[index];
    if (!reference?.base64 || typeof reference.base64 !== "string") continue;
    const type = ["image", "video", "audio"].includes(reference.type) ? reference.type : "image";
    const filePath = path.join(taskDir, `${index}${extensionFromDataUrl(reference.base64, type)}`);
    const buffer = Buffer.from(reference.base64.replace(/^data:[^;]+;base64,/, ""), "base64");
    await fs.writeFile(filePath, buffer);
    legacyReferences.push({ type, filePath });
  }
  return {
    version: 2,
    videoPath: request.videoPath,
    input: {
      prompt: request.input?.prompt || "",
      mode: request.input?.mode,
      duration: request.input?.duration,
      aspectRatio: request.input?.aspectRatio,
      resolution: request.input?.resolution,
      audio: request.input?.audio,
    },
    references: [],
    legacyReferences,
    relatedObjects: request.relatedObjects || {},
  };
}

function compactRequest(request: any) {
  return {
    version: 2,
    videoPath: request.videoPath,
    input: {
      prompt: request.input?.prompt || "",
      mode: request.input?.mode,
      duration: request.input?.duration,
      aspectRatio: request.input?.aspectRatio,
      resolution: request.input?.resolution,
      audio: request.input?.audio,
    },
    references: Array.isArray(request.references) ? request.references : [],
    relatedObjects: request.relatedObjects || {},
  };
}

async function markFailed(knex: Knex | Knex.Transaction, task: any, reason: string) {
  const now = Date.now();
  await knex("o_videoGenerationTask").where("id", task.id).update({
    phase: "failed",
    status: "failed",
    state: "生成失败",
    errorReason: reason,
    rawOutput: truncateDiagnostic(task.rawOutput),
    updateTime: now,
    finishTime: now,
  });
  if (task.videoId != null) {
    await knex("o_video").where("id", task.videoId).update({ state: "生成失败", errorReason: reason });
  }
  if (task.taskCenterId != null) {
    await knex("o_tasks").where("id", task.taskCenterId).update({ state: "生成失败", reason });
  }
}

export async function migrateVideoQueueV2(knex: Knex, options: MigrationOptions = {}) {
  const marker = await knex("o_setting").where("key", MIGRATION_KEY).first();
  if (marker) return { skipped: true, backupPath: "", migratedQueued: 0, compacted: 0, failedFalseProcessing: 0 };

  const tasks = await knex("o_videoGenerationTask").orderBy("id", "asc");
  const hasLargePayload = tasks.some((task: any) => /;base64,/.test(String(task.requestJson || "")));
  const backupPath =
    tasks.length && options.createBackup !== false ? await createSqliteBackup(knex) : "";
  let migratedQueued = 0;
  let compacted = 0;
  let failedFalseProcessing = 0;

  await knex.transaction(async (trx) => {
    for (const task of tasks) {
      const status = statusOf(task);
      const request = parseRequest(task.requestJson);
      if (status === "queued" && /;base64,/.test(String(task.requestJson || ""))) {
        const migrated = await migrateQueuedReferences(task, request);
        if (migrated) {
          await trx("o_videoGenerationTask").where("id", task.id).update({
            payloadVersion: 2,
            phase: "queued",
            status: "queued",
            state: "排队中",
            requestJson: JSON.stringify(migrated),
            rawOutput: truncateDiagnostic(task.rawOutput),
            updateTime: Date.now(),
          });
          migratedQueued += 1;
          continue;
        }
      }

      if (["completed", "failed"].includes(status)) {
        await trx("o_videoGenerationTask").where("id", task.id).update({
          payloadVersion: 2,
          requestJson: JSON.stringify(compactRequest(request)),
          rawOutput: truncateDiagnostic(task.rawOutput),
        });
        compacted += 1;
        continue;
      }

      if (["submitting", "processing"].includes(status)) {
        const confirmed = Boolean(task.officialTaskId || task.historyRecordId || task.remoteConfirmedAt);
        if (!confirmed) {
          await markFailed(trx, task, "旧任务没有即梦官方任务凭据，已释放队列槽位，避免重复提交或重复扣费。");
          failedFalseProcessing += 1;
        }
      }
    }
    await trx("o_setting").insert({
      key: MIGRATION_KEY,
      value: JSON.stringify({
        completedAt: Date.now(),
        backupPath,
        migratedQueued,
        compacted,
        failedFalseProcessing,
      }),
    });
  });

  const integrity = await knex.raw("PRAGMA integrity_check");
  const integrityValue = JSON.stringify(integrity).toLowerCase();
  if (!integrityValue.includes("ok")) throw new Error(`视频队列迁移后数据库完整性检查失败: ${JSON.stringify(integrity)}`);

  if (hasLargePayload && options.vacuum !== false) {
    console.info("[video-queue-v2] 正在压缩 SQLite 数据库，首次启动可能需要几分钟...");
    await knex.raw("VACUUM");
  }
  return { skipped: false, backupPath, migratedQueued, compacted, failedFalseProcessing };
}

export async function recoverInterruptedQueuedTasksFromBackup(knex: Knex) {
  if (await knex("o_setting").where("key", RECOVERY_KEY).first()) return { skipped: true, recovered: 0 };
  const migrationMarker = await knex("o_setting").where("key", MIGRATION_KEY).first();
  if (!migrationMarker?.value) return { skipped: true, recovered: 0 };

  let backupPath = "";
  try {
    backupPath = JSON.parse(migrationMarker.value).backupPath || "";
  } catch {}
  if (!backupPath) return { skipped: true, recovered: 0 };

  const recoveryCopy = getPath(["temp", `video-queue-recovery-${Date.now()}.sqlite`]);
  let sourceDb: Knex | null = null;
  try {
    await fs.mkdir(path.dirname(recoveryCopy), { recursive: true });
    await fs.copyFile(backupPath, recoveryCopy);
    sourceDb = knexFactory({
      client: "better-sqlite3",
      connection: { filename: recoveryCopy },
      useNullAsDefault: true,
    });
    const candidates = await sourceDb("o_videoGenerationTask")
      .where({ status: "failed", errorReason: "软件重启导致任务中断" })
      .whereNull("submitId")
      .orderBy("updateTime", "desc");
    const latestInterruptedAt = Number(candidates[0]?.updateTime || 0);
    const recoverable = candidates.filter(
      (task: any) =>
        Number(task.updateTime || 0) === latestInterruptedAt &&
        /;base64,/.test(String(task.requestJson || "")),
    );

    await knex.transaction(async (trx) => {
      for (const task of recoverable) {
        const migrated = await migrateQueuedReferences(task, parseRequest(task.requestJson));
        if (!migrated) continue;
        await trx("o_videoGenerationTask").where("id", task.id).update({
          payloadVersion: 2,
          phase: "queued",
          status: "queued",
          state: "排队中",
          submitId: null,
          officialTaskId: null,
          historyRecordId: null,
          providerAccountId: null,
          remoteConfirmedAt: null,
          errorReason: "",
          rawOutput: "",
          requestJson: JSON.stringify(migrated),
          nextPollTime: null,
          pollCount: 0,
          updateTime: Date.now(),
          finishTime: null,
        });
        if (task.videoId != null) {
          await trx("o_video").where("id", task.videoId).update({ state: "生成中", errorReason: "" });
        }
        if (task.taskCenterId != null) {
          await trx("o_tasks").where("id", task.taskCenterId).update({ state: "进行中", reason: "" });
        }
      }
      await trx("o_setting").insert({
        key: RECOVERY_KEY,
        value: JSON.stringify({
          completedAt: Date.now(),
          backupPath,
          latestInterruptedAt,
          recovered: recoverable.length,
        }),
      });
    });
    return { skipped: false, recovered: recoverable.length };
  } catch (error) {
    console.warn("[video-queue-v2] 无法从迁移备份恢复旧排队任务:", error);
    return { skipped: false, recovered: 0, error: String(error) };
  } finally {
    if (sourceDb) await sourceDb.destroy();
    await fs.rm(recoveryCopy, { force: true }).catch(() => {});
  }
}

export async function recoverVideoQueueAfterRestart(knex: Knex) {
  const tasks = await knex("o_videoGenerationTask").whereIn("status", ACTIVE_STATUSES);
  const summary = {
    scanned: tasks.length,
    queued: 0,
    confirming: 0,
    processing: 0,
    failed: 0,
  };
  for (const task of tasks) {
    if (task.status === "queued") {
      await knex("o_videoGenerationTask").where("id", task.id).update({
        phase: task.phase === "capacity_wait" ? "capacity_wait" : "queued",
        state: "排队中",
        nextSubmitTime: task.nextSubmitTime || Date.now(),
        updateTime: Date.now(),
      });
      if (task.videoId != null) {
        await knex("o_video").where("id", task.videoId).update({ state: "生成中", errorReason: "" });
      }
      summary.queued += 1;
      continue;
    }

    if (task.status === "confirming" && task.submitId) {
      await knex("o_videoGenerationTask").where("id", task.id).update({
        phase: "confirming",
        state: "提交中",
        nextPollTime: Date.now(),
        updateTime: Date.now(),
      });
      summary.confirming += 1;
      continue;
    }

    const confirmed = Boolean(task.officialTaskId || task.historyRecordId || task.remoteConfirmedAt);
    if (confirmed) {
      await knex("o_videoGenerationTask").where("id", task.id).update({
        phase: "processing",
        status: "processing",
        state: "生成中",
        nextPollTime: Date.now(),
        updateTime: Date.now(),
      });
      summary.processing += 1;
      continue;
    }
    await markFailed(knex, task, "软件重启后无法确认供应商任务已创建，未自动重提以避免重复扣费。");
    summary.failed += 1;
    console.warn(
      `[video-queue-recovery] ${JSON.stringify({
        event: "task.failed_unconfirmed",
        queueTaskId: task.id,
        videoId: task.videoId,
        model: task.model,
        providerModelKey: task.providerModelKey,
        previousStatus: task.status,
      })}`,
    );
  }
  console.info(`[video-queue-recovery] ${JSON.stringify({ event: "restart.completed", ...summary })}`);
}
