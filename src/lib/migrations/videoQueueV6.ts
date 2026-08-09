import type { Knex } from "knex";

const MIGRATION_KEY = "migration:video-queue-v6-unified-worker";
const ACTIVE = new Set(["queued", "submitting", "confirming", "processing"]);

function normalizeUrl(value: unknown) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function videoProviderCapacityKey(row: any) {
  if (row.vendorId === "zealman" && row.providerAccountId) return `zealman:${normalizeUrl(row.providerAccountId)}`;
  const modelKey = String(row.providerModelKey || row.model || "unknown");
  const vendorId = String(row.vendorId || "legacy");
  return modelKey.startsWith(`${vendorId}:`) ? modelKey : `${vendorId}:${modelKey}`;
}

export async function migrateVideoQueueV6(knex: Knex) {
  if (await knex("o_setting").where("key", MIGRATION_KEY).first()) {
    return { skipped: true, migratedTasks: 0 };
  }
  const now = Date.now();
  const rows = await knex("o_videoGenerationTask").whereNotNull("taskCenterId").orderBy("id", "asc");
  let migratedTasks = 0;
  await knex.transaction(async (trx) => {
    for (const row of rows) {
      const task = await trx("o_tasks").where("id", row.taskCenterId).first();
      if (!task) continue;
      const active = ACTIVE.has(String(row.status || ""));
      const submitted = Boolean(row.submitId);
      const updates: Record<string, unknown> = {
        providerCapacityKey: videoProviderCapacityKey(row),
        updateTime: now,
      };
      await trx("o_videoGenerationTask").where("id", row.id).update(updates);
      if (!active) {
        migratedTasks += 1;
        continue;
      }
      const status = submitted ? "processing" : "queued";
      const phase = submitted
        ? ["confirming", "processing", "remote_reconcile", "remote_unavailable_reconcile"].includes(String(row.phase || ""))
          ? row.phase
          : "resume-provider-query"
        : ["capacity_wait", "remote_unavailable"].includes(String(row.phase || ""))
          ? row.phase
          : "queued";
      const version = Number(task.version || 0) + 1;
      await trx("o_tasks").where("id", task.id).update({
        taskType: "video",
        businessType: "video-generation",
        businessId: row.videoId,
        handler: "video-generation",
        payloadJson: JSON.stringify({ queueTaskId: row.id }),
        status,
        phase,
        progress: row.vendorId === "zealman" ? null : task.progress,
        providerTaskId: row.submitId || null,
        providerSubmittedAt: row.providerSubmittedAt || (submitted ? row.startTime : null),
        availableAt: submitted ? row.nextPollTime || now : row.nextSubmitTime || now,
        leaseOwner: null,
        leaseExpiresAt: null,
        version,
        finishTime: null,
        updateTime: now,
      });
      await trx("o_taskEvent").insert({
        taskId: task.taskId,
        legacyTaskId: task.id,
        version,
        taskType: "video",
        projectId: task.projectId,
        scriptId: task.scriptId ?? task.episode ?? null,
        targetType: task.targetType || null,
        targetId: task.targetId == null ? null : String(task.targetId),
        nodeId: task.nodeId || null,
        businessId: row.videoId,
        status,
        phase,
        progress: row.vendorId === "zealman" ? null : task.progress,
        resultJson: task.resultJson || null,
        reason: null,
        createdAt: now,
      });
      migratedTasks += 1;
    }
    await trx("o_setting").insert({
      key: MIGRATION_KEY,
      value: JSON.stringify({ completedAt: now, migratedTasks }),
    });
  });
  console.info(`[video-queue-v6] ${JSON.stringify({ event: "migration.completed", migratedTasks })}`);
  return { skipped: false, migratedTasks };
}
