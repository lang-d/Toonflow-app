import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-image-flow-task-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let rawDb: any;
let resolveImageFlowPrompt: typeof import("../src/services/imageFlowTask").resolveImageFlowPrompt;
let createImageFlowTask: typeof import("../src/services/imageFlowTask").createImageFlowTask;
let executeImageFlowTask: typeof import("../src/services/imageFlowTask").executeImageFlowTask;
let createBatchDeriveAssetImageTasks: typeof import("../src/routes/production/assets/batchGenerateAssetsImage").createBatchDeriveAssetImageTasks;
let ensureDeriveAssetImageFlow: typeof import("../src/services/imageFlow").ensureDeriveAssetImageFlow;
let saveImageFlow: typeof import("../src/services/imageFlow").saveImageFlow;
let updateDeriveAssetPrompt: typeof import("../src/services/imageFlow").updateDeriveAssetPrompt;
let utils: typeof import("../src/utils").default;

before(async () => {
  rawDb = (await import("../src/utils/db")).db;
  utils = (await import("../src/utils")).default;
  ({ createImageFlowTask, executeImageFlowTask, resolveImageFlowPrompt } = await import("../src/services/imageFlowTask"));
  ({ createBatchDeriveAssetImageTasks } = await import("../src/routes/production/assets/batchGenerateAssetsImage"));
  ({ ensureDeriveAssetImageFlow, saveImageFlow, updateDeriveAssetPrompt } = await import("../src/services/imageFlow"));
  await rawDb.schema.createTable("o_imageFlow", (table: any) => {
    table.increments("id");
    table.text("flowData");
  });
  await rawDb.schema.createTable("o_assets", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("assetsId");
    table.integer("flowId");
    table.integer("imageId");
    table.string("type");
    table.text("prompt");
  });
  await rawDb.schema.createTable("o_script", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
  });
  await rawDb.schema.createTable("o_image", (table: any) => {
    table.increments("id");
    table.integer("assetsId");
    table.string("filePath");
    table.string("state");
    table.string("type");
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
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("episode");
    table.string("taskClass");
    table.string("taskType");
    table.string("status");
    table.string("phase");
    table.integer("progress");
    table.string("targetType");
    table.string("targetId");
    table.string("nodeId");
    table.string("businessType");
    table.integer("businessId");
    table.string("handler");
    table.text("payloadJson");
    table.text("resultJson");
    table.integer("priority");
    table.integer("availableAt");
    table.integer("attempt");
    table.integer("maxAttempts");
    table.integer("version");
    table.string("providerTaskId");
    table.integer("providerSubmittedAt");
    table.string("leaseOwner");
    table.integer("leaseExpiresAt");
    table.string("idempotencyKey");
    table.string("model");
    table.text("describe");
    table.text("relatedObjects");
    table.string("state");
    table.integer("startTime");
    table.integer("createdAt");
    table.integer("updateTime");
    table.integer("finishTime");
    table.text("reason");
  });
  await rawDb.schema.createTable("o_taskEvent", (table: any) => {
    table.increments("id");
    table.string("taskId");
    table.integer("legacyTaskId");
    table.integer("version");
    table.string("taskType");
    table.integer("projectId");
    table.integer("scriptId");
    table.string("targetType");
    table.string("targetId");
    table.string("nodeId");
    table.string("status");
    table.string("phase");
    table.integer("progress");
    table.text("resultJson");
    table.text("reason");
    table.integer("createdAt");
  });
});

