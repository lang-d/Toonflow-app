import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-production-flow-data-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let db: any;
let flowData: typeof import("../src/services/productionFlowData");
let textAsset: typeof import("../src/services/textAsset");
let productionAgent: typeof import("../src/agents/productionAgent");
let addDeriveAssetRoute: any;

async function postRoute(route: any, body: Record<string, unknown>) {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use("/", route);
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

before(async () => {
  db = (await import("../src/utils/db")).db;
  flowData = await import("../src/services/productionFlowData");
  textAsset = await import("../src/services/textAsset");
  productionAgent = await import("../src/agents/productionAgent");
  addDeriveAssetRoute = (await import("../src/routes/production/assets/addDeriveAsset")).default;

  await db.schema.createTable("o_agentWorkData", (table: any) => {
    table.increments("id");
    table.integer("projectId");
    table.integer("episodesId");
    table.string("key");
    table.text("data");
    table.integer("createTime");
    table.integer("updateTime");
  });
  await db.schema.createTable("o_script", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.text("content");
  });
  await db.schema.createTable("o_scriptAssets", (table: any) => {
    table.integer("scriptId");
    table.integer("assetId");
  });
  await db.schema.createTable("o_assetsRole2Audio", (table: any) => {
    table.integer("assetsRoleId");
    table.integer("assetsAudioId");
  });
  await db.schema.createTable("o_image", (table: any) => {
    table.integer("id").primary();
    table.integer("assetsId");
    table.string("filePath");
    table.string("type");
    table.string("state");
    table.string("errorReason");
  });
  await db.schema.createTable("o_assets", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("assetsId");
    table.integer("scriptId");
    table.integer("imageId");
    table.integer("flowId");
    table.string("name");
    table.string("type");
    table.string("promptState");
    table.text("prompt");
    table.text("describe");
    table.integer("startTime");
  });
  await db.schema.createTable("o_directorAsset", (table: any) => {
    table.increments("id");
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("assetId");
    table.integer("imageId");
    table.string("assetType");
    table.string("name");
    table.text("promptFragment");
  });
  await db.schema.createTable("o_storyboard", (table: any) => {
    table.increments("id");
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("index");
    table.integer("trackId");
    table.integer("factVersion");
    table.integer("shouldGenerateImage");
    table.integer("flowId");
    table.text("tableRowJson");
    table.text("referenceImages");
    table.string("factStatus");
    table.string("duration");
    table.string("scene");
    table.string("picture");
    table.string("action");
    table.string("shotSize");
    table.string("cameraMove");
    table.string("dialogue");
    table.string("sound");
    table.string("visibleEmotion");
    table.string("location");
    table.string("timeOfDay");
    table.string("groupKey");
    table.string("groupName");
    table.string("groupIntent");
    table.string("beatId");
    table.string("filePath");
    table.string("state");
    table.string("reason");
    table.text("videoDesc");
  });
  await db.schema.createTable("o_assets2Storyboard", (table: any) => {
    table.integer("storyboardId");
    table.integer("assetId");
  });
  await db.schema.createTable("o_editImageTask", (table: any) => {
    table.increments("id");
    table.string("targetType");
    table.integer("targetId");
    table.string("nodeId");
    table.string("status");
    table.string("state");
    table.string("reason");
    table.integer("updateTime");
  });
  await db.schema.createTable("o_tasks", (table: any) => {
    table.string("taskId");
    table.string("businessType");
    table.integer("businessId");
    table.string("status");
  });
  await db.schema.createTable("o_storyboardGeneration", (table: any) => {
    table.string("generationId");
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("expectedRowCount");
    table.string("state");
    table.text("errorJson");
    table.integer("updatedAt");
  });
  await db.schema.createTable("o_textAsset", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.string("targetType");
    table.string("targetId");
    table.string("filePath");
    table.text("summary");
    table.integer("size");
    table.string("hash");
    table.integer("version");
    table.string("state");
    table.integer("createTime");
    table.integer("updateTime");
  });

  await db("o_script").insert({ id: 10, projectId: 1, content: "episode script" });
});

