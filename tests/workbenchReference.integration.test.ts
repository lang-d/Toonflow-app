import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
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
  u = (await import("../src/utils")).default;
  db = (await import("../src/utils/db")).db;
  mergedService = await import("../src/services/workbenchMergedReference");
  referenceService = await import("../src/services/workbenchReference");
  directorAssetService = await import("../src/services/directorAsset");

  await db.schema.createTable("o_project", (table: any) => {
    table.integer("id").primary();
    table.string("videoModel");
    table.text("mode");
    table.string("artStyle");
  });
  await db.schema.createTable("o_script", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
  });
  await db.schema.createTable("o_videoTrack", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("archived").defaultTo(0);
    table.string("state");
    table.string("reason");
    table.integer("duration");
    table.integer("videoId");
    table.string("groupKey");
    table.string("groupName");
    table.string("groupIntent");
    table.text("groupPlanJson");
    table.text("musicPlanJson");
    table.string("reviewState");
    table.text("reviewIssuesJson");
    table.text("prompt");
  });
  await db.schema.createTable("o_storyboard", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("trackId");
    table.integer("index");
    table.string("filePath");
    table.string("videoDesc");
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
    table.string("sceneContinuityId");
    table.text("referenceImages").defaultTo("[]");
    table.string("tableRowJson");
    table.string("factStatus");
    table.integer("factVersion");
    table.string("groupKey");
    table.string("groupName");
    table.string("groupIntent");
    table.string("beatId");
    table.integer("shouldGenerateImage");
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
  await db.schema.createTable("o_assetsRole2Audio", (table: any) => {
    table.integer("assetsRoleId");
    table.integer("assetsAudioId");
  });
  await db.schema.createTable("o_video", (table: any) => {
    table.increments("id");
    table.integer("videoTrackId");
    table.integer("scriptId");
    table.integer("projectId");
    table.string("filePath");
    table.string("state");
    table.string("errorReason");
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
  await db.schema.createTable("o_modelPrompt", (table: any) => {
    table.string("vendorId");
    table.string("model");
    table.string("path");
  });
  await db.schema.createTable("o_prompt", (table: any) => {
    table.string("type");
    table.text("data");
    table.text("useData");
  });

  await db("o_project").insert([
    { id: 1, videoModel: "dreamina:seedance", mode: JSON.stringify(["imageReference:9", "audioReference:3"]) },
    { id: 2, videoModel: "dreamina:seedance", mode: JSON.stringify(["imageReference:9", "audioReference:3"]) },
  ]);
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
  const tallYellow = await sharp({ create: { width: 90, height: 160, channels: 3, background: "#ffff00" } }).png().toBuffer();
  const tallPurple = await sharp({ create: { width: 90, height: 160, channels: 3, background: "#8000ff" } }).png().toBuffer();
  await u.oss.writeFile("/1/storyboard/red.png", red);
  await u.oss.writeFile("/1/storyboard/blue.png", blue);
  await u.oss.writeFile("/1/storyboard/tall-yellow.png", tallYellow);
  await u.oss.writeFile("/1/storyboard/tall-purple.png", tallPurple);
  await u.oss.writeFile("/2/storyboard/green.png", green);
  await db("o_storyboard").insert([
    { id: 101, projectId: 1, scriptId: 10, trackId: 100, index: 0, filePath: "/1/storyboard/red.png", videoDesc: "red" },
    { id: 102, projectId: 1, scriptId: 10, trackId: 100, index: 1, filePath: "/1/storyboard/blue.png", videoDesc: "blue" },
    { id: 103, projectId: 1, scriptId: 10, trackId: 100, index: 2, filePath: "/1/storyboard/tall-yellow.png", videoDesc: "yellow" },
    { id: 104, projectId: 1, scriptId: 10, trackId: 100, index: 3, filePath: "/1/storyboard/tall-purple.png", videoDesc: "purple" },
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

test("storyboard merged reference covers narrow frames to avoid white gutters", async () => {
  const result = await mergedService.createMergedReference({
    projectId: 1,
    scriptId: 10,
    trackId: 100,
    mergeType: "storyboard",
    refs: [
      { id: 103, sources: "storyboard", order: 0, label: "P3" },
      { id: 104, sources: "storyboard", order: 1, label: "P4" },
    ],
  });
  const row = await db("o_workbenchMergedReference").where("id", result.id).first();
  const output = await u.oss.getFile(row.filePath);
  const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  assert.ok(info.width <= 8192);
  assert.ok(info.height <= 8192);
  const pixel = (x: number, y: number) => {
    const offset = (y * info.width + x) * info.channels;
    return [data[offset], data[offset + 1], data[offset + 2]];
  };
  const leftEdge = pixel(34, 284);
  const secondEdge = pixel(414, 284);
  assert.ok(leftEdge[0] > 200 && leftEdge[1] > 200 && leftEdge[2] < 80, `expected covered yellow edge, got ${leftEdge}`);
  assert.ok(secondEdge[0] > 80 && secondEdge[2] > 180 && secondEdge[1] < 80, `expected covered purple edge, got ${secondEdge}`);
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

test("private audio upload stores a local media ref without creating assets", async () => {
  const uploadMediaRoute = (await import("../src/routes/production/editImage/uploadMedia")).default;
  const assetCountBefore = await db("o_assets").count({ count: "*" }).first().then((row: any) => Number(row.count));
  const imageCountBefore = await db("o_image").count({ count: "*" }).first().then((row: any) => Number(row.count));
  const dataUrl = `data:audio/wav;base64,${Buffer.from("RIFF0000WAVE").toString("base64")}`;

  const response = await postRoute(uploadMediaRoute, {
    projectId: 1,
    scriptId: 10,
    type: "audio",
    base64Data: dataUrl,
    name: "clip.wav",
  });

  assert.equal(response.status, 200);
  const media = response.body.data.media;
  assert.equal(media.type, "audio");
  assert.equal(media.source, "local");
  assert.equal(media.id, media.path);
  assert.equal(media.sourceId, media.path);
  assert.equal(media.previewUrl, media.url);
  assert.match(media.path, /^1\/imageFlow\/10\/media\/.+\.wav$/);
  assert.equal(await u.oss.fileExists(media.path), true);
  assert.equal(await db("o_assets").count({ count: "*" }).first().then((row: any) => Number(row.count)), assetCountBefore);
  assert.equal(await db("o_image").count({ count: "*" }).first().then((row: any) => Number(row.count)), imageCountBefore);
});

test("local private audio references resolve only inside the current project script media directory", async () => {
  const audioPath = "1/imageFlow/10/media/private-voice.wav";
  await u.oss.writeFile(audioPath, Buffer.from("RIFF0000WAVE"));

  const [resolved] = await referenceService.resolveWorkbenchReferences(
    [{ id: audioPath, sources: "local" }],
    { projectId: 1, scriptId: 10 },
  );
  assert.equal(resolved.id, audioPath);
  assert.equal(resolved.sources, "local");
  assert.equal(resolved.filePath, audioPath);
  assert.equal(resolved.fileType, "audio");

  await assert.rejects(
    referenceService.resolveWorkbenchReferences([{ id: audioPath, sources: "local" }], { projectId: 2, scriptId: 10 }),
    /不属于当前项目或剧集/,
  );
  await assert.rejects(
    referenceService.resolveWorkbenchReferences([{ id: "1/assets/voice.wav", sources: "local" }], { projectId: 1, scriptId: 10 }),
    /不属于当前项目或剧集/,
  );
});

test("workbench data exposes storyboard private audio references as local track media", async () => {
  const getGenerateDataRoute = (await import("../src/routes/production/workbench/getGenerateData")).default;
  const audioPath = "1/imageFlow/10/media/storyboard-private.wav";
  await u.oss.writeFile(audioPath, Buffer.from("RIFF0000WAVE"));
  await db("o_storyboard").where("id", 101).update({
    referenceImages: JSON.stringify([
      {
        id: audioPath,
        source: "local",
        sourceId: audioPath,
        url: await u.oss.getFileUrl(audioPath),
        previewUrl: await u.oss.getFileUrl(audioPath),
        name: "台词片段",
        type: "audio",
      },
    ]),
  });

  const response = await postRoute(getGenerateDataRoute, { projectId: 1, scriptId: 10 });
  assert.equal(response.status, 200);
  const track = response.body.data.trackList.find((item: any) => item.id === 100);
  const audio = track.medias.find((item: any) => item.sources === "local" && item.fileType === "audio");
  assert.ok(audio);
  assert.equal(audio.id, audioPath);
  assert.equal(audio.media.path, audioPath);
  assert.equal(audio.media.source, "local");
  assert.equal(audio.media.sourceId, audioPath);
});

test("manual addTrack creates a complete empty video group without video model lookup", async () => {
  const addTrackRoute = (await import("../src/routes/production/workbench/addTrack")).default;
  await db("o_project").insert({ id: 3, mode: JSON.stringify([]) });
  await db("o_script").insert({ id: 30, projectId: 3 });

  const response = await postRoute(addTrackRoute, {
    projectId: 3,
    scriptId: 30,
    duration: 5,
    groupName: "Manual Cut",
    groupIntent: "User controlled group",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.trackId, response.body.data.track.id);
  assert.equal(response.body.data.track.duration, 5);
  assert.equal(response.body.data.track.groupName, "Manual Cut");
  assert.equal(response.body.data.track.groupIntent, "User controlled group");
  assert.match(response.body.data.track.groupKey, /^manual-\d+$/);
  assert.equal(response.body.data.track.state, "未生成");
  assert.deepEqual(response.body.data.track.medias, []);
  assert.deepEqual(response.body.data.track.videoList, []);

  const row = await db("o_videoTrack").where({ id: response.body.data.trackId }).first();
  assert.equal(row.projectId, 3);
  assert.equal(row.scriptId, 30);
  assert.equal(row.archived, 0);
  assert.equal(row.reviewState, "pending");
  assert.deepEqual(JSON.parse(row.reviewIssuesJson), []);
});

test("manual addTrack can move storyboards into the new video group and derive duration", async () => {
  const addTrackRoute = (await import("../src/routes/production/workbench/addTrack")).default;
  await db("o_storyboard").insert([
    { id: 901, projectId: 1, scriptId: 10, trackId: 100, index: 901, duration: "1.5", filePath: "/1/storyboard/red.png" },
    { id: 902, projectId: 1, scriptId: 10, trackId: 100, index: 902, duration: "2", filePath: "/1/storyboard/blue.png" },
  ]);

  const response = await postRoute(addTrackRoute, {
    projectId: 1,
    scriptId: 10,
    groupName: "Picked Storyboards",
    storyboardIds: [901, 902],
  });

  assert.equal(response.status, 200);
  const track = response.body.data.track;
  assert.equal(track.duration, 3.5);
  assert.equal(track.groupName, "Picked Storyboards");
  assert.match(track.groupKey, /^manual-\d+$/);

  const rows = await db("o_storyboard").whereIn("id", [901, 902]).orderBy("id", "asc");
  assert.deepEqual(
    rows.map((row: any) => ({
      id: row.id,
      trackId: row.trackId,
      groupKey: row.groupKey,
      groupName: row.groupName,
      groupIntent: row.groupIntent,
    })),
    [
      { id: 901, trackId: track.id, groupKey: track.groupKey, groupName: "Picked Storyboards", groupIntent: "" },
      { id: 902, trackId: track.id, groupKey: track.groupKey, groupName: "Picked Storyboards", groupIntent: "" },
    ],
  );
});

test("workbench data returns video groups in stable id order", async () => {
  const addTrackRoute = (await import("../src/routes/production/workbench/addTrack")).default;
  const getGenerateDataRoute = (await import("../src/routes/production/workbench/getGenerateData")).default;
  const response = await postRoute(addTrackRoute, {
    projectId: 1,
    scriptId: 10,
    duration: 4,
    groupName: "Ordering Check",
  });
  assert.equal(response.status, 200);

  const dataResponse = await postRoute(getGenerateDataRoute, { projectId: 1, scriptId: 10 });
  assert.equal(dataResponse.status, 200);
  const ids = dataResponse.body.data.trackList.map((item: any) => item.id);
  assert.deepEqual(ids, [...ids].sort((a: number, b: number) => a - b));
  assert.ok(ids.includes(response.body.data.trackId));
});

test("workbench data exposes model reference tokens for media list", async () => {
  const getGenerateDataRoute = (await import("../src/routes/production/workbench/getGenerateData")).default;
  const dataResponse = await postRoute(getGenerateDataRoute, { projectId: 1, scriptId: 10 });
  assert.equal(dataResponse.status, 200);
  const track = dataResponse.body.data.trackList.find((item: any) => item.id === 100);
  assert.ok(track);
  const imageMedias = track.medias.filter((item: any) => item.fileType === "image");
  assert.ok(imageMedias.length >= 2);
  assert.equal(imageMedias[0].visualToken, "@Image1");
  assert.equal(imageMedias[0].referenceToken, "@Image1");
  assert.equal(imageMedias[1].visualToken, "@Image2");
});

test("video prompt token block keeps audio outside image numbering", async () => {
  const { buildReferenceTokenBlock } = await import("../src/services/videoPromptCompiler");
  const items: any[] = [1, 2, 3, 4, 5, 6]
    .map((n): any => ({
      item: { fileType: "image", name: `参考${n}`, sources: n === 6 ? "merged" : "assets", category: n === 2 ? "role" : "image" },
      meta: { inputOrder: n, visualImageIndex: n },
    }))
    .concat(
      [1, 2, 3].map((n): any => ({
        item: { fileType: "audio", name: `音频${n}`, sources: "assets" },
        meta: { inputOrder: 6 + n, audioReferenceIndex: n },
      })),
    );
  const text = buildReferenceTokenBlock(items as any);
  for (const n of [1, 2, 3, 4, 5, 6]) assert.match(text, new RegExp(`- @Image${n}:`));
  assert.doesNotMatch(text, /- @Image7:/);
  assert.match(text, /不得生成 @Image7/);
  assert.match(text, /参考音频1/);
});

test("video prompt context keeps audio out of visual @Image numbering", async () => {
  const { compileWorkbenchVideoPrompt } = await import("../src/services/videoPromptCompiler");
  const audioPath = "1/imageFlow/10/media/prompt-private.wav";
  await u.oss.writeFile(audioPath, Buffer.from("RIFF0000WAVE"));
  const readyFact = {
    version: 1,
    index: 0,
    durationSec: 3,
    location: "厨房",
    timeOfDay: "清晨",
    picture: "角色站在窗边",
    action: "角色看向桌面",
    shotSize: "中景",
    cameraMove: "固定",
    characters: [],
    dialogue: [],
    soundEffects: ["水壶声"],
    requiredAssets: [],
  };
  await db("o_videoTrack").insert({ id: 300, projectId: 1, scriptId: 10, archived: 0 });
  await db("o_storyboard").insert({
    id: 301,
    projectId: 1,
    scriptId: 10,
    trackId: 300,
    index: 0,
    filePath: "/1/storyboard/red.png",
    tableRowJson: JSON.stringify(readyFact),
    factStatus: "ready",
  });
  await db("o_prompt").insert({ type: "videoPromptGeneration", data: "Return target video prompt only." });
  const originalAi = u.Ai;
  u.Ai = {
    ...u.Ai,
    Text: () => ({
      invoke: async () => ({ text: "厨房中景，角色看向桌面，水壶声。" }),
    }),
  };
  try {
    const result = await compileWorkbenchVideoPrompt({
      projectId: 1,
      scriptId: 10,
      trackId: 300,
      references: [
        { id: audioPath, sources: "local" },
        { id: 101, sources: "storyboard" },
        { id: 301, sources: "storyboard" },
      ],
      model: "dreamina:seedance",
      mode: JSON.stringify(["imageReference:2", "audioReference:1"]),
    });
    assert.match(result.promptContext, /audioReferenceIndex='1'/);
    assert.match(result.promptContext, /不得写成 @ImageN/);
    assert.match(result.promptContext, /visualToken='@Image1'[\s\S]*referenceId='101'/);
    assert.match(result.promptContext, /visualToken='@Image2'[\s\S]*referenceId='301'/);
    const audioBlock = result.promptContext.match(/<audioReference[\s\S]*?<\/audioReference>/)?.[0] || "";
    assert.doesNotMatch(audioBlock, /visualToken='@Image/);
  } finally {
    u.Ai = originalAi;
  }
});

test("video prompt retries once when reference definition misses an image token", async () => {
  const { compileWorkbenchVideoPrompt } = await import("../src/services/videoPromptCompiler");
  const readyFact = {
    version: 1,
    index: 0,
    durationSec: 3,
    location: "玄关",
    timeOfDay: "清晨",
    picture: "角色站在门口",
    action: "角色停顿",
    shotSize: "中景",
    cameraMove: "固定",
    characters: [],
    dialogue: [],
    soundEffects: [],
    requiredAssets: [],
  };
  await db("o_videoTrack").insert({ id: 310, projectId: 1, scriptId: 10, archived: 0 });
  await db("o_storyboard").insert({
    id: 311,
    projectId: 1,
    scriptId: 10,
    trackId: 310,
    index: 0,
    filePath: "/1/storyboard/red.png",
    tableRowJson: JSON.stringify(readyFact),
    factStatus: "ready",
  });
  const originalAi = u.Ai;
  let calls = 0;
  u.Ai = {
    ...u.Ai,
    Text: () => ({
      invoke: async () => {
        calls += 1;
        return {
          text:
            calls === 1
              ? "参考定义:\n@Image1: P1，用于角色外观。"
              : "参考定义:\n@Image1: P1，用于角色外观。\n@Image2: P2，用于场景空间。",
        };
      },
    }),
  };
  try {
    const result = await compileWorkbenchVideoPrompt({
      projectId: 1,
      scriptId: 10,
      trackId: 310,
      references: [
        { id: 101, sources: "storyboard" },
        { id: 311, sources: "storyboard" },
      ],
      model: "dreamina:seedance",
      mode: JSON.stringify(["imageReference:2"]),
    });
    assert.equal(calls, 2);
    assert.match(result.text, /@Image2/);
    assert.equal(result.engineeringIssues.some((issue: any) => issue.severity === "blocking"), false);
  } finally {
    u.Ai = originalAi;
  }
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

test("asset merged reference still contains narrow assets without cropping", async () => {
  const [yellowImageId] = await db("o_image").insert({ assetsId: 321, filePath: "/1/storyboard/tall-yellow.png", type: "image" });
  const [purpleImageId] = await db("o_image").insert({ assetsId: 322, filePath: "/1/storyboard/tall-purple.png", type: "image" });
  await db("o_assets").insert([
    { id: 321, projectId: 1, imageId: yellowImageId, name: "Tall Yellow", type: "role" },
    { id: 322, projectId: 1, imageId: purpleImageId, name: "Tall Purple", type: "role" },
  ]);
  const result = await mergedService.createMergedReference({
    projectId: 1,
    scriptId: 10,
    trackId: 100,
    mergeType: "assets",
    refs: [
      { id: 321, sources: "assets", order: 0 },
      { id: 322, sources: "assets", order: 1 },
    ],
  });
  const row = await db("o_workbenchMergedReference").where("id", result.id).first();
  const output = await u.oss.getFile(row.filePath);
  const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  const offset = (360 * info.width + 34) * info.channels;
  const edge = [data[offset], data[offset + 1], data[offset + 2]];
  assert.ok(edge[0] > 240 && edge[1] > 240 && edge[2] > 240, `expected contained asset white edge, got ${edge}`);
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