after(async () => {
  await rawDb?.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("image flow prompt uses non-empty request prompt first", async () => {
  await rawDb("o_assets").insert({ id: 1001, prompt: "asset prompt" });
  const [flowId] = await rawDb("o_imageFlow").insert({
    flowData: JSON.stringify({
      nodes: [{ id: "node-a", type: "generated", data: { prompt: "node prompt" } }],
      edges: [],
    }),
  });

  const resolved = await resolveImageFlowPrompt(
    rawDb,
    {
      prompt: " request prompt ",
      flowId,
      targetType: "deriveAsset",
      targetId: 1001,
    },
    "node-a",
  );

  assert.deepEqual(resolved, {
    prompt: "request prompt",
    source: "request",
    shouldBackfillNodePrompt: false,
  });
});

test("image flow prompt preserves an existing node prompt before asset fallback", async () => {
  await rawDb("o_assets").insert({ id: 1002, prompt: "asset fallback prompt" });
  const [flowId] = await rawDb("o_imageFlow").insert({
    flowData: JSON.stringify({
      nodes: [{ id: "node-b", type: "generated", data: { prompt: "manual node prompt" } }],
      edges: [],
    }),
  });

  const resolved = await resolveImageFlowPrompt(
    rawDb,
    {
      prompt: "   ",
      flowId,
      targetType: "deriveAsset",
      targetId: 1002,
    },
    "node-b",
  );

  assert.deepEqual(resolved, {
    prompt: "manual node prompt",
    source: "node",
    shouldBackfillNodePrompt: false,
  });
});

test("image flow prompt falls back to asset prompt only when request and node prompts are empty", async () => {
  await rawDb("o_assets").insert({ id: 1003, prompt: "asset prompt for first generation" });
  const [flowId] = await rawDb("o_imageFlow").insert({
    flowData: JSON.stringify({
      nodes: [{ id: "node-c", type: "generated", data: { prompt: "" } }],
      edges: [],
    }),
  });

  const resolved = await resolveImageFlowPrompt(
    rawDb,
    {
      prompt: "",
      flowId,
      targetType: "deriveAsset",
      targetId: 1003,
    },
    "node-c",
  );

  assert.deepEqual(resolved, {
    prompt: "asset prompt for first generation",
    source: "asset",
    shouldBackfillNodePrompt: true,
  });
});

test("image flow prompt rejects empty request and empty asset prompt", async () => {
  await rawDb("o_assets").insert({ id: 1004, prompt: "" });
  const [flowId] = await rawDb("o_imageFlow").insert({
    flowData: JSON.stringify({
      nodes: [{ id: "node-d", type: "generated", data: { prompt: "" } }],
      edges: [],
    }),
  });

  await assert.rejects(
    resolveImageFlowPrompt(
      rawDb,
      {
        prompt: "",
        flowId,
        targetType: "deriveAsset",
        targetId: 1004,
      },
      "node-d",
    ),
    /请先填写生图提示语/,
  );
});

test("createImageFlowTask stores the resolved asset prompt and backfills only an empty node prompt", async () => {
  await rawDb("o_script").insert({ id: 4, projectId: 77 });
  await rawDb("o_assets").insert([
    { id: 9005, projectId: 77, type: "role", prompt: "" },
    { id: 1005, projectId: 77, assetsId: 9005, type: "role", prompt: "asset prompt saved by agent" },
  ]);
  const [flowId] = await rawDb("o_imageFlow").insert({
    flowData: JSON.stringify({
      projectId: 77,
      scriptId: 3,
      targetType: "deriveAsset",
      targetId: 1005,
      nodes: [{ id: "node-e", type: "generated", data: { prompt: "" } }],
      edges: [],
    }),
  });
  await rawDb("o_assets").where("id", 1005).update({ flowId });

  const task = await createImageFlowTask({
    projectId: 77,
    scriptId: 4,
    targetType: "deriveAsset",
    targetId: 1005,
    deriveAssetId: 1005,
    flowId,
    nodeId: "node-e",
    references: [],
    model: "vendor:model",
    quality: "2K",
    ratio: "16:9",
    prompt: "",
  });

  const editTask = await rawDb("o_editImageTask").where("id", task.taskId).first();
  assert.equal(editTask.prompt, "asset prompt saved by agent");

  const unifiedTask = await rawDb("o_tasks").where("id", editTask.taskCenterId).first();
  assert.equal(unifiedTask.describe, "asset prompt saved by agent");
  assert.equal(JSON.parse(unifiedTask.payloadJson).input.prompt, "asset prompt saved by agent");

  const flow = JSON.parse((await rawDb("o_imageFlow").where("id", flowId).first()).flowData);
  const node = flow.nodes.find((item: any) => item.id === "node-e");
  assert.equal(node.data.prompt, "asset prompt saved by agent");
  assert.equal(node.data.taskId, task.taskId);
  assert.equal(node.data.status, "processing");
});

test("batch derive asset image creation returns successful tasks and per-asset errors separately", async () => {
  await rawDb("o_script").insert({ id: 150, projectId: 150 });
  await rawDb("o_assets").insert([
    { id: 9150, projectId: 150, type: "role", prompt: "" },
    { id: 1150, projectId: 150, assetsId: 9150, type: "role", prompt: "valid derive prompt" },
    { id: 1151, projectId: 150, assetsId: 9150, type: "role", prompt: "" },
  ]);

  const result = await createBatchDeriveAssetImageTasks({
    projectId: 150,
    scriptId: 150,
    assetIds: [1150, 1151, 1150],
    model: "vendor:model",
    quality: "2K",
    ratio: "16:9",
  });

  assert.equal(result.total, 2);
  assert.equal(result.successCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].assetId, 1150);
  assert.equal(result.tasks[0].prompt, "valid derive prompt");
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.errors[0], { assetId: 1151, error: "请先填写生图提示语" });
});

