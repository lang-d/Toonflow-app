import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-api-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let u: any;
let rawDb: any;
let imageFlow: typeof import("../src/services/imageFlow");
let imageFlowMigration: typeof import("../src/lib/migrations/imageFlowContractV2");
let storyboardEditor: typeof import("../src/services/storyboardEditor");
let storyboardMigration: typeof import("../src/lib/migrations/storyboardEditorContractV1");
let assetImageHistory: typeof import("../src/services/assetImageHistory");

async function createTestSchema() {
  await rawDb.schema.createTable("o_imageFlow", (table: any) => {
    table.increments("id");
    table.text("flowData");
  });
  await rawDb.schema.createTable("o_assets", (table: any) => {
    table.integer("id").primary();
    table.string("name");
    table.string("type");
    table.integer("assetsId");
    table.integer("projectId");
    table.integer("flowId");
    table.integer("imageId");
  });
  await rawDb.schema.createTable("o_image", (table: any) => {
    table.increments("id");
    table.string("filePath");
    table.string("state");
    table.string("type");
    table.integer("assetsId");
    table.string("model");
    table.string("resolution");
    table.integer("createTime");
    table.integer("updateTime");
  });
  await rawDb.schema.createTable("o_storyboard", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("flowId");
    table.string("filePath");
    table.integer("updateTime");
    table.string("prompt");
    table.string("videoDesc");
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
    table.text("tableRowJson");
    table.string("factStatus");
    table.integer("factVersion");
    table.integer("factRevision");
    table.integer("index");
    table.string("groupKey");
    table.string("groupName");
    table.string("groupIntent");
    table.string("beatId");
    table.string("duration");
    table.string("state");
    table.integer("trackId");
    table.integer("shouldGenerateImage");
    table.text("referenceImages").defaultTo("[]");
  });
  await rawDb.schema.createTable("o_assets2Storyboard", (table: any) => {
    table.integer("storyboardId");
    table.integer("assetId");
    table.unique(["storyboardId", "assetId"]);
  });
  await rawDb.schema.createTable("o_videoTrack", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("duration");
  });
  await rawDb.schema.createTable("o_editImageTask", (table: any) => {
    table.increments("id");
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("deriveAssetId");
    table.string("targetType");
    table.integer("targetId");
    table.integer("flowId");
    table.string("nodeId");
    table.text("references");
    table.string("model");
    table.string("quality");
    table.string("ratio");
    table.text("prompt");
    table.string("status");
    table.string("state");
    table.string("url");
    table.string("reason");
    table.integer("taskCenterId");
    table.integer("createTime");
    table.integer("updateTime");
  });
  await rawDb.schema.createTable("o_tasks", (table: any) => {
    table.increments("id");
    table.string("taskId");
    table.string("businessType");
    table.integer("businessId");
    table.string("status");
    table.string("state");
    table.string("reason");
    table.text("resultJson");
    table.integer("finishTime");
    table.string("model");
    table.integer("updateTime");
  });
  await rawDb.schema.createTable("o_setting", (table: any) => {
    table.string("key").primary();
    table.string("value");
  });
}

before(async () => {
  u = (await import("../src/utils")).default;
  rawDb = (await import("../src/utils/db")).db;
  imageFlow = await import("../src/services/imageFlow");
  imageFlowMigration = await import("../src/lib/migrations/imageFlowContractV2");
  storyboardEditor = await import("../src/services/storyboardEditor");
  storyboardMigration = await import("../src/lib/migrations/storyboardEditorContractV1");
  assetImageHistory = await import("../src/services/assetImageHistory");
  await createTestSchema();
});

