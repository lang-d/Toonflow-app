import type { Knex } from "knex";

async function addColumn(knex: Knex, table: string, column: string, type: string) {
  if (!(await knex.schema.hasTable(table))) return;
  if (!(await knex.schema.hasColumn(table, column))) {
    await knex.schema.alterTable(table, (t) => (t as any)[type](column));
  }
}

async function hasColumns(knex: Knex, table: string, columns: string[]) {
  if (!(await knex.schema.hasTable(table))) return false;
  for (const column of columns) {
    if (!(await knex.schema.hasColumn(table, column))) return false;
  }
  return true;
}

export async function ensureAssetFoundationColumns(knex: Knex) {
  await addColumn(knex, "o_assets", "foundationText", "text");
  await addColumn(knex, "o_assets", "foundationStatus", "string");
  await addColumn(knex, "o_assets", "foundationErrorReason", "text");
}

export async function fixAssetSchema(knex: Knex) {
  await ensureAssetFoundationColumns(knex);

  if (await knex.schema.hasTable("o_novel")) {
    await knex("o_novel").where("eventState", 0).update({
      eventState: -1,
      errorReason: "软件退出导致失败",
    });
  }

  if (await knex.schema.hasTable("o_script")) {
    await knex("o_script").where("extractState", 0).update({
      extractState: -1,
      errorReason: "软件退出导致失败",
    });
  }

  if (await knex.schema.hasTable("o_assets")) {
    if (await knex.schema.hasColumn("o_assets", "promptState")) {
      const updateData: Record<string, string> = { promptState: "生成失败" };
      if (await knex.schema.hasColumn("o_assets", "promptErrorReason")) {
        updateData.promptErrorReason = "软件退出导致失败";
      }
      await knex("o_assets").where("promptState", "生成中").update(updateData);
    }

    if ((await knex.schema.hasColumn("o_assets", "foundationState")) && (await knex.schema.hasColumn("o_assets", "foundationStatus"))) {
      await knex("o_assets")
        .whereNull("foundationStatus")
        .update({
          foundationStatus: knex.raw(`
            CASE foundationState
              WHEN '生成中' THEN 'processing'
              WHEN '已完成' THEN 'completed'
              WHEN '生成失败' THEN 'failed'
              WHEN '未生成' THEN 'pending'
              ELSE foundationState
            END
          `),
        });
    }

    await knex("o_assets").where("foundationStatus", "processing").update({
      foundationStatus: "failed",
      foundationErrorReason: "软件退出导致失败",
    });
  }

  if (await hasColumns(knex, "o_image", ["state"])) {
    const updateData: Record<string, string> = { state: "生成失败" };
    if (await knex.schema.hasColumn("o_image", "errorReason")) {
      updateData.errorReason = "软件退出导致失败";
    }
    await knex("o_image").where("state", "生成中").update({
      ...updateData,
    });
  }

  if (await hasColumns(knex, "o_storyboard", ["state"])) {
    const updateData: Record<string, string> = { state: "生成失败" };
    if (await knex.schema.hasColumn("o_storyboard", "reason")) {
      updateData.reason = "软件退出导致失败";
    }
    await knex("o_storyboard").where("state", "生成中").update({
      ...updateData,
    });
  }

  if (await hasColumns(knex, "o_video", ["state"])) {
    const query = knex("o_video").where("state", "生成中");
    if (await hasColumns(knex, "o_videoGenerationTask", ["videoId", "state"])) {
      query.whereNotExists(function () {
        this.select(1)
          .from("o_videoGenerationTask")
          .whereRaw("o_videoGenerationTask.videoId = o_video.id")
          .whereIn("o_videoGenerationTask.state", ["排队中", "提交中", "生成中"]);
      });
    }
    const updateData: Record<string, string> = { state: "生成失败" };
    if (await knex.schema.hasColumn("o_video", "errorReason")) {
      updateData.errorReason = "软件退出导致失败";
    }
    await query.update(updateData);
  }
}