test("batch derive asset image creation defaults a new flow to 16:9 instead of project ratio", async () => {
  await rawDb("o_script").insert({ id: 151, projectId: 151 });
  await rawDb("o_assets").insert([
    { id: 9152, projectId: 151, type: "tool", prompt: "" },
    { id: 1152, projectId: 151, assetsId: 9152, type: "tool", prompt: "tool derive prompt" },
  ]);

  const result = await createBatchDeriveAssetImageTasks({
    projectId: 151,
    scriptId: 151,
    assetIds: [1152],
    model: "vendor:model",
    quality: "2K",
    ratio: "9:16",
  });

  assert.equal(result.successCount, 1);
  assert.equal(result.tasks[0].ratio, "16:9");
  const editTask = await rawDb("o_editImageTask").where("id", result.tasks[0].legacyTaskId).first();
  assert.equal(editTask.ratio, "16:9");
  const flow = JSON.parse((await rawDb("o_imageFlow").where("id", result.tasks[0].flowId).first()).flowData);
  const node = flow.nodes.find((item: any) => item.id === result.tasks[0].nodeId);
  assert.equal(node.data.ratio, "16:9");
});

test("batch derive asset image creation follows an existing primary node ratio", async () => {
  await rawDb("o_script").insert({ id: 152, projectId: 152 });
  await rawDb("o_assets").insert([
    { id: 9153, projectId: 152, type: "scene", prompt: "" },
    { id: 1153, projectId: 152, assetsId: 9153, type: "scene", prompt: "scene derive prompt" },
  ]);
  const [flowId] = await rawDb("o_imageFlow").insert({
    flowData: JSON.stringify({
      projectId: 152,
      scriptId: 152,
      targetType: "deriveAsset",
      targetId: 1153,
      nodes: [{ id: "primary-ratio-node", type: "generated", data: { prompt: "scene derive prompt", ratio: "1:1", isPrimary: true } }],
      edges: [],
    }),
  });
  await rawDb("o_assets").where("id", 1153).update({ flowId });

  const result = await createBatchDeriveAssetImageTasks({
    projectId: 152,
    scriptId: 152,
    assetIds: [1153],
    model: "vendor:model",
    quality: "2K",
    ratio: "9:16",
  });

  assert.equal(result.successCount, 1);
  assert.equal(result.tasks[0].ratio, "1:1");
  const editTask = await rawDb("o_editImageTask").where("id", result.tasks[0].legacyTaskId).first();
  assert.equal(editTask.ratio, "1:1");
});

test("canvas derive asset generation uses the current node request ratio", async () => {
  await rawDb("o_script").insert({ id: 153, projectId: 153 });
  await rawDb("o_assets").insert([
    { id: 9154, projectId: 153, type: "role", prompt: "" },
    { id: 1154, projectId: 153, assetsId: 9154, type: "role", prompt: "role derive prompt" },
  ]);
  const [flowId] = await rawDb("o_imageFlow").insert({
    flowData: JSON.stringify({
      projectId: 153,
      scriptId: 153,
      targetType: "deriveAsset",
      targetId: 1154,
      nodes: [{ id: "manual-ratio-node", type: "generated", data: { prompt: "role derive prompt", ratio: "1:1", isPrimary: true } }],
      edges: [],
    }),
  });
  await rawDb("o_assets").where("id", 1154).update({ flowId });

  const task = await createImageFlowTask({
    projectId: 153,
    scriptId: 153,
    targetType: "deriveAsset",
    targetId: 1154,
    deriveAssetId: 1154,
    flowId,
    nodeId: "manual-ratio-node",
    references: [],
    model: "vendor:model",
    quality: "2K",
    ratio: "9:16",
    prompt: "",
  });

  assert.equal(task.ratio, "9:16");
  const editTask = await rawDb("o_editImageTask").where("id", task.taskId).first();
  assert.equal(editTask.ratio, "9:16");
  const flow = JSON.parse((await rawDb("o_imageFlow").where("id", flowId).first()).flowData);
  assert.equal(flow.nodes.find((item: any) => item.id === "manual-ratio-node").data.ratio, "9:16");
});

