import type { Knex } from "knex";
import { normalizeQueueConfigForStorage } from "@/lib/videoQueueConfig";

const MIGRATION_KEY = "migration:video-queue-v4-provider-work-time";

function isLegacyTimeoutFailure(task: any) {
  if (task.vendorId !== "dreamina" || task.status !== "failed" || !task.submitId) return false;
  const diagnostics = `${task.errorReason || ""}\n${task.rawOutput || ""}`;
  return /任务(?:等待|工作)超过\s*\d+(?:\.\d+)?\s*小时|submit_id=.*(?:超时|timeout)/i.test(diagnostics);
}

export async function migrateVideoQueueV4(knex: Knex) {
  if (await knex("o_setting").where("key", MIGRATION_KEY).first()) {
    console.info("[video-queue-v4] migration already completed, skipping");
    return { skipped: true, restoredOfficialTasks: 0, migratedModels: 0 };
  }

  const now = Date.now();
  const [tasks, vendor] = await Promise.all([
    knex("o_videoGenerationTask").orderBy("id", "asc"),
    knex("o_vendorConfig").where("id", "dreamina").first("models"),
  ]);
  let restoredOfficialTasks = 0;
  let migratedModels = 0;

  await knex.transaction(async (trx) => {
    for (const task of tasks) {
      const providerSubmittedAt =
        task.providerSubmittedAt || task.confirmStartedAt || task.remoteConfirmedAt || (task.submitId ? task.startTime : null);
      const updates: Record<string, any> = {};
      if (task.submitId && !task.providerSubmittedAt && providerSubmittedAt) {
        updates.providerSubmittedAt = providerSubmittedAt;
      }
      if (isLegacyTimeoutFailure(task)) {
        Object.assign(updates, {
          providerSubmittedAt,
          phase: "confirming",
          status: "confirming",
          state: "提交中",
          errorReason: "",
          nextSubmitTime: null,
          nextPollTime: now,
          finishTime: null,
          updateTime: now,
        });
        restoredOfficialTasks += 1;
      }
      if (Object.keys(updates).length) {
        await trx("o_videoGenerationTask").where("id", task.id).update(updates);
      }
      if (updates.status === "confirming") {
        if (task.videoId != null) {
          await trx("o_video").where("id", task.videoId).update({ state: "生成中", errorReason: "" });
        }
        if (task.taskCenterId != null) {
          await trx("o_tasks").where("id", task.taskCenterId).update({ state: "进行中", reason: "" });
        }
      }
    }

    if (vendor?.models) {
      const models = JSON.parse(vendor.models || "[]");
      for (const model of models) {
        if (!model?.queueConfig) continue;
        const normalized = normalizeQueueConfigForStorage(model.queueConfig);
        if (JSON.stringify(normalized) !== JSON.stringify(model.queueConfig)) {
          model.queueConfig = normalized;
          migratedModels += 1;
        }
      }
      if (migratedModels) {
        await trx("o_vendorConfig").where("id", "dreamina").update({ models: JSON.stringify(models) });
      }
    }

    await trx("o_setting").insert({
      key: MIGRATION_KEY,
      value: JSON.stringify({
        completedAt: now,
        restoredOfficialTasks,
        migratedModels,
      }),
    });
  });

  console.info(
    `[video-queue-v4] ${JSON.stringify({
      event: "migration.completed",
      scanned: tasks.length,
      restoredOfficialTasks,
      migratedModels,
    })}`,
  );
  return { skipped: false, restoredOfficialTasks, migratedModels };
}
