import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import sharp from "sharp";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-workbench-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let u: any;
let db: any;
let mergedService: typeof import("../src/services/workbenchMergedReference");
let referenceService: typeof import("../src/services/workbenchReference");
let directorAssetService: typeof import("../src/services/directorAsset");

before(async () => {
  u = (await import("../src/utils")).default;
  db = (await import("../src/utils/db")).db;
  mergedService = await import("../src/services/workbenchMergedReference");
  referenceService = await import("../src/services/workbenchReference");
  directorAssetService = await import("../src/services/directorAsset");

  await db.schema.createTable("o_project", (table: any) => {
    table.integer("id").primary();
  });
  await db.schema.createTable("o_script", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
  });
  await db.schema.createTable("o_videoTrack", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
  });
  await db.schema.createTable("o_storyboard", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("trackId");
    table.integer("index");
    table.string("filePath");
    table.string("videoDesc");
  });
  await db.schema.createTable("o_assets2Storyboard", (table: any) => {
    table.integer("storyboardId");
    table.integer("assetId");
  });
  await db.schema.createTable("o_assets", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("assetsId");
    table.integer("imageId");
    table.integer("scriptId");
    table.integer("startTime");
    table.string("name");
    table.string("type");
    table.string("prompt");
    table.string("remark");
    table.string("describe");
    table.string("promptState");
  });
  await db.schema.createTable("o_image", (table: any) => {
    table.increments("id");
    table.integer("assetsId");
    table.string("filePath");
    table.string("type");
    table.string("model");
    table.string("state");
  });
  await db.schema.createTable("o_directorAsset", (table: any) => {
    table.increments("id");
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("flowId");
    table.string("nodeId");
    table.string("targetType");
    table.integer("targetId");
    table.integer("assetId");
    table.integer("imageId");
    table.string("assetType");
    table.string("name");
    table.text("promptFragment");
    table.text("sourceRefs");
    table.text("camera");
    table.text("stageDraft");
    table.integer("createTime");
    table.integer("updateTime");
  });
  await db.schema.createTable("o_workbenchMergedReference", (table: any) => {
    table.increments("id");
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("trackId");
    table.string("mergeType");
    table.string("name");
    table.string("filePath");
    table.string("fileType");
    table.string("prompt");
    table.text("sourceRefs");
    table.integer("position");
    table.string("state");
    table.integer("createTime");
    table.integer("updateTime");
  });

  await db("o_project").insert([{ id: 1 }, { id: 2 }]);
  await db("o_script").insert([
    { id: 10, projectId: 1 },
    { id: 20, projectId: 2 },
  ]);
  await db("o_videoTrack").insert([
    { id: 100, projectId: 1, scriptId: 10 },
    { id: 200, projectId: 2, scriptId: 20 },
  ]);
  const red = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#ff0000" } }).png().toBuffer();
  const blue = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#0000ff" } }).png().toBuffer();
  const green = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#00ff00" } }).png().toBuffer();
  await u.oss.writeFile("/1/storyboard/red.png", red);
  await u.oss.writeFile("/1/storyboard/blue.png", blue);
  await u.oss.writeFile("/2/storyboard/green.png", green);
  await db("o_storyboard").insert([
    { id: 101, projectId: 1, scriptId: 10, trackId: 100, index: 0, filePath: "/1/storyboard/red.png", videoDesc: "red" },
    { id: 102, projectId: 1, scriptId: 10, trackId: 100, index: 1, filePath: "/1/storyboard/blue.png", videoDesc: "blue" },
    { id: 201, projectId: 2, scriptId: 20, trackId: 200, index: 0, filePath: "/2/storyboard/green.png", videoDesc: "green" },
  ]);
});