test("canvas derive asset generation falls back to the stored node ratio when request ratio is empty", async () => {
  await rawDb("o_script").insert({ id: 157, projectId: 157 });
  await rawDb("o_assets").insert([
    { id: 9157, projectId: 157, type: "role", prompt: "" },
    { id: 1157, projectId: 157, assetsId: 9157, type: "role", prompt: "role stored ratio prompt" },
  ]);
  const [flowId] = await rawDb("o_imageFlow").insert({
    flowData: JSON.stringify({
      projectId: 157,
      scriptId: 157,
      targetType: "deriveAsset",
      targetId: 1157,
      nodes: [{ id: "stored-ratio-node", type: "generated", data: { prompt: "role stored ratio prompt", ratio: "1:1", isPrimary: true } }],
      edges: [],
    }),
  });
  await rawDb("o_assets").where("id", 1157).update({ flowId });

  const task = await createImageFlowTask({
    projectId: 157,
    scriptId: 157,
    targetType: "deriveAsset",
    targetId: 1157,
    deriveAssetId: 1157,
    flowId,
    nodeId: "stored-ratio-node",
    references: [],
    model: "vendor:model",
    quality: "2K",
    ratio: "",
    prompt: "",
  });

  assert.equal(task.ratio, "1:1");
  const editTask = await rawDb("o_editImageTask").where("id", task.taskId).first();
  assert.equal(editTask.ratio, "1:1");
  const flow = JSON.parse((await rawDb("o_imageFlow").where("id", flowId).first()).flowData);
  assert.equal(flow.nodes.find((item: any) => item.id === "stored-ratio-node").data.ratio, "1:1");
});

test("storyboard image flow keeps its requested ratio", async () => {
  await rawDb("o_script").insert({ id: 154, projectId: 154 });
  await rawDb("o_storyboard").insert({ id: 7154, projectId: 154, scriptId: 154 });
  const [flowId] = await rawDb("o_imageFlow").insert({
    flowData: JSON.stringify({
      projectId: 154,
      scriptId: 154,
      targetType: "storyboard",
      targetId: 7154,
      nodes: [{ id: "storyboard-node", type: "generated", data: { prompt: "storyboard prompt", ratio: "9:16", isPrimary: true } }],
      edges: [],
    }),
  });
  await rawDb("o_storyboard").where("id", 7154).update({ flowId });

  const task = await createImageFlowTask({
    projectId: 154,
    scriptId: 154,
    targetType: "storyboard",
    targetId: 7154,
    flowId,
    nodeId: "storyboard-node",
    references: [],
    model: "vendor:model",
    quality: "2K",
    ratio: "9:16",
    prompt: "storyboard prompt",
  });

  assert.equal(task.ratio, "9:16");
  const editTask = await rawDb("o_editImageTask").where("id", task.taskId).first();
  assert.equal(editTask.ratio, "9:16");
  const flow = JSON.parse((await rawDb("o_imageFlow").where("id", flowId).first()).flowData);
  assert.equal(flow.nodes.find((item: any) => item.id === "storyboard-node").data.ratio, "9:16");
});

