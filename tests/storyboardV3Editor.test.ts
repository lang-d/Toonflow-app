import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-storyboard-v3-editor-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let db: typeof import("../src/utils/db").db;
let editor: typeof import("../src/services/storyboardEditor");

const rowV3 = (description: string) => ({
  version: 3 as const,
  index: 0,
  groupKey: "G01",
  beatId: "B01",
  durationSec: 5,
  location: "院坝",
  timeOfDay: "日",
  shotDescription: description,
  shotSize: "中景",
  cameraMove: "固定",
  dialogue: [],
  soundEffects: ["院外车声"],
  requiredAssets: [{ assetId: 1, name: "苏晴", type: "role" as const, order: 0 }],
});

before(async () => {
  db = (await import("../src/utils/db")).db;
  editor = await import("../src/services/storyboardEditor");
  await db.schema.createTable("o_storyboard", (table) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("index");
    table.integer("trackId");
    table.integer("flowId");
    table.text("tableRowJson");
    table.string("factStatus");
    table.integer("factVersion");
    table.integer("factRevision");
    table.string("duration");
    table.string("scene");
    table.string("location");
    table.string("timeOfDay");
    table.string("sceneContinuityId");
    table.string("picture");
    table.string("action");
    table.string("shotSize");
    table.string("cameraMove");
    table.string("dialogue");
    table.string("sound");
    table.string("visibleEmotion");
    table.string("groupKey");
    table.string("groupName");
    table.string("groupIntent");
    table.string("beatId");
    table.string("videoDesc");
    table.string("prompt");
    table.string("filePath");
    table.integer("shouldGenerateImage");
    table.text("referenceImages");
  });
  await db.schema.createTable("o_assets", (table) => {
    table.integer("id").primary();
    table.integer("projectId");
  });
  await db.schema.createTable("o_assets2Storyboard", (table) => {
    table.integer("storyboardId");
    table.integer("assetId");
  });
  await db("o_assets").insert([
    { id: 1, projectId: 10 },
    { id: 2, projectId: 10 },
    { id: 3, projectId: 99 },
  ]);
  await db("o_storyboard").insert({
    id: 100,
    projectId: 10,
    scriptId: 20,
    index: 0,
    trackId: null,
    tableRowJson: JSON.stringify(rowV3("苏晴扶着纸箱站在台边。她听见车声后抬头。")),
    factStatus: "ready",
    factVersion: 3,
    factRevision: 7,
    duration: "5",
    groupName: "来车",
    groupIntent: "建立触发",
    prompt: "old panel prompt",
    shouldGenerateImage: 1,
    referenceImages: "[]",
  });
  await db("o_assets2Storyboard").insert({ storyboardId: 100, assetId: 1 });
});

after(async () => {
  await db.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("panel update changes only derived image fields", async () => {
  const before = await db("o_storyboard").where({ id: 100 }).first();
  await editor.updateStoryboardPanelFields({
    projectId: 10,
    scriptId: 20,
    storyboardId: 100,
    prompt: "new panel prompt",
    shouldGenerateImage: false,
    associateAssetsIds: [2],
    referenceImages: [{ source: "local", url: "/project/ref.png" }],
  });

  const afterRow = await db("o_storyboard").where({ id: 100 }).first();
  assert.equal(afterRow.prompt, "new panel prompt");
  assert.equal(Number(afterRow.shouldGenerateImage), 0);
  assert.equal(afterRow.tableRowJson, before.tableRowJson);
  assert.equal(Number(afterRow.factRevision), 7);
  assert.equal(JSON.parse(afterRow.referenceImages).length, 1);
  assert.deepEqual(
    (await db("o_assets2Storyboard").where({ storyboardId: 100 })).map((item) => Number(item.assetId)),
    [2],
  );
});

test("formal fact update increments revision without changing panel fields", async () => {
  const before = await db("o_storyboard").where({ id: 100 }).first();
  const beforeAssetIds = (await db("o_assets2Storyboard").where({ storyboardId: 100 })).map((item) =>
    Number(item.assetId),
  );
  const next = rowV3(
    "苏晴扶着未封口纸箱站在台边。院外传来车声，她停手抬头；镜头结束时，她松开纸箱向院门迈出一步。",
  );
  const result = await editor.updateStoryboardFacts({
    projectId: 10,
    scriptId: 20,
    storyboardId: 100,
    tableRowJson: next,
  });

  const afterRow = await db("o_storyboard").where({ id: 100 }).first();
  assert.equal(result.factVersion, 3);
  assert.equal(result.factRevision, Number(before.factRevision) + 1);
  assert.deepEqual(JSON.parse(afterRow.tableRowJson), next);
  assert.equal(afterRow.prompt, before.prompt);
  assert.equal(afterRow.referenceImages, before.referenceImages);
  assert.equal(Number(afterRow.shouldGenerateImage), Number(before.shouldGenerateImage));
  assert.deepEqual(
    (await db("o_assets2Storyboard").where({ storyboardId: 100 })).map((item) => Number(item.assetId)),
    beforeAssetIds,
  );
});

test("incomplete V3 facts remain draft-shaped data and cannot be saved as ready", async () => {
  const invalid = { ...rowV3("valid") } as Record<string, unknown>;
  delete invalid.shotDescription;
  await assert.rejects(
    editor.updateStoryboardFacts({
      projectId: 10,
      scriptId: 20,
      storyboardId: 100,
      tableRowJson: invalid,
    }),
    /complete version-native row/,
  );
});

test("draft facts cannot receive panel-derived fields", async () => {
  const draft = { ...rowV3("temporary") } as Record<string, unknown>;
  delete draft.shotDescription;
  await db("o_storyboard").insert({
    id: 101,
    projectId: 10,
    scriptId: 20,
    index: 1,
    tableRowJson: JSON.stringify(draft),
    factStatus: "draft",
    factVersion: 3,
    factRevision: 1,
    prompt: "unchanged draft prompt",
    shouldGenerateImage: 0,
    referenceImages: "[]",
  });

  await assert.rejects(
    editor.updateStoryboardPanelFields({
      projectId: 10,
      scriptId: 20,
      storyboardId: 101,
      prompt: "must not persist",
      shouldGenerateImage: true,
      associateAssetsIds: [],
      referenceImages: [],
    }),
    /Storyboard panel update failed/,
  );
  const row = await db("o_storyboard").where({ id: 101 }).first();
  assert.equal(row.prompt, "unchanged draft prompt");
  assert.equal(Number(row.shouldGenerateImage), 0);
});

test("cross-project assets are rejected without mutating either fact or panel state", async () => {
  const before = await db("o_storyboard").where({ id: 100 }).first();
  await assert.rejects(
    editor.updateStoryboardPanelFields({
      projectId: 10,
      scriptId: 20,
      storyboardId: 100,
      prompt: "must not persist",
      shouldGenerateImage: true,
      associateAssetsIds: [3],
      referenceImages: [],
    }),
    /分镜数据校验失败/,
  );
  const afterRow = await db("o_storyboard").where({ id: 100 }).first();
  assert.equal(afterRow.prompt, before.prompt);
  assert.equal(afterRow.tableRowJson, before.tableRowJson);
});
