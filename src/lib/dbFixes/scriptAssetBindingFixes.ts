import type { Knex } from "knex";
import { VISUAL_ASSET_TYPES } from "@/services/assetTypes";

export async function cleanupScriptAssetBindings(knex: Knex) {
  if (
    !(await knex.schema.hasTable("o_scriptAssets")) ||
    !(await knex.schema.hasTable("o_assets")) ||
    !(await knex.schema.hasTable("o_script"))
  ) {
    return;
  }

  await knex("o_scriptAssets")
    .whereNotExists(function () {
      this.select(1).from("o_assets").whereRaw("o_assets.id = o_scriptAssets.assetId");
    })
    .delete();

  await knex("o_scriptAssets")
    .whereNotExists(function () {
      this.select(1).from("o_script").whereRaw("o_script.id = o_scriptAssets.scriptId");
    })
    .delete();

  await knex("o_scriptAssets")
    .whereExists(function () {
      this.select(1)
        .from("o_script")
        .join("o_assets", "o_assets.id", "o_scriptAssets.assetId")
        .whereRaw("o_script.id = o_scriptAssets.scriptId")
        .whereRaw("o_script.projectId <> o_assets.projectId");
    })
    .delete();

  await knex("o_scriptAssets")
    .whereExists(function () {
      this.select(1)
        .from("o_assets")
        .whereRaw("o_assets.id = o_scriptAssets.assetId")
        .where(function () {
          this.whereNotIn("o_assets.type", VISUAL_ASSET_TYPES as unknown as string[]).orWhereNotNull("o_assets.assetsId");
        });
    })
    .delete();
}