after(async () => {
  await rawDb?.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("flow upsert updates its target in one transaction", async () => {
  await u.db("o_assets").insert({ id: 501, type: "role", projectId: 100 });

  const flowId = await imageFlow.saveImageFlow({
    projectId: 100,
    scriptId: 2,
    targetType: "deriveAsset",
    targetId: 501,
    nodes: [
      {
        id: "node-a",
        type: "generated",
        data: { prompt: "first", generatedImage: "/100/imageFlow/2/result.jpg" },
      },
    ],
    edges: [],
    selectedImageUrl: "/100/imageFlow/2/result.jpg",
  });

  const target = await u.db("o_assets").where("id", 501).first();
  assert.equal(target.flowId, flowId);
  assert.ok(target.imageId);
  const targetImage = await u.db("o_image").where("id", target.imageId).first();
  assert.equal(targetImage.state, "已完成");

  const updatedId = await imageFlow.saveImageFlow({
    flowId,
    projectId: 100,
    scriptId: 2,
    targetType: "deriveAsset",
    targetId: 501,
    nodes: [
      { id: "upload-a", type: "upload", data: { image: "/refs/a.jpg" } },
      {
        id: "node-a",
        type: "generated",
        data: { prompt: "updated", generatedImage: "/100/imageFlow/2/result.jpg" },
      },
    ],
    edges: [{ id: "edge-a", source: "upload-a", target: "node-a" }],
  });
  assert.equal(updatedId, flowId);

  const stored = await u.db("o_imageFlow").where("id", flowId).first();
  const flowData = JSON.parse(stored.flowData);
  assert.equal(flowData.nodes.find((node: any) => node.id === "node-a").data.prompt, "updated");
  assert.equal(flowData.edges.length, 1);
  const imageCount = await u.db("o_image").where("assetsId", 501).count({ count: "*" }).first();
  assert.equal(Number(imageCount.count), 1);
});

test("flow save without explicit final image does not revalidate stale selected image", async () => {
  const [flowId] = await u.db("o_imageFlow").insert({
    flowData: JSON.stringify({
      projectId: 100,
      scriptId: 2,
      targetType: "storyboard",
      targetId: 702,
      selectedImageUrl: "stale/final.jpg",
      nodes: [{ id: "old-node", type: "generated", data: { generatedImage: "/old/node.jpg" } }],
      edges: [],
    }),
  });
  await u.db("o_storyboard").insert({
    id: 702,
    projectId: 100,
    scriptId: 2,
    flowId,
    filePath: "/storyboard/current.jpg",
    referenceImages: "[]",
  });

  const updatedId = await imageFlow.saveImageFlow({
    flowId,
    projectId: 100,
    scriptId: 2,
    targetType: "storyboard",
    targetId: 702,
    nodes: [
      {
        id: "asset-result-node",
        type: "generated",
        data: {
          generatedImage: "/asset/new-reference.jpg",
          resultMedia: { path: "/asset/new-reference.jpg", url: "/asset/new-reference.jpg", type: "image" },
          selectedResult: { url: "/asset/new-reference.jpg" },
        },
      },
    ],
    edges: [],
  });

  assert.equal(updatedId, flowId);
  const stored = JSON.parse((await u.db("o_imageFlow").where("id", flowId).first()).flowData);
  assert.equal(stored.selectedImageUrl, "stale/final.jpg");
  assert.equal(stored.nodes[0].data.generatedImage, "asset/new-reference.jpg");
  const storyboard = await u.db("o_storyboard").where("id", 702).first();
  assert.equal(storyboard.filePath, "/storyboard/current.jpg");
});

test("multiple generated nodes keep independent task state", async () => {
  const flowId = await imageFlow.saveImageFlow({
    nodes: [
      { id: "node-1", type: "generated", data: {} },
      { id: "node-2", type: "generated", data: {} },
    ],
    edges: [],
  });

  assert.equal(await imageFlow.updateImageFlowNode(flowId, "node-1", { taskId: 11, status: "processing" }), true);
  assert.equal(await imageFlow.updateImageFlowNode(flowId, "node-2", { taskId: 12, status: "failed", reason: "test" }), true);

  const stored = await u.db("o_imageFlow").where("id", flowId).first();
  const nodes = JSON.parse(stored.flowData).nodes;
  assert.deepEqual(
    nodes.map((node: any) => ({ id: node.id, taskId: node.data.taskId, status: node.data.status })),
    [
      { id: "node-1", taskId: 11, status: "processing" },
      { id: "node-2", taskId: 12, status: "failed" },
    ],
  );
});

test("stale processing save cannot overwrite a completed database result", async () => {
  const flowId = await imageFlow.saveImageFlow({
    nodes: [{ id: "merge-node", type: "generated", position: { x: 1, y: 1 }, data: { prompt: "old" } }],
    edges: [],
  });
  await imageFlow.updateImageFlowNode(flowId, "merge-node", {
    taskId: null,
    status: "completed",
    state: "success",
    generatedImage: "/history/completed.jpg",
    historyId: 91,
    selectedResult: { id: 91, url: "/history/completed.jpg" },
  });

  await imageFlow.saveImageFlow({
    flowId,
    nodes: [
      {
        id: "merge-node",
        type: "generated",
        position: { x: 20, y: 30 },
        data: { prompt: "new prompt", taskId: 91, status: "processing", state: "generating" },
      },
    ],
    edges: [],
  });

  const stored = await u.db("o_imageFlow").where("id", flowId).first();
  const node = JSON.parse(stored.flowData).nodes[0];
  assert.equal(node.position.x, 20);
  assert.equal(node.data.prompt, "new prompt");
  assert.equal(node.data.status, "completed");
  assert.equal(node.data.taskId, null);
  assert.equal(node.data.generatedImage, "history/completed.jpg");
  assert.equal(node.data.historyId, 91);
});

test("an omitted active node and its connected upload are preserved", async () => {
  const flowId = await imageFlow.saveImageFlow({
    nodes: [
      { id: "active-upload", type: "upload", position: { x: 1, y: 1 }, data: { image: "/refs/a.jpg" } },
      { id: "active-node", type: "generated", position: { x: 2, y: 2 }, data: { prompt: "active" } },
      { id: "other-node", type: "generated", position: { x: 3, y: 3 }, data: { prompt: "other" } },
    ],
    edges: [{ id: "active-edge", source: "active-upload", target: "active-node" }],
  });
  await u.db("o_editImageTask").insert({
    id: 201,
    flowId,
    nodeId: "active-node",
    status: "processing",
    state: "生成中",
    references: "[]",
    createTime: Date.now(),
  });
  await imageFlow.updateImageFlowNode(flowId, "active-node", {
    taskId: 201,
    status: "processing",
    state: "generating",
  });

  await imageFlow.saveImageFlow({
    flowId,
    nodes: [{ id: "other-node", type: "generated", position: { x: 30, y: 30 }, data: { prompt: "updated" } }],
    edges: [],
  });

  const stored = await u.db("o_imageFlow").where("id", flowId).first();
  const flow = JSON.parse(stored.flowData);
  assert.deepEqual(
    flow.nodes.map((node: any) => node.id).sort(),
    ["active-node", "active-upload", "other-node"],
  );
  assert.equal(flow.nodes.find((node: any) => node.id === "active-node").data.taskId, 201);
  assert.equal(flow.edges.some((edge: any) => edge.id === "active-edge"), true);
});

test("manual history selection without an active task remains saveable", async () => {
  const flowId = await imageFlow.saveImageFlow({
    nodes: [
      {
        id: "manual-node",
        type: "generated",
        position: { x: 1, y: 1 },
        data: { status: "completed", generatedImage: "/history/old.jpg", selectedResult: { url: "/history/old.jpg" } },
      },
    ],
    edges: [],
  });
  await imageFlow.saveImageFlow({
    flowId,
    nodes: [
      {
        id: "manual-node",
        type: "generated",
        position: { x: 1, y: 1 },
        data: {
          status: "completed",
          state: "success",
          taskId: null,
          generatedImage: "/history/new.jpg",
          historyId: 302,
          selectedResult: { id: 302, url: "/history/new.jpg" },
        },
      },
    ],
    edges: [],
  });
  const stored = await u.db("o_imageFlow").where("id", flowId).first();
  const node = JSON.parse(stored.flowData).nodes[0];
  assert.equal(node.data.generatedImage, "history/new.jpg");
  assert.equal(node.data.historyId, 302);
});

test("image history is isolated by targetType and targetId", async () => {
  const common = {
    projectId: 100,
    scriptId: 2,
    state: "已完成",
    status: "completed",
    nodeId: "history-node",
    references: "[]",
    model: "vendor:model",
    quality: "2K",
    ratio: "16:9",
    prompt: "history",
    createTime: Date.now(),
    updateTime: Date.now(),
  };
  await u.db("o_editImageTask").insert([
    { ...common, targetType: "deriveAsset", targetId: 1501, deriveAssetId: 1501, url: "/history/asset.jpg" },
    { ...common, targetType: "storyboard", targetId: 701, url: "/history/storyboard.jpg" },
  ]);

  const assetHistory = await imageFlow.getImageHistory({
    projectId: 100,
    scriptId: 2,
    targetType: "deriveAsset",
    targetId: 1501,
  });
  const storyboardHistory = await imageFlow.getImageHistory({
    projectId: 100,
    scriptId: 2,
    targetType: "storyboard",
    targetId: 701,
  });

  assert.equal(assetHistory.length, 1);
  assert.match(assetHistory[0].url, /asset\.jpg/);
  assert.ok(assetHistory[0].media);
  assert.equal(assetHistory[0].media.path, "history/asset.jpg");
  assert.doesNotMatch(assetHistory[0].media.url, /size=20/);
  assert.match(assetHistory[0].media.previewUrl || "", /size=20/);
  assert.equal(storyboardHistory.length, 1);
  assert.match(storyboardHistory[0].url, /storyboard\.jpg/);
  assert.ok(storyboardHistory[0].media);
  assert.equal(storyboardHistory[0].media.path, "history/storyboard.jpg");
});

test("image history merges target-specific storyboard and asset sources", async () => {
  await u.db("o_storyboard").insert({
    id: 870,
    projectId: 100,
    scriptId: 2,
    prompt: "storyboard prompt",
    filePath: "/100/storyboard/current.jpg",
    state: "completed",
    updateTime: 3000,
    referenceImages: "[]",
  });
  await u.db("o_editImageTask").insert({
    projectId: 100,
    scriptId: 2,
    targetType: "storyboard",
    targetId: 870,
    status: "completed",
    state: "completed",
    url: "/100/storyboard/flow.jpg",
    prompt: "flow prompt",
    nodeId: "story-node",
    createTime: 1000,
    updateTime: 1000,
  });
  await u.db("o_tasks").insert({
    taskId: "story-direct",
    businessType: "storyboard",
    businessId: 870,
    status: "completed",
    resultJson: JSON.stringify({ media: { path: "/100/storyboard/direct.jpg" } }),
    finishTime: 2000,
    updateTime: 2000,
  });

  const storyboardHistory = await imageFlow.getImageHistory({
    projectId: 100,
    scriptId: 2,
    targetType: "storyboard",
    targetId: 870,
  });
  assert.deepEqual(
    storyboardHistory.map((item: any) => item.media.path),
    ["100/storyboard/current.jpg", "100/storyboard/direct.jpg", "100/storyboard/flow.jpg"],
  );
  assert.deepEqual(
    storyboardHistory.map((item: any) => item.source),
    ["storyboard", "storyboard", "image-flow"],
  );

  await u.db("o_assets").insert({ id: 1870, type: "tool", projectId: 100 });
  await u.db("o_image").insert({
    assetsId: 1870,
    filePath: "/100/assets/older.jpg",
    state: "completed",
    model: "older-model",
    resolution: "1K",
    createTime: 1100,
    updateTime: 1100,
  });
  const [latestImageId] = await u.db("o_image").insert({
    assetsId: 1870,
    filePath: "/100/assets/latest.jpg",
    state: "completed",
    model: "latest-model",
    resolution: "2K",
    createTime: 2100,
    updateTime: 2100,
  });
  await u.db("o_assets").where("id", 1870).update({ imageId: latestImageId });
  await u.db("o_tasks").insert({
    taskId: "asset-latest",
    businessType: "image",
    businessId: latestImageId,
    status: "completed",
    updateTime: 2200,
  });
  await u.db("o_editImageTask").insert({
    projectId: 100,
    scriptId: 2,
    targetType: "deriveAsset",
    targetId: 1870,
    deriveAssetId: 1870,
    status: "completed",
    state: "completed",
    url: "/100/assets/flow.jpg",
    prompt: "asset flow",
    nodeId: "asset-node",
    createTime: 1200,
    updateTime: 1200,
  });

  const assetHistory = await imageFlow.getImageHistory({
    projectId: 100,
    scriptId: 2,
    targetType: "deriveAsset",
    targetId: 1870,
  });
  assert.deepEqual(
    assetHistory.map((item: any) => item.media.path),
    ["100/assets/latest.jpg", "100/assets/flow.jpg", "100/assets/older.jpg"],
  );
  assert.equal(assetHistory.find((item: any) => item.media.path === "100/assets/latest.jpg")?.taskId, "asset-latest");
  assert.equal(assetHistory.find((item: any) => item.media.path === "100/assets/older.jpg")?.source, "asset");
});

test("saveImageFlow accepts current target history images without generated node ownership", async () => {
  await u.db("o_storyboard").insert({
    id: 871,
    projectId: 100,
    scriptId: 2,
    filePath: "/100/storyboard/external.jpg",
    referenceImages: "[]",
  });
  const flowId = await imageFlow.saveImageFlow({
    projectId: 100,
    scriptId: 2,
    targetType: "storyboard",
    targetId: 871,
    nodes: [{ id: "generated-other", type: "generated", data: { generatedImage: "/100/storyboard/other-node.jpg" } }],
    edges: [],
    selectedMediaPath: "/100/storyboard/external.jpg",
  });
  const stored = JSON.parse((await u.db("o_imageFlow").where("id", flowId).first()).flowData);
  assert.equal(stored.selectedImageUrl, "100/storyboard/external.jpg");
  assert.equal(stored.nodes[0].data.isPrimary, undefined);

  await u.db("o_assets").insert({ id: 1871, type: "tool", projectId: 100 });
  await u.db("o_image").insert({
    assetsId: 1871,
    filePath: "/100/assets/external.jpg",
    state: "completed",
  });
  const assetFlowId = await imageFlow.saveImageFlow({
    projectId: 100,
    scriptId: 2,
    targetType: "deriveAsset",
    targetId: 1871,
    nodes: [{ id: "asset-generated-other", type: "generated", data: { generatedImage: "/100/assets/other-node.jpg" } }],
    edges: [],
    selectedMediaPath: "/100/assets/external.jpg",
  });
  const assetStored = JSON.parse((await u.db("o_imageFlow").where("id", assetFlowId).first()).flowData);
  assert.equal(assetStored.selectedImageUrl, "100/assets/external.jpg");
  assert.equal(assetStored.nodes[0].data.isPrimary, undefined);
});

test("saveImageFlow rejects images owned by another target", async () => {
  await u.db("o_storyboard").insert([
    { id: 872, projectId: 100, scriptId: 2, filePath: "/100/storyboard/own.jpg", referenceImages: "[]" },
    { id: 873, projectId: 100, scriptId: 2, filePath: "/100/storyboard/other-target.jpg", referenceImages: "[]" },
  ]);
  await assert.rejects(
    imageFlow.saveImageFlow({
      projectId: 100,
      scriptId: 2,
      targetType: "storyboard",
      targetId: 872,
      nodes: [],
      edges: [],
      selectedMediaPath: "/100/storyboard/other-target.jpg",
    }),
    (cause: any) =>
      cause instanceof imageFlow.ImageFlowValidationError &&
      cause.issues.some((issue: any) => issue.path === "selectedImageUrl"),
  );
});

test("asset image history returns media and the latest authoritative task status", async () => {
  let activeImageId: number;
  let completedImageId: number;
  let otherImageId: number;
  let currentTaskId: number;
  try {
    await u.db("o_assets").insert([
      { id: 1860, type: "tool", projectId: 100 },
      { id: 1861, type: "tool", projectId: 100 },
    ]);
    [activeImageId] = await u.db("o_image").insert({
      assetsId: 1860,
      type: "tool",
      state: "生成中",
      filePath: null,
    });
    [completedImageId] = await u.db("o_image").insert({
      assetsId: 1860,
      type: "tool",
      state: "已完成",
      filePath: "/100/props/latest.jpg",
    });
    [otherImageId] = await u.db("o_image").insert({
      assetsId: 1861,
      type: "tool",
      state: "已完成",
      filePath: "/100/props/other.jpg",
    });
    await u.db("o_assets").where("id", 1860).update({ imageId: completedImageId });
    await u.db("o_assets").where("id", 1861).update({ imageId: otherImageId });

    await u.db("o_tasks").insert({
      taskId: "task-old",
      businessType: "image",
      businessId: activeImageId,
      status: "queued",
      updateTime: 100,
    });
    [currentTaskId] = await u.db("o_tasks").insert({
      taskId: "task-current",
      businessType: "image",
      businessId: activeImageId,
      status: "submitting",
      updateTime: 200,
    });
    await u.db("o_tasks").insert({
      taskId: "wrong-business-type",
      businessType: "image-flow",
      businessId: completedImageId,
      status: "failed",
      updateTime: 300,
    });
  } catch (error: any) {
    assert.fail(error?.stack || error?.message || String(error));
  }

  const history = await assetImageHistory.getAssetImageHistory(1860);
  assert.ok(history);
  assert.equal(history.imageId, completedImageId);
  assert.deepEqual(history.tempAssets.map((item: any) => item.id), [completedImageId, activeImageId]);

  const completed = history.tempAssets[0];
  assert.equal(completed.status, "completed");
  assert.equal(completed.selected, true);
  assert.equal(completed.taskId, undefined);
  assert.ok(completed.media);
  assert.equal(completed.media.path, "100/props/latest.jpg");
  assert.doesNotMatch(completed.media.url, /size=20/);
  assert.match(completed.media.previewUrl || "", /size=20/);

  const active = history.tempAssets[1];
  assert.equal(active.status, "submitting");
  assert.equal(active.taskId, "task-current");
  assert.equal(active.legacyTaskId, currentTaskId);
  assert.equal(active.selected, false);
  assert.equal(active.media, null);

  const otherHistory = await assetImageHistory.getAssetImageHistory(1861);
  assert.ok(otherHistory);
  assert.deepEqual(otherHistory.tempAssets.map((item: any) => item.id), [otherImageId]);
  assert.equal(await assetImageHistory.getAssetImageHistory(999999), null);
});

test("asset image history preserves every unified task status", async () => {
  const statuses = ["queued", "submitting", "processing", "completed", "failed", "cancelled"];
  await u.db("o_assets").insert({ id: 1862, type: "tool", projectId: 100 });
  const imageIds: number[] = [];

  for (const [index, status] of statuses.entries()) {
    const [imageId] = await u.db("o_image").insert({
      assetsId: 1862,
      type: "tool",
      state: "生成中",
      filePath: status === "completed" ? `/100/props/${status}.jpg` : null,
    });
    imageIds.push(imageId);
    await u.db("o_tasks").insert({
      taskId: `task-${status}`,
      businessType: "image",
      businessId: imageId,
      status,
      updateTime: 1000 + index,
    });
  }

  const history = await assetImageHistory.getAssetImageHistory(1862);
  assert.ok(history);
  const statusByTaskId = new Map(history.tempAssets.map((item: any) => [item.taskId, item.status]));
  for (const status of statuses) {
    assert.equal(statusByTaskId.get(`task-${status}`), status);
  }
});

test("storyboard editor persists duration, ordered assets and references", async () => {
  await u.db("o_videoTrack").insert({ id: 8801, projectId: 100, scriptId: 2, duration: 0 });
  await u.db("o_storyboard").insert([
    {
      id: 801,
      projectId: 100,
      scriptId: 2,
      trackId: 8801,
      duration: "2",
      referenceImages: "[]",
    },
    {
      id: 802,
      projectId: 100,
      scriptId: 2,
      trackId: 8801,
      duration: "3",
      filePath: "/storyboard/source.jpg",
      referenceImages: "[]",
    },
  ]);
  await u.db("o_assets").insert([
    { id: 810, type: "role", projectId: 100 },
    { id: 811, type: "scene", projectId: 100 },
  ]);

  await storyboardEditor.saveStoryboardEditor({
    id: 801,
    prompt: "updated prompt",
    videoDesc: "updated description",
    duration: 6,
    associateAssetsIds: [811, 810, 811],
    referenceImages: [
      {
        id: "local-a",
        source: "local",
        sourceId: "local-a",
        url: "/uploads/original.jpg",
        previewUrl: "/uploads/original.jpg?size=20",
        label: "local",
      },
      {
        id: "storyboard-802",
        source: "storyboard",
        sourceId: 802,
        url: "/storyboard/source.jpg",
        label: "storyboard",
      },
    ],
  });

  const storyboard = await u.db("o_storyboard").where("id", 801).first();
  assert.equal(storyboard.duration, "6");
  assert.equal(JSON.parse(storyboard.referenceImages).length, 2);
  const assetIds = await u
    .db("o_assets2Storyboard")
    .where("storyboardId", 801)
    .orderBy("rowid")
    .pluck("assetId");
  assert.deepEqual(assetIds, [811, 810]);
  assert.equal((await u.db("o_videoTrack").where("id", 8801).first()).duration, 9);
});

test("storyboard editor preserves omitted scene continuity and clears explicit null", async () => {
  const tableRow = {
    version: 1,
    index: 0,
    groupKey: "group-continuity",
    groupName: "Continuity group",
    groupIntent: "Keep the scene continuous",
    beatId: "beat-continuity",
    durationSec: 3,
    location: "客厅",
    timeOfDay: "夜晚",
    sceneContinuityId: "living-room-night-01",
    picture: "角色站在窗边",
    shotSize: "中景",
    cameraMove: "固定",
    action: "角色望向窗外",
    characters: [],
    visibleEmotion: "神情平静",
    dialogue: [],
    soundEffects: [],
    requiredAssets: [],
  };
  await u.db("o_storyboard").insert({
    id: 803,
    projectId: 100,
    scriptId: 2,
    index: 0,
    duration: "3",
    prompt: "prompt",
    tableRowJson: JSON.stringify(tableRow),
    factStatus: "ready",
    factVersion: 1,
    factRevision: 1,
    referenceImages: "[]",
  });

  const baseInput = {
    id: 803,
    prompt: "updated prompt",
    videoDesc: "",
    duration: 3,
    associateAssetsIds: [],
    referenceImages: [],
  };

  await storyboardEditor.saveStoryboardEditor(baseInput);
  let storyboard = await u.db("o_storyboard").where("id", 803).first();
  assert.equal(JSON.parse(storyboard.tableRowJson).sceneContinuityId, "living-room-night-01");
  assert.equal(storyboard.sceneContinuityId, "living-room-night-01");

  await storyboardEditor.saveStoryboardEditor({
    ...baseInput,
    sceneContinuityId: null,
  });
  storyboard = await u.db("o_storyboard").where("id", 803).first();
  assert.equal("sceneContinuityId" in JSON.parse(storyboard.tableRowJson), false);
  assert.equal(storyboard.sceneContinuityId, null);
});

test("flow metadata, primary node and original reference URLs are consistent", async () => {
  await u.db("o_storyboard").insert({
    id: 820,
    projectId: 100,
    scriptId: 2,
    referenceImages: "[]",
  });
  const flowId = await imageFlow.saveImageFlow({
    projectId: 100,
    scriptId: 2,
    targetType: "storyboard",
    targetId: 820,
    nodes: [
      {
        id: "upload-original",
        type: "upload",
        data: {
          source: "local",
          sourceId: "local-original",
          image: "/refs/original.png?size=20",
          previewImage: "/refs/original.png?size=20",
          label: "original",
          group: "local",
          type: "image",
        },
      },
      {
        id: "only-generated",
        type: "generated",
        data: { generatedImage: "/results/final.png", status: "completed" },
      },
    ],
    edges: [],
    selectedImageUrl: "/results/final.png",
  });

  const stored = JSON.parse((await u.db("o_imageFlow").where("id", flowId).first()).flowData);
  assert.equal(stored.projectId, 100);
  assert.equal(stored.targetType, "storyboard");
  assert.equal(stored.targetId, 820);
  assert.equal(stored.nodes.find((node: any) => node.id === "only-generated").data.isPrimary, true);

  const resolved = await imageFlow.getImageFlow(flowId);
  const upload = resolved.nodes.find((node: any) => node.id === "upload-original");
  assert.doesNotMatch(upload.data.image, /\?size=/);
  assert.match(upload.data.previewImage, /\?size=20$/);
  assert.equal(upload.data.source, "local");
  assert.equal(upload.data.sourceId, "local-original");
});

test("multiple primary nodes and cross-storyboard flow reuse are rejected", async () => {
  await assert.rejects(
    imageFlow.saveImageFlow({
      nodes: [
        { id: "primary-a", type: "generated", data: { isPrimary: true } },
        { id: "primary-b", type: "generated", data: { isPrimary: true } },
      ],
      edges: [],
    }),
    (cause: any) =>
      cause instanceof imageFlow.ImageFlowValidationError &&
      cause.issues.some((issue: any) => issue.path === "nodes"),
  );

  await u.db("o_storyboard").insert([
    { id: 830, projectId: 100, scriptId: 2, referenceImages: "[]" },
    { id: 831, projectId: 100, scriptId: 2, referenceImages: "[]" },
  ]);
  const flowId = await imageFlow.saveImageFlow({
    projectId: 100,
    scriptId: 2,
    targetType: "storyboard",
    targetId: 830,
    nodes: [],
    edges: [],
  });
  await assert.rejects(
    imageFlow.saveImageFlow({
      flowId,
      projectId: 100,
      scriptId: 2,
      targetType: "storyboard",
      targetId: 831,
      nodes: [],
      edges: [],
    }),
    (cause: any) =>
      cause instanceof imageFlow.ImageFlowValidationError &&
      cause.issues.some((issue: any) => issue.path === "flowId"),
  );
});

test("image-flow-v2 migration rebuilds empty flows and is idempotent", async () => {
  const [parentImageId] = await u.db("o_image").insert({ filePath: "/parent/base.jpg", state: "已完成", assetsId: 600 });
  await u.db("o_assets").insert({ id: 600, type: "role", imageId: parentImageId });
  const [targetImageId] = await u.db("o_image").insert({ filePath: "/target/final.jpg", state: "已完成", assetsId: 601 });
  const [emptyFlowId] = await u.db("o_imageFlow").insert({ flowData: JSON.stringify({ nodes: [], edges: [] }) });
  await u.db("o_assets").insert({ id: 601, type: "role", assetsId: 600, imageId: targetImageId, flowId: emptyFlowId });
  await u.db("o_editImageTask").insert({
    id: 401,
    projectId: 100,
    scriptId: 2,
    targetType: "deriveAsset",
    targetId: 601,
    deriveAssetId: 601,
    flowId: emptyFlowId,
    nodeId: "recovered-node",
    status: "completed",
    state: "已完成",
    url: "/task/result.jpg",
    prompt: "recovered prompt",
    model: "vendor:model",
    quality: "2K",
    ratio: "16:9",
    references: "[]",
    createTime: Date.now(),
  });
  const [storyboardFlowId] = await u.db("o_imageFlow").insert({ flowData: JSON.stringify({ nodes: [], edges: [] }) });
  await u.db("o_storyboard").insert({
    id: 701,
    flowId: storyboardFlowId,
    filePath: "/storyboard/final.jpg",
    state: "已完成",
  });
  await u.db("o_editImageTask").insert({
    id: 402,
    projectId: 100,
    scriptId: 2,
    targetType: "storyboard",
    targetId: 999,
    flowId: 99999,
    nodeId: "missing-node",
    status: "processing",
    state: "生成中",
    references: "[]",
    createTime: Date.now(),
  });

  const [pendingFlowId] = await u.db("o_imageFlow").insert({
    flowData: JSON.stringify({
      nodes: [
        {
          id: "pending-image-node",
          type: "generated",
          position: { x: 1, y: 1 },
          data: { generatedImage: "/target/pending.jpg", taskId: null, status: "pending", state: "idle" },
        },
      ],
      edges: [],
    }),
  });

  const first = await imageFlowMigration.migrateImageFlowContractV2(rawDb);
  assert.equal(first.skipped, false);
  assert.ok(first.changedFlows >= 3);
  assert.ok(first.failedTasks >= 1);
  assert.equal(fs.existsSync(first.backupPath), true);

  const rebuiltRow = await u.db("o_imageFlow").where("id", emptyFlowId).first();
  const rebuilt = JSON.parse(rebuiltRow.flowData);
  assert.deepEqual(
    rebuilt.nodes.map((node: any) => node.id),
    [`migration:${emptyFlowId}:upload`, "recovered-node"],
  );
  const generated = rebuilt.nodes.find((node: any) => node.type === "generated");
  assert.equal(generated.data.generatedImage, "/target/final.jpg");
  assert.equal(generated.data.status, "completed");
  assert.equal(generated.data.historyId, 401);
  assert.equal(generated.data.selectedResult.url, "/target/final.jpg");

  const pendingRow = await u.db("o_imageFlow").where("id", pendingFlowId).first();
  const pendingNode = JSON.parse(pendingRow.flowData).nodes[0];
  assert.equal(pendingNode.data.status, "completed");
  assert.equal(pendingNode.data.taskId, null);

  const storyboardRow = await u.db("o_imageFlow").where("id", storyboardFlowId).first();
  const storyboardFlow = JSON.parse(storyboardRow.flowData);
  assert.equal(storyboardFlow.nodes.length, 1);
  assert.equal(storyboardFlow.nodes[0].type, "generated");
  assert.equal(storyboardFlow.nodes[0].data.generatedImage, "/storyboard/final.jpg");

  const orphanTask = await u.db("o_editImageTask").where("id", 402).first();
  assert.equal(orphanTask.status, "failed");
  assert.equal(orphanTask.reason, "历史任务对应的画布节点不存在");

  const snapshot = rebuiltRow.flowData;
  const second = await imageFlowMigration.migrateImageFlowContractV2(rawDb, { createBackup: false });
  assert.equal(second.skipped, true);
  assert.equal((await u.db("o_imageFlow").where("id", emptyFlowId).first()).flowData, snapshot);
  assert.equal(await u.db("o_setting").where("key", "migration:image-flow-contract-v2").count({ count: "*" }).first().then((row: any) => Number(row.count)), 1);
});

test("storyboard editor migration uses only exact and unique matches", async () => {
  const [assetImageId] = await u.db("o_image").insert({
    filePath: "/migration/asset.png",
    state: "已完成",
    assetsId: 850,
  });
  await u.db("o_assets").insert({
    id: 850,
    projectId: 200,
    type: "role",
    imageId: assetImageId,
  });
  const [flowId] = await u.db("o_imageFlow").insert({
    flowData: JSON.stringify({
      nodes: [
        {
          id: "migration-upload",
          type: "upload",
          data: { image: "/migration/asset.png", previewImage: "/migration/asset.png?size=20" },
        },
        {
          id: "migration-generated",
          type: "generated",
          data: { generatedImage: "/migration/final.png" },
        },
      ],
      edges: [],
    }),
  });
  await u.db("o_storyboard").insert({
    id: 840,
    projectId: 200,
    scriptId: 20,
    flowId,
    filePath: "/migration/final.png",
    referenceImages: "[]",
  });
  await u.db("o_assets2Storyboard").insert({ storyboardId: 840, assetId: 850 });

  const first = await storyboardMigration.migrateStoryboardEditorContractV1(rawDb);
  assert.equal(first.skipped, false);
  assert.ok(first.changedFlows >= 1);
  assert.equal(fs.existsSync(first.backupPath), true);

  const migrated = JSON.parse((await u.db("o_imageFlow").where("id", flowId).first()).flowData);
  assert.equal(migrated.targetType, "storyboard");
  assert.equal(migrated.targetId, 840);
  assert.equal(migrated.selectedImageUrl, "migration/final.png");
  assert.equal(migrated.nodes[0].data.source, "asset");
  assert.equal(migrated.nodes[0].data.sourceId, 850);
  assert.equal(migrated.nodes[1].data.isPrimary, true);

  const snapshot = JSON.stringify(migrated);
  const second = await storyboardMigration.migrateStoryboardEditorContractV1(rawDb, {
    createBackup: false,
  });
  assert.equal(second.skipped, true);
  assert.equal((await u.db("o_imageFlow").where("id", flowId).first()).flowData, snapshot);
});

test("interrupted image tasks fail together with their flow nodes", async () => {
  const failedCount = await imageFlowMigration.failInterruptedImageFlowTasks(rawDb);
  assert.ok(failedCount >= 1);
  const task = await u.db("o_editImageTask").where("id", 201).first();
  assert.equal(task.status, "failed");
  assert.equal(task.reason, "软件重启导致任务中断");

  const stored = await u.db("o_imageFlow").where("id", task.flowId).first();
  const node = JSON.parse(stored.flowData).nodes.find((item: any) => item.id === task.nodeId);
  assert.equal(node.data.status, "failed");
  assert.equal(node.data.taskId, null);
});
