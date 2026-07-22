import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("bundled T8Star 2.6 replaces 2.5 runtime code without changing configured credentials", async () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "toonflow-vendor-fix-"));
  process.env.TOONFLOW_APP_DATA_DIR = path.join(root, "app");
  process.env.TOONFLOW_WORKSPACE_DIR = path.join(root, "workspace");
  process.env.TOONFLOW_STORAGE_MODE = "workspace";
  process.env.TOONFLOW_SYSTEM_DATA_DIR = path.resolve("data");

  const [{ default: knexFactory }, { syncDefaultVendorConfigs }, { default: getPath }] = await Promise.all([
    import("knex"),
    import("../src/lib/dbFixes/vendorConfigFixes"),
    import("../src/utils/getPath"),
  ]);
  const db = knexFactory({ client: "sqlite3", connection: { filename: path.join(root, "vendor.sqlite") }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_vendorConfig", (table) => {
      table.string("id").primary();
      table.text("inputValues");
      table.text("models");
      table.integer("enable");
    });
    const inputValues = JSON.stringify({ apiKey: "keep-secret", baseUrl: "https://example.test", musicBaseUrl: "https://music.example.test" });
    await db("o_vendorConfig").insert({ id: "t8star", inputValues, models: "[]", enable: 1 });
    const vendorFile = path.join(getPath("vendor"), "t8star.ts");
    await fs.mkdir(path.dirname(vendorFile), { recursive: true });
    await fs.writeFile(vendorFile, "const vendor = { version: \"2.5\" };\n", "utf8");

    await syncDefaultVendorConfigs(db);

    const code = await fs.readFile(vendorFile, "utf8");
    const config = await db("o_vendorConfig").where("id", "t8star").first();
    assert.match(code, /version: "2\.6"/);
    assert.match(code, /\/suno\/generate/);
    assert.equal(config.inputValues, inputValues);
    assert.equal(Number(config.enable), 1);
  } finally {
    await db.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});
