import type { Knex } from "knex";

const MIGRATION_KEY = "migration:video-queue-v3-provider-slots";

function providerModelKey(model: unknown) {
  const value = String(model || "");
  const [vendorId, modelName = "default"] = value.split(/:(.+)/);
  if (vendorId !== "dreamina") return `${vendorId}:${modelName}`;
  const [, rawVersion = "default"] = modelName.split(/:(.+)/);
  const normalized = rawVersion.trim().toLowerCase().replace(/\s+/g, "");
  const version =
    {
      "seedance2.0-fast": "seedance2.0fast",
      "seedance2.0_fast": "seedance2.0fast",
      "seedance2.0-fast-vip": "seedance2.0fast_vip",
      "seedance2.0-fast_vip": "seedance2.0fast_vip",
      "seedance2.0_fast_vip": "seedance2.0fast_vip",
      "seedance2.0fastvip": "seedance2.0fast_vip",
      "seedance2.0-vip": "seedance2.0_vip",
      "seedance2.0vip": "seedance2.0_vip",
    }[normalized] || normalized;
  return `dreamina:${version}`;
}

function hasOfficialEvidence(task: any) {
  return Boolean(task.officialTaskId || task.historyRecordId || task.remoteConfirmedAt);
}

export async function migrateVideoQueueV3(knex: Knex) {
  if (await knex("o_setting").where("key", MIGRATION_KEY).first()) {
    console.info("[video-queue-v3] migration already completed, skipping");
    return { skipped: true, backfilled: 0, recoveredCapacity: 0, recoveredConfirmed: 0 };
  }

  const tasks = await knex("o_videoGenerationTask").orderBy("id", "asc");
  let backfilled = 0;
  let recoveredCapacity = 0;
  let recoveredConfirmed = 0;
  const now = Date.now();

  await knex.transaction(async (trx) => {
    for (const task of tasks) {
      const key = task.providerModelKey || providerModelKey(task.model);
      const updates: Record<string, any> = {};
      if (!task.providerModelKey) {
        updates.providerModelKey = key;
        backfilled += 1;
      }

      const diagnostics = `${task.errorReason || ""}\n${task.rawOutput || ""}`;
      const capacityFailure =
        task.status === "failed" &&
        !hasOfficialEvidence(task) &&
        (/ExceedConcurrencyLimit/i.test(diagnostics) || /\bret[=:]\s*1310\b/i.test(diagnostics));
      if (capacityFailure) {
        Object.assign(updates, {
          phase: "capacity_wait",
          status: "queued",
          state: "排队中",
          submitId: null,
          officialTaskId: null,
          historyRecordId: null,
          remoteConfirmedAt: null,
          nextSubmitTime: now,
          nextPollTime: null,
          capacityWaitStartedAt: task.capacityWaitStartedAt || now,
          lastProviderCode: "1310",
          errorReason: "",
          finishTime: null,
          updateTime: now,
        });
        recoveredCapacity += 1;
      } else if (
        task.status === "failed" &&
        hasOfficialEvidence(task) &&
        /(未确认|无法确认|软件重启|CLI\s*退出码|任务中断)/i.test(diagnostics)
      ) {
        Object.assign(updates, {
          phase: "processing",
          status: "processing",
          state: "生成中",
          nextPollTime: now,
          errorReason: "",
          finishTime: null,
          updateTime: now,
        });
        recoveredConfirmed += 1;
      } else if (task.status === "queued" && task.nextSubmitTime == null) {
        updates.nextSubmitTime = now;
      }

      if (Object.keys(updates).length) {
        await trx("o_videoGenerationTask").where("id", task.id).update(updates);
      }
      if (capacityFailure || updates.status === "processing") {
        if (task.videoId != null) {
          await trx("o_video").where("id", task.videoId).update({ state: "生成中", errorReason: "" });
        }
        if (task.taskCenterId != null) {
          await trx("o_tasks").where("id", task.taskCenterId).update({ state: "进行中", reason: "" });
        }
      }
    }

    await trx("o_setting").insert({
      key: MIGRATION_KEY,
      value: JSON.stringify({
        completedAt: now,
        backfilled,
        recoveredCapacity,
        recoveredConfirmed,
      }),
    });
  });

  console.info(
    `[video-queue-v3] ${JSON.stringify({
      event: "migration.completed",
      scanned: tasks.length,
      backfilled,
      recoveredCapacity,
      recoveredConfirmed,
    })}`,
  );
  return { skipped: false, backfilled, recoveredCapacity, recoveredConfirmed };
}