test("saveImageFlow defaults only derive asset empty ratios to 16:9", async () => {
  await rawDb("o_script").insert([
    { id: 155, projectId: 155 },
    { id: 156, projectId: 156 },
  ]);
  await rawDb("o_assets").insert([
    { id: 9155, projectId: 155, type: "tool", prompt: "" },
    { id: 1155, projectId: 155, assetsId: 9155, type: "tool", prompt: "tool derive prompt" },
  ]);
  await rawDb("o_storyboard").insert({ id: 7156, projectId: 156, scriptId: 156 });

  const deriveFlowId = await saveImageFlow({
    projectId: 155,
    scriptId: 155,
    targetType: "deriveAsset",
    targetId: 1155,
    nodes: [{ id: "derive-save-node", type: "generated", data: { prompt: "tool derive prompt", ratio: "", isPrimary: true } }],
    edges: [],
  });
  const storyboardFlowId = await saveImageFlow({
    projectId: 156,
    scriptId: 156,
    targetType: "storyboard",
    targetId: 7156,
    nodes: [{ id: "storyboard-save-node", type: "generated", data: { prompt: "storyboard prompt", ratio: "", isPrimary: true } }],
    edges: [],
  });

  const deriveFlow = JSON.parse((await rawDb("o_imageFlow").where("id", deriveFlowId).first()).flowData);
  const storyboardFlow = JSON.parse((await rawDb("o_imageFlow").where("id", storyboardFlowId).first()).flowData);
  assert.equal(deriveFlow.nodes.find((item: any) => item.id === "derive-save-node").data.ratio, "16:9");
  assert.equal(storyboardFlow.nodes.find((item: any) => item.id === "storyboard-save-node").data.ratio, "");
});

test("derive asset flow is shared across scripts and selects the last generated node", async () => {
  await rawDb("o_script").insert([
    { id: 41, projectId: 78 },
    { id: 42, projectId: 78 },
  ]);
  await rawDb("o_assets").insert([
    { id: 9010, projectId: 78, type: "scene", prompt: "" },
    { id: 1010, projectId: 78, assetsId: 9010, type: "scene", prompt: "shared scene prompt" },
  ]);
  const [flowId] = await rawDb("o_imageFlow").insert({
    flowData: JSON.stringify({
      projectId: 78,
      scriptId: 41,
      targetType: "deriveAsset",
      targetId: 1010,
      nodes: [
        { id: "first-node", type: "generated", data: { prompt: "first" } },
        { id: "last-node", type: "generated", data: { prompt: "last" } },
      ],
      edges: [],
    }),
  });
  await rawDb("o_assets").where("id", 1010).update({ flowId });

  const ensured = await ensureDeriveAssetImageFlow({
    projectId: 78,
    scriptId: 42,
    targetId: 1010,
    model: "vendor:model",
    quality: "2K",
    ratio: "16:9",
  });

  assert.equal(ensured.flowId, flowId);
  assert.equal(ensured.nodeId, "last-node");
  assert.equal(ensured.prompt, "last");
  const flow = JSON.parse((await rawDb("o_imageFlow").where("id", flowId).first()).flowData);
  assert.equal(flow.scriptId, 41);
  assert.equal(flow.nodes.find((node: any) => node.id === "first-node").data.isPrimary, false);
  assert.equal(flow.nodes.find((node: any) => node.id === "last-node").data.isPrimary, true);
});

test("new derive asset flow initializes with the parent reference", async () => {
  await rawDb("o_script").insert({ id: 45, projectId: 83 });
  const [parentImageId] = await rawDb("o_image").insert({
    filePath: "assets/parent-reference.png",
    state: "已完成",
    type: "role",
  });
  await rawDb("o_assets").insert([
    { id: 9050, projectId: 83, type: "role", imageId: parentImageId, prompt: "" },
    { id: 1050, projectId: 83, assetsId: 9050, type: "role", prompt: "derived role prompt" },
  ]);

  const ensured = await ensureDeriveAssetImageFlow({
    projectId: 83,
    scriptId: 45,
    targetId: 1050,
    model: "vendor:model",
    quality: "2K",
    ratio: "16:9",
  });

  const flow = JSON.parse((await rawDb("o_imageFlow").where("id", ensured.flowId).first()).flowData);
  const parentUpload = flow.nodes.find(
    (node: any) => node.type === "upload" && Number(node.data?.sourceId) === 9050,
  );
  assert.ok(parentUpload);
  assert.ok(flow.edges.some((edge: any) => edge.source === parentUpload.id && edge.target === ensured.nodeId));
});

