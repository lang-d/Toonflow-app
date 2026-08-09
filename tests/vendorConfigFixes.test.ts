import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("bundled T8Star 2.7 replaces 2.5 runtime code without changing configured credentials", async () => {
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
    assert.match(code, /version: "2\.7"/);
    assert.match(code, /\/suno\/generate/);
    assert.equal(config.inputValues, inputValues);
    assert.equal(Number(config.enable), 1);
  } finally {
    await db.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bundled Agnes 1.1 adds 2.5 models without changing configured credentials or enablement", async () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "toonflow-agnes-vendor-fix-"));
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
    const inputValues = JSON.stringify({ apiKey: "keep-secret", baseUrl: "https://agnes.example.test" });
    await db("o_vendorConfig").insert({ id: "agnes", inputValues, models: "[]", enable: 1 });
    const vendorFile = path.join(getPath("vendor"), "agnes.ts");
    await fs.mkdir(path.dirname(vendorFile), { recursive: true });
    await fs.writeFile(vendorFile, 'const vendor = { version: "1.0" };\n', "utf8");

    await syncDefaultVendorConfigs(db);

    const code = await fs.readFile(vendorFile, "utf8");
    const config = await db("o_vendorConfig").where("id", "agnes").first();
    const models = JSON.parse(config.models);
    assert.match(code, /version: "1\.1"/);
    assert.deepEqual(
      models.filter((model: any) => model.type === "text").map((model: any) => model.modelName),
      ["agnes-2.0-flash", "agnes-2.5-flash", "agnes-2.5-pro-alpha"],
    );
    assert.equal(config.inputValues, inputValues);
    assert.equal(Number(config.enable), 1);
  } finally {
    await db.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bundled XLCSH Seedance 2 is created disabled and upgrades runtime code without changing credentials", async () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "toonflow-xlcsh-vendor-fix-"));
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

    await syncDefaultVendorConfigs(db);
    const created = await db("o_vendorConfig").where("id", "xlcsh").first();
    assert.equal(Number(created.enable), 0);
    assert.deepEqual(JSON.parse(created.inputValues), { apiKey: "", baseUrl: "https://new.xlcsh.top/v1" });
    assert.deepEqual(JSON.parse(created.models).map((model: any) => model.modelName), ["seedance-2.0", "seedance-2.0-unlimited", "seedance-2.0-mini"]);

    const inputValues = JSON.stringify({ apiKey: "keep-secret", baseUrl: "https://xlcsh.example.test/v1" });
    await db("o_vendorConfig").where("id", "xlcsh").update({ inputValues, enable: 1, models: "[]" });
    const vendorFile = path.join(getPath("vendor"), "xlcsh.ts");
    await fs.writeFile(vendorFile, 'const vendor = { version: "0.9" };\n', "utf8");

    await syncDefaultVendorConfigs(db);
    const upgraded = await db("o_vendorConfig").where("id", "xlcsh").first();
    assert.equal(upgraded.inputValues, inputValues);
    assert.equal(Number(upgraded.enable), 1);
    assert.deepEqual(JSON.parse(upgraded.models).map((model: any) => model.modelName), ["seedance-2.0", "seedance-2.0-unlimited", "seedance-2.0-mini"]);
    assert.match(await fs.readFile(vendorFile, "utf8"), /version: "2\.0\.1"/);
  } finally {
    await db.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bundled MiniMax 2.2 upgrades video models without replacing credentials or enablement", async () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "toonflow-minimax-vendor-fix-"));
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
    const inputValues = JSON.stringify({ apiKey: "keep-secret", baseUrl: "https://minimax.example.test" });
    await db("o_vendorConfig").insert({ id: "minimax", inputValues, models: "[]", enable: 1 });
    const vendorFile = path.join(getPath("vendor"), "minimax.ts");
    await fs.mkdir(path.dirname(vendorFile), { recursive: true });
    await fs.writeFile(vendorFile, 'const vendor = { version: "2.1" };\n', "utf8");

    await syncDefaultVendorConfigs(db);

    const config = await db("o_vendorConfig").where("id", "minimax").first();
    const models = JSON.parse(config.models);
    assert.match(await fs.readFile(vendorFile, "utf8"), /version: "2\.2"/);
    assert.deepEqual(
      models.filter((item: any) => item.type === "video").map((item: any) => item.modelName),
      ["MiniMax-H3", "MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast"],
    );
    assert.equal(inputValues, config.inputValues);
    assert.equal(Number(config.enable), 1);
  } finally {
    await db.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bundled Zealman 2.2 upgrades its runtime without replacing saved workflow execution settings", async () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "toonflow-zealman-vendor-fix-"));
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
    const inputValues = JSON.stringify({
      instanceUrls: "https://zealman.example:8443",
      zealmanWorkflowExecutionSettings: JSON.stringify({ u06: { "620:unet_name": "minimax/minimax_h3_ref2va_bf16.safetensors" } }),
    });
    await db("o_vendorConfig").insert({ id: "zealman", inputValues, models: "[]", enable: 1 });
    const vendorFile = path.join(getPath("vendor"), "zealman.ts");
    await fs.mkdir(path.dirname(vendorFile), { recursive: true });
    await fs.writeFile(vendorFile, 'const vendor = { version: "2.1" };\n', "utf8");

    await syncDefaultVendorConfigs(db);

    const config = await db("o_vendorConfig").where("id", "zealman").first();
    assert.match(await fs.readFile(vendorFile, "utf8"), /version: "2\.2"/);
    assert.equal(config.inputValues, inputValues);
    assert.equal(Number(config.enable), 1);
    assert.deepEqual(JSON.parse(config.models).map((item: any) => item.modelName), ["minimax-h3-u06", "minimax-h3-u06-light2v"]);
  } finally {
    await db.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("installed best vendor removes Suno V5.5 without replacing credentials or other models", async () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "toonflow-best-music-fix-"));
  process.env.TOONFLOW_APP_DATA_DIR = path.join(root, "app");
  process.env.TOONFLOW_WORKSPACE_DIR = path.join(root, "workspace");
  process.env.TOONFLOW_STORAGE_MODE = "workspace";
  process.env.TOONFLOW_SYSTEM_DATA_DIR = path.resolve("data");

  const [{ default: knexFactory }, { fixVendorConfigs }, { default: getPath }] = await Promise.all([
    import("knex"),
    import("../src/lib/dbFixes/vendorConfigFixes"),
    import("../src/utils/getPath"),
  ]);
  const db = knexFactory({ client: "sqlite3", connection: { filename: path.join(root, "vendor.sqlite") }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_vendorConfig", (table) => {
      table.string("id").primary();
      table.text("code");
      table.text("inputValues");
      table.text("models");
      table.integer("enable");
    });
    await db.schema.createTable("o_modelPrompt", (table) => {
      table.increments("id");
      table.string("vendorId");
      table.string("model");
      table.string("fileName");
      table.string("path");
    });
    const inputValues = JSON.stringify({ apiKey: "keep-secret", musicKey: "keep-music-secret" });
    const bestCode = 'const vendor = { id: "best", version: "2.7.6", inputs: [], inputValues: { apiKey: "" }, models: [] };\nconst getBaseUrl = () => "https://api.4022543.xyz";\nexports.vendor = vendor;';
    const existingModels = [{ name: "Existing Text", modelName: "existing-text", type: "text" }, { name: "Suno V5.5", modelName: "chirp-fenix", type: "music" }];
    await db("o_vendorConfig").insert({ id: "best", code: bestCode, inputValues, models: JSON.stringify(existingModels), enable: 1 });

    await fixVendorConfigs(db);

    const file = await fs.readFile(path.join(getPath("vendor"), "best.ts"), "utf8");
    const config = await db("o_vendorConfig").where("id", "best").first();
    const binding = await db("o_modelPrompt").where({ vendorId: "best", model: "chirp-fenix" }).first();
    assert.match(file, /toonflow-best-suno-v55/);
    assert.match(file, /musicRequest/);
    assert.equal(config.inputValues, inputValues);
    assert.equal(Number(config.enable), 1);
    assert.equal(JSON.parse(config.models).some((item: any) => item.modelName === "chirp-fenix"), false);
    assert.equal(JSON.parse(config.models).some((item: any) => item.modelName === "existing-text"), true);
    assert.equal(binding, undefined);
  } finally {
    await db.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});