after(async () => {
  await db?.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("storyboard merged reference preserves requested order and persists a snapshot", async () => {
  const result = await mergedService.createMergedReference({
    projectId: 1,
    scriptId: 10,
    trackId: 100,
    mergeType: "storyboard",
    refs: [
      { id: 101, sources: "storyboard", order: 2, label: "P1" },
      { id: 102, sources: "storyboard", order: 1, label: "P2" },
    ],
  });
  assert.equal(result.sources, "merged");
  assert.match(result.src, /workbench\/merged/);

  const row = await db("o_workbenchMergedReference").where("id", result.id).first();
  assert.equal(row.state, "active");
  assert.deepEqual(
    JSON.parse(row.sourceRefs).map((item: any) => item.id),
    [102, 101],
  );
  const output = await u.oss.getFile(row.filePath);
  const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => {
    const offset = (y * info.width + x) * info.channels;
    return [data[offset], data[offset + 1], data[offset + 2]];
  };
  const left = pixel(344, 284);
  const right = pixel(1004, 284);
  assert.ok(left[2] > left[0], `expected blue first, got ${left}`);
  assert.ok(right[0] > right[2], `expected red second, got ${right}`);
});

test("same ordered source group archives the previous merged reference", async () => {
  const before = await db("o_workbenchMergedReference").where({ trackId: 100, state: "active" }).first();
  const next = await mergedService.createMergedReference({
    projectId: 1,
    scriptId: 10,
    trackId: 100,
    mergeType: "storyboard",
    refs: [
      { id: 102, sources: "storyboard", order: 0 },
      { id: 101, sources: "storyboard", order: 1 },
    ],
  });
  assert.equal((await db("o_workbenchMergedReference").where("id", before.id).first()).state, "archived");
  assert.equal((await db("o_workbenchMergedReference").where("id", next.id).first()).state, "active");
});

test("reference resolver supports merged URLs and keeps missing items isolated", async () => {
  const active = await db("o_workbenchMergedReference").where({ trackId: 100, state: "active" }).first();
  const resolved = await referenceService.resolveWorkbenchReferences(
    [
      { id: 101, sources: "storyboard" },
      { id: active.id, sources: "merged" },
    ],
    { projectId: 1, scriptId: 10, trackId: 100 },
  );
  assert.deepEqual(
    resolved.map((item: any) => item.sources),
    ["storyboard", "merged"],
  );
  const urls = await referenceService.resolveReferenceUrls([
    { id: active.id, sources: "merged" },
    { id: 999999, sources: "merged" },
  ]);
  assert.match(urls[`${active.id}:merged`]?.path || "", /workbench\/merged/);
  assert.equal(urls["999999:merged"], null);
});

test("director stage screenshots become reusable director asset references", async () => {
  const image = await sharp({ create: { width: 96, height: 64, channels: 3, background: "#8844ff" } }).png().toBuffer();
  const created = await directorAssetService.createDirectorAsset({
    projectId: 1,
    scriptId: 10,
    flowId: 500,
    nodeId: "director-node-1",
    targetType: "storyboard",
    targetId: 101,
    assetType: "cameraShot",
    name: "Camera A",
    promptFragment: "wide camera reference",
    base64Data: `data:image/png;base64,${image.toString("base64")}`,
    sourceRefs: [{ source: "storyboard", sourceId: 101, order: 0, label: "P1" }],
    camera: { id: "camera-a", fov: 45 },
    stageDraft: { objects: [{ id: "actor-a" }] },
  });

  assert.equal(created.assetType, "cameraShot");
  assert.equal(created.media?.source, "directorAsset");
  assert.equal(created.media?.sourceId, created.id);
  assert.match(created.media?.path || "", /1\/directorStage\/10\/.+\.png$/);

  const row = await db("o_directorAsset").where("id", created.id).first();
  assert.equal(row.assetId, created.assetId);
  assert.equal(row.imageId, created.imageId);

  const [resolved] = await referenceService.resolveWorkbenchReferences(
    [{ id: created.id, sources: "directorAsset" }],
    { projectId: 1 },
  );
  assert.equal(resolved.filePath, created.media?.path);
  assert.equal(resolved.fileType, "image");

  const urls = await referenceService.resolveReferenceUrls([{ id: created.id, sources: "directorAsset" }]);
  assert.equal(urls[`${created.id}:directorAsset`]?.source, "directorAsset");
  assert.equal(urls[`${created.id}:directorAsset`]?.sourceId, created.id);
});

test("asset media type is inferred without changing reference order", async () => {
  await u.oss.writeFile("/1/assets/voice.wav", Buffer.from("RIFF0000WAVE"));
  await u.oss.writeFile("/1/assets/clip.mp4", Buffer.from("video"));
  const [audioImageId] = await db("o_image").insert({ assetsId: 301, filePath: "/1/assets/voice.wav", type: "audio" });
  const [videoImageId] = await db("o_image").insert({ assetsId: 302, filePath: "/1/assets/clip.mp4", type: "clip" });
  await db("o_assets").insert([
    { id: 301, projectId: 1, imageId: audioImageId, name: "声音", type: "audio" },
    { id: 302, projectId: 1, imageId: videoImageId, name: "视频", type: "clip" },
  ]);
  const resolved = await referenceService.resolveWorkbenchReferences(
    [
      { id: 302, sources: "assets" },
      { id: 301, sources: "assets" },
    ],
    { projectId: 1 },
  );
  assert.deepEqual(
    resolved.map((item: any) => item.fileType),
    ["video", "audio"],
  );
});

test("asset merged reference uses database categories and parent-child labels", async () => {
  const [roleImageId] = await db("o_image").insert({ assetsId: 311, filePath: "/1/storyboard/red.png", type: "image" });
  const [sceneImageId] = await db("o_image").insert({ assetsId: 312, filePath: "/1/storyboard/blue.png", type: "image" });
  const [toolImageId] = await db("o_image").insert({ assetsId: 313, filePath: "/1/storyboard/red.png", type: "image" });
  await db("o_assets").insert([
    { id: 310, projectId: 1, name: "林若溪", type: "role" },
    { id: 311, projectId: 1, assetsId: 310, imageId: roleImageId, name: "常服", type: "role" },
    { id: 312, projectId: 1, imageId: sceneImageId, name: "菜市场", type: "scene" },
    { id: 313, projectId: 1, imageId: toolImageId, name: "竹篮", type: "tool" },
  ]);
  const result = await mergedService.createMergedReference({
    projectId: 1,
    scriptId: 10,
    trackId: 100,
    mergeType: "assets",
    refs: [
      { id: 313, sources: "assets", order: 0, category: "role", label: "wrong" },
      { id: 312, sources: "assets", order: 1, category: "tool", label: "wrong" },
      { id: 311, sources: "assets", order: 2, category: "scene", label: "wrong" },
    ],
  });
  const row = await db("o_workbenchMergedReference").where("id", result.id).first();
  const sourceRefs = JSON.parse(row.sourceRefs);
  assert.deepEqual(
    sourceRefs.map((item: any) => item.category),
    ["tool", "scene", "role"],
  );
  assert.equal(sourceRefs.find((item: any) => item.id === 311).label, "林若溪+常服");
  assert.equal(await u.oss.fileExists(row.filePath), true);
});

test("merged reference validation rejects duplicate and cross-project inputs", async () => {
  await assert.rejects(
    mergedService.createMergedReference({
      projectId: 1,
      scriptId: 10,
      trackId: 100,
      mergeType: "storyboard",
      refs: [
        { id: 101, sources: "storyboard", order: 0 },
        { id: 101, sources: "storyboard", order: 1 },
      ],
    }),
    /重复素材/,
  );
  await assert.rejects(
    mergedService.createMergedReference({
      projectId: 1,
      scriptId: 10,
      trackId: 100,
      mergeType: "storyboard",
      refs: [
        { id: 101, sources: "storyboard", order: 0 },
        { id: 201, sources: "storyboard", order: 1 },
      ],
    }),
    /不属于当前项目/,
  );
});

test("track archive and project cleanup update records and files", async () => {
  const active = await db("o_workbenchMergedReference").where({ trackId: 100, state: "active" }).first();
  await referenceService.archiveMergedReferencesForTrack(100);
  assert.equal((await db("o_workbenchMergedReference").where("id", active.id).first()).state, "archived");
  assert.equal(await u.oss.fileExists(active.filePath), true);
  await referenceService.deleteMergedReferences({ projectId: 1 });
  assert.equal(await db("o_workbenchMergedReference").where("projectId", 1).count({ count: "*" }).first().then((row: any) => Number(row.count)), 0);
  assert.equal(await u.oss.fileExists(active.filePath), false);
});
