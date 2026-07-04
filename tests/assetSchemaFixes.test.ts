import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import knexFactory from "knex";
import { fixAssetSchema } from "../src/lib/dbFixes/assetSchemaFixes";

function createDb(name: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `toonflow-${name}-`));
  const db = knexFactory({
    client: "sqlite3",
    connection: { filename: path.join(dataDir, "test.sqlite") },
    useNullAsDefault: true,
  });
  return { db, dataDir };
}

async function destroyDb(db: any, dataDir: string) {
  await db.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

test("asset schema fix adds missing foundation columns before status recovery", async () => {
  const { db, dataDir } = createDb("asset-schema-missing");
  try {
    await db.schema.createTable("o_assets", (table) => {
      table.integer("id").primary();
      table.string("promptState");
      table.text("promptErrorReason");
    });
    await db("o_assets").insert({ id: 1, promptState: "生成中" });

    await fixAssetSchema(db);

    assert.equal(await db.schema.hasColumn("o_assets", "foundationText"), true);
    assert.equal(await db.schema.hasColumn("o_assets", "foundationStatus"), true);
    assert.equal(await db.schema.hasColumn("o_assets", "foundationErrorReason"), true);
    const row = await db("o_assets").where("id", 1).first();
    assert.equal(row.promptState, "生成失败");
  } finally {
    await destroyDb(db, dataDir);
  }
});

test("asset schema fix handles intermediate foundationStatus without foundationErrorReason", async () => {
  const { db, dataDir } = createDb("asset-schema-intermediate");
  try {
    await db.schema.createTable("o_assets", (table) => {
      table.integer("id").primary();
      table.string("foundationStatus");
    });
    await db("o_assets").insert({ id: 1, foundationStatus: "processing" });

    await fixAssetSchema(db);

    assert.equal(await db.schema.hasColumn("o_assets", "foundationErrorReason"), true);
    const row = await db("o_assets").where("id", 1).first();
    assert.equal(row.foundationStatus, "failed");
    assert.match(row.foundationErrorReason, /软件退出/);
  } finally {
    await destroyDb(db, dataDir);
  }
});

test("asset schema fix migrates legacy foundationState into foundationStatus", async () => {
  const { db, dataDir } = createDb("asset-schema-state");
  try {
    await db.schema.createTable("o_assets", (table) => {
      table.integer("id").primary();
      table.string("foundationState");
      table.string("foundationStatus");
      table.text("foundationErrorReason");
    });
    await db("o_assets").insert({ id: 1, foundationState: "已完成" });

    await fixAssetSchema(db);

    const row = await db("o_assets").where("id", 1).first();
    assert.equal(row.foundationStatus, "completed");
  } finally {
    await destroyDb(db, dataDir);
  }
});