test("existing derive asset flow does not restore the parent reference after user replacement", async () => {
  await rawDb("o_script").insert({ id: 45, projectId: 83 });
  const [parentImageId] = await rawDb("o_image").insert({
    filePath: "assets/parent-reference.png",
    state: "已完成",
    type: "role",
  });
  await rawDb("o_assets").insert([
    { id: 9050, projectId: 83, type: "role", imageId: parentImageId, prompt: "" },
    { id: 1050, projectId: 83, assetsId: 9050, type: "role", prompt: "derived role prompt" },
  ]);
  const [flowId] = await rawDb("o_imageFlow").insert({
    flowData: JSON.stringify({
      projectId: 83,
      targetType: "deriveAsset",
      targetId: 1050,
      nodes: [
        { id: "unrelated-upload", type: "upload", data: { sourceId: 9999, image: "assets/unrelated.png" } },
        { id: "generated", type: "generated", data: { prompt: "derived role prompt", isPrimary: true } },
      ],
      edges: [],
    }),
  });
  await rawDb("o_assets").where("id", 1050).update({ flowId });

  await ensureDeriveAssetImageFlow({
    projectId: 83,
    scriptId: 45,
    targetId: 1050,
    model: "vendor:model",
    quality: "2K",
    ratio: "16:9",
  });

  const flow = JSON.parse((await rawDb("o_imageFlow").where("id", flowId).first()).flowData);
  const parentUpload = flow.nodes.find(
    (node: any) => node.type === "upload" && Number(node.data?.sourceId) === 9050,
  );
  assert.equal(parentUpload, undefined);
  assert.deepEqual(
    flow.nodes.map((node: any) => node.id),
    ["unrelated-upload", "generated"],
  );
  assert.deepEqual(flow.edges, []);
});

test("existing derive asset flow with no references remains user-empty after ensure", async () => {
  await rawDb("o_script").insert({ id: 46, projectId: 83 });
  const [parentImageId] = await rawDb("o_image").insert({
    filePath: "assets/parent-reference-empty.png",
    state: "已完成",
    type: "scene",
  });
  await rawDb("o_assets").insert([
    { id: 9051, projectId: 83, type: "scene", imageId: parentImageId, prompt: "" },
    { id: 1051, projectId: 83, assetsId: 9051, type: "scene", prompt: "empty reference prompt" },
  ]);
  const [flowId] = await rawDb("o_imageFlow").insert({
    flowData: JSON.stringify({
      projectId: 83,
      targetType: "deriveAsset",
      targetId: 1051,
      nodes: [{ id: "generated", type: "generated", data: { prompt: "empty reference prompt", isPrimary: true } }],
      edges: [],
    }),
  });
  await rawDb("o_assets").where("id", 1051).update({ flowId });

  await ensureDeriveAssetImageFlow({
    projectId: 83,
    scriptId: 46,
    targetId: 1051,
    model: "vendor:model",
    quality: "2K",
    ratio: "16:9",
  });

  const flow = JSON.parse((await rawDb("o_imageFlow").where("id", flowId).first()).flowData);
  assert.equal(flow.nodes.some((node: any) => node.type === "upload"), false);
  assert.deepEqual(flow.edges, []);
});

test("derive asset prompt preserve and replace modes update the shared primary node correctly", async () => {
  await rawDb("o_assets").insert([
    { id: 9020, projectId: 79, type: "role", prompt: "" },
    { id: 1020, projectId: 79, assetsId: 9020, type: "role", prompt: "old default" },
  ]);
  const [flowId] = await rawDb("o_imageFlow").insert({
    flowData: JSON.stringify({
      projectId: 79,
      targetType: "deriveAsset",
      targetId: 1020,
      nodes: [{ id: "primary-node", type: "generated", data: { prompt: "user prompt", isPrimary: true } }],
      edges: [],
    }),
  });
  await rawDb("o_assets").where("id", 1020).update({ flowId });

  await updateDeriveAssetPrompt(rawDb, {
    projectId: 79,
    targetId: 1020,
    prompt: "preserved default",
    mode: "preserve",
  });
  let flow = JSON.parse((await rawDb("o_imageFlow").where("id", flowId).first()).flowData);
  assert.equal(flow.nodes[0].data.prompt, "user prompt");
  assert.equal((await rawDb("o_assets").where("id", 1020).first()).prompt, "preserved default");

  await updateDeriveAssetPrompt(rawDb, {
    projectId: 79,
    targetId: 1020,
    prompt: "replacement prompt",
    mode: "replace",
  });
  flow = JSON.parse((await rawDb("o_imageFlow").where("id", flowId).first()).flowData);
  assert.equal(flow.nodes[0].data.prompt, "replacement prompt");
  assert.equal((await rawDb("o_assets").where("id", 1020).first()).prompt, "replacement prompt");
});

