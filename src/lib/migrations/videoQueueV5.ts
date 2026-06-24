import type { Knex } from "knex";

const MIGRATION_KEY = "migration:video-queue-v5-dreamina-polling-and-vip-4k";

export function upgradeDreaminaModelsV5(models: any[]) {
  let changed = 0;
  for (const model of models) {
    if (model?.type !== "video") continue;
    let modelChanged = false;
    const queueConfig = model.queueConfig;
    if (
      queueConfig &&
      Number(queueConfig.pollInitialDelaySec) === 60 &&
      Number(queueConfig.pollMinIntervalSec) === 120 &&
      Number(queueConfig.pollMaxIntervalSec) === 600
    ) {
      model.queueConfig = {
        ...queueConfig,
        pollInitialDelaySec: 20,
        pollMinIntervalSec: 20,
        pollMaxIntervalSec: 60,
      };
      modelChanged = true;
    }
    if (/seedance2\.0[_-]?vip/i.test(String(model.modelName || ""))) {
      const maps = Array.isArray(model.durationResolutionMap) ? model.durationResolutionMap : [];
      for (const map of maps) {
        if (!Array.isArray(map?.resolution)) continue;
        if (!map.resolution.some((value: unknown) => String(value).toLowerCase() === "4k")) {
          map.resolution.push("4K");
          modelChanged = true;
        }
      }
    }
    if (modelChanged) changed += 1;
  }
  return changed;
}

export async function migrateVideoQueueV5(knex: Knex) {
  if (await knex("o_setting").where("key", MIGRATION_KEY).first()) {
    return { skipped: true, migratedModels: 0 };
  }
  const vendor = await knex("o_vendorConfig").where("id", "dreamina").first("models");
  const models = JSON.parse(vendor?.models || "[]");
  const migratedModels = upgradeDreaminaModelsV5(models);
  const now = Date.now();
  await knex.transaction(async (trx) => {
    if (vendor && migratedModels) {
      await trx("o_vendorConfig").where("id", "dreamina").update({ models: JSON.stringify(models) });
    }
    await trx("o_setting").insert({
      key: MIGRATION_KEY,
      value: JSON.stringify({ completedAt: now, migratedModels }),
    });
  });
  console.info(`[video-queue-v5] ${JSON.stringify({ event: "migration.completed", migratedModels })}`);
  return { skipped: false, migratedModels };
}
