import type { Knex } from "knex";

export async function truncateLongErrorFields(knex: Knex) {
  if (await knex.schema.hasTable("o_videoGenerationTask")) {
    await knex("o_videoGenerationTask")
      .whereRaw("length(errorReason) > 4096")
      .update({ errorReason: knex.raw("substr(errorReason, 1, 4096)") });
  }

  if (await knex.schema.hasTable("o_video")) {
    await knex("o_video").whereRaw("length(errorReason) > 4096").update({
      errorReason: knex.raw("substr(errorReason, 1, 4096)"),
    });
  }

  if (await knex.schema.hasTable("o_tasks")) {
    await knex("o_tasks").whereRaw("length(reason) > 4096").update({
      reason: knex.raw("substr(reason, 1, 4096)"),
    });
  }
}