test("derive asset prompt update rejects a flow bound to another asset before changing the default", async () => {
  await rawDb("o_assets").insert([
    { id: 9060, projectId: 84, type: "scene", prompt: "" },
    { id: 1060, projectId: 84, assetsId: 9060, type: "scene", prompt: "unchanged" },
    { id: 1061, projectId: 84, assetsId: 9060, type: "scene", prompt: "other" },
  ]);
  const [flowId] = await rawDb("o_imageFlow").insert({
    flowData: JSON.stringify({
      projectId: 84,
      targetType: "deriveAsset",
      targetId: 1061,
      nodes: [{ id: "other-primary", type: "generated", data: { prompt: "other", isPrimary: true } }],
      edges: [],
    }),
  });
  await rawDb("o_assets").where("id", 1060).update({ flowId });

  await assert.rejects(
    updateDeriveAssetPrompt(rawDb, {
      projectId: 84,
      targetId: 1060,
      prompt: "must not be written",
      mode: "replace",
    }),
    (cause: any) => cause?.issues?.some((issue: any) => issue.path === "flowId"),
  );
  assert.equal((await rawDb("o_assets").where("id", 1060).first()).prompt, "unchanged");
});

test("derive asset flow rejects scripts and assets from another project", async () => {
  await rawDb("o_script").insert({ id: 43, projectId: 80 });
  await rawDb("o_assets").insert([
    { id: 9030, projectId: 81, type: "tool", prompt: "" },
    { id: 1030, projectId: 81, assetsId: 9030, type: "tool", prompt: "tool prompt" },
  ]);
  await assert.rejects(
    ensureDeriveAssetImageFlow({
      projectId: 80,
      scriptId: 43,
      targetId: 1030,
      model: "vendor:model",
      quality: "2K",
      ratio: "16:9",
    }),
    (cause: any) => cause?.issues?.some((issue: any) => issue.path === "targetId" && /衍生资产不存在/.test(issue.message)),
  );
});

test("completed derive image flow updates the shared node and asset image together", async () => {
  await rawDb("o_script").insert({ id: 44, projectId: 82 });
  await rawDb("o_assets").insert([
    { id: 9040, projectId: 82, type: "scene", prompt: "" },
    { id: 1040, projectId: 82, assetsId: 9040, type: "scene", prompt: "shared completion prompt" },
  ]);
  const task = await createImageFlowTask({
    projectId: 82,
    scriptId: 44,
    targetType: "deriveAsset",
    targetId: 1040,
    deriveAssetId: 1040,
    references: [],
    model: "vendor:model",
    quality: "2K",
    ratio: "16:9",
    prompt: "",
  });
  const unified = await rawDb("o_tasks").where("id", (await rawDb("o_editImageTask").where("id", task.taskId).first()).taskCenterId).first();
  const payload = JSON.parse(unified.payloadJson);
  const originalImage = (utils.Ai as any).Image;
  (utils.Ai as any).Image = () => ({
    runRecoverable: async () => ({
      pending: false,
      image: {
        save: async (filePath: string) => {
          await utils.oss.writeFile(filePath, Buffer.from("test-image"));
        },
      },
    }),
  });
  try {
    await executeImageFlowTask(payload, {});
  } finally {
    (utils.Ai as any).Image = originalImage;
  }

  const asset = await rawDb("o_assets").where("id", 1040).first();
  assert.ok(asset.imageId);
  assert.equal(asset.flowId, task.flowId);
  const image = await rawDb("o_image").where("id", asset.imageId).first();
  assert.equal(image.assetsId, 1040);
  assert.equal(image.state, "已完成");
  const flow = JSON.parse((await rawDb("o_imageFlow").where("id", task.flowId).first()).flowData);
  const node = flow.nodes.find((item: any) => item.id === task.nodeId);
  assert.equal(node.data.prompt, "shared completion prompt");
  assert.equal(node.data.status, "completed");
  assert.equal(flow.selectedImageUrl, image.filePath);
});
