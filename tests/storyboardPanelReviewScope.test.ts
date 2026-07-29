import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-storyboard-panel-review-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let db: any;
let reviewScope: typeof import("../src/services/storyboardPanelReviewScope");

before(async () => {
  db = (await import("../src/utils/db")).db;
  reviewScope = await import("../src/services/storyboardPanelReviewScope");
  await db.schema.createTable("o_storyboard", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("index");
    table.text("prompt");
    table.integer("shouldGenerateImage");
    table.string("factStatus");
    table.text("tableRowJson");
  });
  await db.schema.createTable("o_assets2Storyboard", (table: any) => {
    table.integer("storyboardId");
    table.integer("assetId");
  });
  await db("o_storyboard").insert([
    {
      id: 101,
      projectId: 1,
      scriptId: 11,
      index: 1,
      prompt: "当前提示词一",
      shouldGenerateImage: 1,
      factStatus: "ready",
      tableRowJson: JSON.stringify({ index: 1, picture: "上游旧句一", action: "放下筷子" }),
    },
    {
      id: 102,
      projectId: 1,
      scriptId: 11,
      index: 2,
      prompt: "当前提示词二",
      shouldGenerateImage: 0,
      factStatus: "ready",
      tableRowJson: JSON.stringify({ index: 2, picture: "上游旧句二" }),
    },
    {
      id: 201,
      projectId: 2,
      scriptId: 22,
      index: 1,
      prompt: "其他项目提示词",
      shouldGenerateImage: 1,
      factStatus: "ready",
      tableRowJson: JSON.stringify({ index: 1, picture: "其他项目事实" }),
    },
  ]);
  await db("o_assets2Storyboard").insert([
    { storyboardId: 101, assetId: 501 },
    { storyboardId: 101, assetId: 502 },
    { storyboardId: 102, assetId: 503 },
    { storyboardId: 201, assetId: 999 },
  ]);
});

after(async () => {
  await db.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("panel review targets paginate current fields without upstream facts", async () => {
  const first = await reviewScope.readStoryboardPanelTargets({ projectId: 1, scriptId: 11, limit: 1 });
  assert.equal(first.snapshotId.length, 64);
  assert.equal(first.total, 2);
  assert.equal(first.nextOffset, 1);
  assert.deepEqual(first.items, [
    {
      storyboardId: 101,
      index: 1,
      prompt: "当前提示词一",
      associateAssetsIds: [501, 502],
      shouldGenerateImage: true,
    },
  ]);
  assert.equal("tableRowJson" in first.items[0], false);
  assert.equal("picture" in first.items[0], false);
  assert.equal("action" in first.items[0], false);

  const second = await reviewScope.readStoryboardPanelTargets({
    projectId: 1,
    scriptId: 11,
    snapshotId: first.snapshotId,
    offset: first.nextOffset!,
    limit: 1,
  });
  assert.equal(second.nextOffset, null);
  assert.equal(second.items[0].storyboardId, 102);
});

test("panel review sources return parsed facts without current target fields", async () => {
  const targets = await reviewScope.readStoryboardPanelTargets({ projectId: 1, scriptId: 11 });
  const sources = await reviewScope.readStoryboardPanelSources({
    projectId: 1,
    scriptId: 11,
    snapshotId: targets.snapshotId,
    storyboardIds: [101, 102],
  });
  assert.deepEqual(sources.items[0].tableRowJson, {
    index: 1,
    picture: "上游旧句一",
    action: "放下筷子",
  });
  assert.equal(sources.items[0].sourceError, null);
  assert.equal("prompt" in sources.items[0], false);
  assert.equal("associateAssetsIds" in sources.items[0], false);
  assert.equal("shouldGenerateImage" in sources.items[0], false);
});

test("panel review target reread is scoped and rejects missing or cross-project ids", async () => {
  const targets = await reviewScope.readStoryboardPanelTargets({ projectId: 1, scriptId: 11 });
  const reread = await reviewScope.readStoryboardPanelTargets({
    projectId: 1,
    scriptId: 11,
    snapshotId: targets.snapshotId,
    storyboardIds: [102],
  });
  assert.deepEqual(reread.items.map((item) => item.storyboardId), [102]);
  await assert.rejects(
    reviewScope.readStoryboardPanelTargets({
      projectId: 1,
      scriptId: 11,
      snapshotId: targets.snapshotId,
      storyboardIds: [201],
    }),
    /不属于当前项目\/剧本或不存在/,
  );
});

test("panel review snapshot becomes stale when targets or sources change", async () => {
  const targets = await reviewScope.readStoryboardPanelTargets({ projectId: 1, scriptId: 11 });
  await db("o_storyboard").where({ id: 101 }).update({ prompt: "当前提示词一（已修改）" });
  await assert.rejects(
    reviewScope.readStoryboardPanelTargets({
      projectId: 1,
      scriptId: 11,
      snapshotId: targets.snapshotId,
      offset: 1,
    }),
    /审核对象已变化/,
  );
  await db("o_storyboard").where({ id: 101 }).update({ prompt: "当前提示词一" });

  const refreshed = await reviewScope.readStoryboardPanelTargets({ projectId: 1, scriptId: 11 });
  await db("o_storyboard")
    .where({ id: 101 })
    .update({ tableRowJson: JSON.stringify({ index: 1, picture: "上游事实已修改" }) });
  await assert.rejects(
    reviewScope.readStoryboardPanelSources({
      projectId: 1,
      scriptId: 11,
      snapshotId: refreshed.snapshotId,
      storyboardIds: [101],
    }),
    /审核对象已变化/,
  );
});