after(async () => {
  await db?.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("getFlowData restores scriptPlan from legacy work data when no text asset exists", async () => {
  await db("o_agentWorkData").insert({
    projectId: 1,
    episodesId: 10,
    key: "productionAgent",
    data: JSON.stringify({ scriptPlan: "legacy director plan" }),
    createTime: Date.now(),
    updateTime: Date.now(),
  });

  const result = await flowData.buildProductionFlowData(1, 10);
  assert.equal(result.scriptPlan, "legacy director plan");
});

test("getFlowData prefers latest complete scriptPlan text asset over legacy work data", async () => {
  await textAsset.createTextAsset({
    projectId: 1,
    scriptId: 10,
    targetType: "scriptPlan",
    targetId: "director-plan",
    content: "persisted director plan v1",
    summary: "",
    state: "complete",
  });
  await textAsset.createTextAsset({
    projectId: 1,
    scriptId: 10,
    targetType: "scriptPlan",
    targetId: "director-plan",
    content: "persisted director plan v2",
    summary: "",
    state: "complete",
  });

  const result = await flowData.buildProductionFlowData(1, 10);
  assert.equal(result.scriptPlan, "persisted director plan v2");
});

test("getFlowData keeps bound audio out of visual derive assets", async () => {
  await db("o_image").insert([
    { id: 1001, assetsId: 101, filePath: "/1/role/base.png", type: "role", state: "已完成" },
    { id: 1002, assetsId: 102, filePath: "/1/role/derive.png", type: "role", state: "已完成" },
    { id: 2001, assetsId: 201, filePath: "/1/assets/audio-cover.png", type: "audio", state: "已完成" },
    { id: 2002, assetsId: 202, filePath: "/1/assets/audio/voice.wav", type: "audio", state: "已完成" },
  ]);
  await db("o_assets").insert([
    { id: 101, projectId: 1, imageId: 1001, name: "Hero", type: "role", prompt: "role prompt", describe: "role desc" },
    {
      id: 102,
      projectId: 1,
      assetsId: 101,
      imageId: 1002,
      name: "Hero smile",
      type: "role",
      prompt: "derive prompt",
      describe: "derive desc",
    },
    {
      id: 201,
      projectId: 1,
      imageId: 2001,
      name: "Voice pack",
      type: "audio",
      prompt: "audio parent prompt",
      describe: "male|warm",
    },
    {
      id: 202,
      projectId: 1,
      assetsId: 201,
      imageId: 2002,
      name: "voice.wav",
      type: "audio",
      prompt: "audio file prompt",
      describe: "audio file desc",
    },
  ]);
  await db("o_scriptAssets").insert({ scriptId: 10, assetId: 101 });
  await db("o_assetsRole2Audio").insert({ assetsRoleId: 101, assetsAudioId: 201 });

  const result = await flowData.buildProductionFlowData(1, 10);

  assert.ok(result.assets.length > 0);
  assert.equal(result.assets.some((asset: any) => asset.type === "audio"), false);
  const hero = result.assets.find((asset: any) => asset.id === 101);
  assert.ok(hero);
  assert.deepEqual(
    hero.derive.map((asset: any) => asset.id),
    [102],
  );
  assert.equal(hero.derive.some((asset: any) => asset.type === "audio"), false);
  assert.deepEqual(result.assetAudioBindings.map((item: any) => item.assetId), [101]);
  assert.equal(result.assetAudioBindings[0].audioAssetId, 201);
  assert.deepEqual(
    result.assetAudioBindings[0].files.map((item: any) => item.id),
    [202],
  );
});

test("addDeriveAsset allows audio-bound visual assets and rejects audio assets", async () => {
  await db("o_assets").insert([
    { id: 301, projectId: 1, name: "Audio bound role", type: "role", describe: "role" },
    { id: 302, projectId: 1, name: "Voice parent", type: "audio", describe: "voice" },
    { id: 303, projectId: 1, assetsId: 302, name: "voice.wav", type: "audio", describe: "file" },
  ]);
  await db("o_assetsRole2Audio").insert({ assetsRoleId: 301, assetsAudioId: 302 });

  const allowed = await postRoute(addDeriveAssetRoute, {
    projectId: 1,
    scriptId: 10,
    assetsId: 301,
    name: "Role variant",
    desc: "visual variant",
  });
  assert.equal(allowed.status, 200);
  const inserted = await db("o_assets").where({ projectId: 1, assetsId: 301, name: "Role variant" }).first();
  assert.equal(inserted?.type, "role");

  const rejectedParent = await postRoute(addDeriveAssetRoute, {
    projectId: 1,
    scriptId: 10,
    assetsId: 302,
    name: "Audio variant",
    desc: "should fail",
  });
  assert.equal(rejectedParent.status, 400);

  const rejectedChild = await postRoute(addDeriveAssetRoute, {
    projectId: 1,
    scriptId: 10,
    assetsId: 303,
    name: "Audio child variant",
    desc: "should fail",
  });
  assert.equal(rejectedChild.status, 400);
});

test("scriptPlan XML extraction only accepts complete non-empty tags", () => {
  assert.equal(productionAgent.extractCompleteScriptPlanXml("<scriptPlan>usable plan</scriptPlan>"), "usable plan");
  assert.equal(productionAgent.extractCompleteScriptPlanXml("<scriptPlan>unfinished"), "");
  assert.equal(productionAgent.extractCompleteScriptPlanXml("<scriptPlan>   </scriptPlan>"), "");
});
