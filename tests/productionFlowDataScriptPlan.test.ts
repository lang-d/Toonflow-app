import assert from "node:assert/strict";
import fs from "node:fs";
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

before(async () => {
  db = (await import("../src/utils/db")).db;
  flowData = await import("../src/services/productionFlowData");
  textAsset = await import("../src/services/textAsset");
  productionAgent = await import("../src/agents/productionAgent");

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
    table.string("filePath");
    table.string("state");
    table.string("errorReason");
  });
  await db.schema.createTable("o_assets", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("assetsId");
    table.integer("imageId");
    table.integer("flowId");
    table.string("name");
    table.string("type");
    table.text("prompt");
    table.text("describe");
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

test("scriptPlan XML extraction only accepts complete non-empty tags", () => {
  assert.equal(productionAgent.extractCompleteScriptPlanXml("<scriptPlan>usable plan</scriptPlan>"), "usable plan");
  assert.equal(productionAgent.extractCompleteScriptPlanXml("<scriptPlan>unfinished"), "");
  assert.equal(productionAgent.extractCompleteScriptPlanXml("<scriptPlan>   </scriptPlan>"), "");
});
