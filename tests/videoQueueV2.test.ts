import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import knexFactory from "knex";
import {
  buildVideoArgs,
  getDreaminaVideoResolutions,
  getDreaminaVideoSubmitFailureReason,
  getDreaminaProviderModelKey,
  isDreaminaCapacityLimit,
  normalizeQueueConfig,
  normalizeTaskOutputStatus,
  parseDreaminaQueueInfo,
  parseDreaminaRemoteEvidence,
  parseDreaminaTaskOutput,
} from "../src/utils/dreaminaCli";
import { migrateVideoQueueV2, recoverVideoQueueAfterRestart } from "../src/lib/migrations/videoQueueV2";
import { migrateVideoQueueV3 } from "../src/lib/migrations/videoQueueV3";

test("Dreamina local querying output is not remote task evidence", () => {
  const submitId = "local-submit-1";
  assert.equal(
    parseDreaminaRemoteEvidence(`{"submit_id":"${submitId}","gen_status":"querying"}`, submitId).confirmed,
    false,
  );
  assert.equal(
    parseDreaminaRemoteEvidence(
      `[QueryResult] history: {"submit_id":"${submitId}","history_record_id":"history-1","task":{"task_id":"task-1"}}`,
      submitId,
    ).confirmed,
    true,
  );
  assert.equal(
    parseDreaminaRemoteEvidence(
      `${submitId}\n[MCP.Generate] request finished ret=0\n[SubmitTask] submit generation task finished`,
      submitId,
    ).confirmed,
    true,
  );
});

test("Dreamina model slots and queue metadata are parsed independently", () => {
  assert.equal(getDreaminaProviderModelKey("text2video:seedance2.0"), "dreamina:seedance2.0");
  assert.equal(getDreaminaProviderModelKey("multimodal2video:seedance2.0"), "dreamina:seedance2.0");
  assert.equal(getDreaminaProviderModelKey("multimodal2video:seedance2.0fast"), "dreamina:seedance2.0fast");
  assert.equal(getDreaminaProviderModelKey("image2video:seedance2.0_fast"), "dreamina:seedance2.0fast");
  assert.equal(getDreaminaProviderModelKey("text2video:seedance2.0mini"), "dreamina:seedance2.0mini");
  assert.equal(getDreaminaProviderModelKey("image2video:seedance2.0-mini"), "dreamina:seedance2.0mini");
  assert.equal(getDreaminaProviderModelKey("multimodal2video:seedance2.0_mini"), "dreamina:seedance2.0mini");
  assert.equal(getDreaminaProviderModelKey("multimodal2video:seedance2.0_vip"), "dreamina:seedance2.0_vip");
  assert.equal(getDreaminaProviderModelKey("multimodal2video:seedance2.0fast_vip"), "dreamina:seedance2.0fast_vip");
  assert.equal(getDreaminaProviderModelKey("text2video:seedance2.0-fast-vip"), "dreamina:seedance2.0fast_vip");
  assert.equal(isDreaminaCapacityLimit("api error: ret=1310, message=ExceedConcurrencyLimit"), true);
  assert.deepEqual(
    parseDreaminaQueueInfo(
      '{"queue_info":{"queue_idx":463,"priority":1,"queue_status":1,"queue_length":303041}}',
    ),
    { index: 463, status: 1, length: 303041 },
  );
});

test("Dreamina transient CLI errors do not become provider task failures", () => {
  assert.equal(
    normalizeTaskOutputStatus(
      'ERROR failed to initialize optional logger\n{"submit_id":"submit-1","gen_status":"querying"}',
    ),
    "generating",
  );
  assert.equal(
    normalizeTaskOutputStatus(
      '{"submit_id":"submit-1","gen_status":"failed","fail_reason":"素材审核未通过"}',
    ),
    "failed",
  );
});

test("Dreamina video submit upload failure is detected even when submit_id exists", () => {
  const submitId = "submit-with-upload-failure";
  const rawOutput = [
    `{"submit_id":"${submitId}","gen_status":"querying"}`,
    `[ResourceUpload] upload file failed resource_type=image path=E:\\data\\scene\\ref.jpg index=3 err=<Error: upload image: apply phase, ApplyImageUpload: unmarshal response, request 20260627, code 201007, request to backend service failed, bad gateway>`,
    `[SubmitTask] execute submit failed gen_task_type=multimodal2video submit_id=${submitId}`,
  ].join("\n");
  const reason = getDreaminaVideoSubmitFailureReason(rawOutput, 0);
  assert.match(reason || "", /参考图上传到即梦失败/);
  assert.match(reason || "", /bad gateway/i);
  assert.equal(
    getDreaminaVideoSubmitFailureReason(
      `ERROR failed to initialize optional logger\n{"submit_id":"${submitId}","gen_status":"querying"}`,
      0,
    ),
    undefined,
  );
});

test("Dreamina task parsing ignores another submitId's successful video URL", () => {
  const currentSubmitId = "submit-a";
  const output = [
    JSON.stringify({ submit_id: currentSubmitId, gen_status: "querying" }),
    JSON.stringify({
      submit_id: "submit-b",
      gen_status: "success",
      video_url: "https://example.com/wrong-video.mp4",
    }),
  ].join("\n");
  const parsed = parseDreaminaTaskOutput(output, currentSubmitId);
  assert.equal(parsed.status, "generating");
  assert.equal(parsed.videoUrl, undefined);
  assert.equal(parsed.evidence.confirmed, false);
});

test("Dreamina list_task confirms only the current queued task without yielding a video URL", () => {
  const submitId = "submit-a";
  const parsed = parseDreaminaTaskOutput(
    JSON.stringify({
      submit_id: submitId,
      history_record_id: "history-a",
      task: { task_id: "task-a" },
      queue_info: { queue_status: 1, queue_idx: 7, queue_length: 100 },
    }),
    submitId,
  );
  assert.equal(parsed.status, "generating");
  assert.equal(parsed.evidence.confirmed, true);
  assert.equal(parsed.evidence.historyRecordId, "history-a");
  assert.deepEqual(parsed.queueInfo, { status: 1, index: 7, length: 100 });
  assert.equal(parsed.videoUrl, undefined);
});

test("Dreamina accepts a video URL only when structured output binds it to the current submitId", () => {
  const submitId = "submit-a";
  const parsed = parseDreaminaTaskOutput(
    JSON.stringify({
      submit_id: submitId,
      gen_status: "success",
      video_url: "https://example.com/right-video.mp4",
    }),
    submitId,
  );
  assert.equal(parsed.status, "success");
  assert.equal(parsed.videoUrl, "https://example.com/right-video.mp4");
});

test("Dreamina video args and Seedance capabilities match CLI channel behavior", () => {
  const referencePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-dreamina-args-")), "reference.png");
  fs.writeFileSync(referencePath, Buffer.from("reference"));
  const input = {
    prompt: "test",
    duration: 5,
    resolution: "4K",
    aspectRatio: "4:3",
    referenceList: [{ type: "image", filePath: referencePath }],
    mode: "singleImage",
  } as any;
  const imageArgs = buildVideoArgs(input, {
    name: "mini",
    modelName: "image2video:seedance2.0mini",
    type: "video",
  } as any).args;
  const multimodalArgs = buildVideoArgs(input, {
    name: "vip",
    modelName: "multimodal2video:seedance2.0_vip",
    type: "video",
  } as any).args;
  assert.equal(imageArgs.some((arg) => arg.startsWith("--ratio=")), false);
  assert.equal(multimodalArgs.includes("--ratio=4:3"), true);
  assert.equal(multimodalArgs.includes("--video_resolution=4K"), true);
  assert.deepEqual(getDreaminaVideoResolutions("--video_resolution 720p,1080p", "seedance2.0mini"), ["720p"]);
  assert.deepEqual(
    getDreaminaVideoResolutions("--video_resolution 720p,1080p", "seedance2.0_vip"),
    ["720p", "1080p", "4K"],
  );
  assert.equal(normalizeQueueConfig({ maxWorkHours: 9 }).maxWorkHours, 9);
});

test("video queue migration externalizes queued Base64 and is idempotent", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-video-queue-"));
  process.env.TOONFLOW_DATA_DIR = dataDir;
  const dbPath = path.join(dataDir, "queue.sqlite");
  const db = knexFactory({
    client: "better-sqlite3",
    connection: { filename: dbPath },
    useNullAsDefault: true,
  });

  await db.schema.createTable("o_setting", (table) => {
    table.string("key").primary();
    table.text("value");
  });
  await db.schema.createTable("o_video", (table) => {
    table.integer("id").primary();
    table.string("state");
    table.string("errorReason");
  });
  await db.schema.createTable("o_tasks", (table) => {
    table.integer("id").primary();
    table.string("state");
    table.string("reason");
  });
  await db.schema.createTable("o_videoGenerationTask", (table) => {
    table.integer("id").primary();
    table.integer("videoId");
    table.integer("taskCenterId");
    table.integer("payloadVersion");
    table.text("requestJson");
    table.string("phase");
    table.string("status");
    table.string("state");
    table.string("submitId");
    table.string("officialTaskId");
    table.string("historyRecordId");
    table.string("providerAccountId");
    table.integer("remoteConfirmedAt");
    table.string("errorReason");
    table.text("rawOutput");
    table.integer("nextPollTime");
    table.integer("nextSubmitTime");
    table.integer("updateTime");
    table.integer("finishTime");
  });

  const bytes = Buffer.from("original-media-bytes");
  const dataUrl = `data:audio/wav;base64,${bytes.toString("base64")}`;
  const oldRequest = {
    videoPath: "/1/video/result.mp4",
    input: {
      prompt: "test",
      duration: 5,
      resolution: "720p",
      aspectRatio: "16:9",
      referenceList: [{ type: "audio", base64: dataUrl }],
    },
    relatedObjects: { trackId: 3 },
  };
  await db("o_video").insert([
    { id: 1, state: "生成中" },
    { id: 2, state: "生成中" },
  ]);
  await db("o_tasks").insert([
    { id: 1, state: "进行中" },
    { id: 2, state: "进行中" },
  ]);
  await db("o_videoGenerationTask").insert([
    {
      id: 1,
      videoId: 1,
      taskCenterId: 1,
      requestJson: JSON.stringify(oldRequest),
      status: "queued",
      state: "排队中",
      rawOutput: "",
    },
    {
      id: 2,
      videoId: 2,
      taskCenterId: 2,
      requestJson: JSON.stringify(oldRequest),
      status: "processing",
      state: "生成中",
      submitId: "local-only",
      rawOutput: '{"gen_status":"querying"}',
    },
  ]);

  const first = await migrateVideoQueueV2(db, { createBackup: false, vacuum: false });
  assert.equal(first.migratedQueued, 1);
  assert.equal(first.failedFalseProcessing, 1);

  const queued = await db("o_videoGenerationTask").where("id", 1).first();
  assert.equal(String(queued.requestJson).includes(";base64,"), false);
  const migratedRequest = JSON.parse(queued.requestJson);
  assert.equal(migratedRequest.legacyReferences.length, 1);
  assert.deepEqual(fs.readFileSync(migratedRequest.legacyReferences[0].filePath), bytes);

  const falseProcessing = await db("o_videoGenerationTask").where("id", 2).first();
  assert.equal(falseProcessing.status, "failed");
  assert.match(falseProcessing.errorReason, /官方任务凭据/);

  const second = await migrateVideoQueueV2(db, { createBackup: false, vacuum: false });
  assert.equal(second.skipped, true);

  await recoverVideoQueueAfterRestart(db);
  assert.equal((await db("o_videoGenerationTask").where("id", 1).first()).status, "queued");
  await db.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("video queue v3 restores capacity failures without resubmitting uncertain tasks", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-video-slots-"));
  const db = knexFactory({
    client: "better-sqlite3",
    connection: { filename: path.join(dataDir, "queue.sqlite") },
    useNullAsDefault: true,
  });
  try {
    await db.schema.createTable("o_setting", (table) => {
      table.string("key").primary();
      table.text("value");
    });
    await db.schema.createTable("o_video", (table) => {
      table.integer("id").primary();
      table.string("state");
      table.string("errorReason");
    });
    await db.schema.createTable("o_tasks", (table) => {
      table.integer("id").primary();
      table.string("state");
      table.string("reason");
    });
    await db.schema.createTable("o_videoGenerationTask", (table) => {
      table.integer("id").primary();
      table.integer("videoId");
      table.integer("taskCenterId");
      table.string("model");
      table.string("providerModelKey");
      table.string("status");
      table.string("phase");
      table.string("state");
      table.string("submitId");
      table.string("officialTaskId");
      table.string("historyRecordId");
      table.integer("remoteConfirmedAt");
      table.string("errorReason");
      table.text("rawOutput");
      table.integer("nextSubmitTime");
      table.integer("nextPollTime");
      table.integer("capacityWaitStartedAt");
      table.string("lastProviderCode");
      table.integer("finishTime");
      table.integer("updateTime");
    });
    await db("o_video").insert([
      { id: 1, state: "生成失败" },
      { id: 2, state: "生成失败" },
      { id: 3, state: "生成失败" },
    ]);
    await db("o_tasks").insert([
      { id: 1, state: "生成失败" },
      { id: 2, state: "生成失败" },
      { id: 3, state: "生成失败" },
    ]);
    await db("o_videoGenerationTask").insert([
      {
        id: 1,
        videoId: 1,
        taskCenterId: 1,
        model: "dreamina:multimodal2video:seedance2.0",
        status: "failed",
        state: "生成失败",
        errorReason: "api error: ret=1310, message=ExceedConcurrencyLimit",
      },
      {
        id: 2,
        videoId: 2,
        taskCenterId: 2,
        model: "dreamina:text2video:seedance2.0fast",
        status: "failed",
        state: "生成失败",
        officialTaskId: "official-2",
        errorReason: "软件重启后无法确认供应商任务",
      },
      {
        id: 3,
        videoId: 3,
        taskCenterId: 3,
        model: "dreamina:multimodal2video:seedance2.0_vip",
        status: "failed",
        state: "生成失败",
        submitId: "local-only",
        errorReason: "未确认即梦官方任务创建成功",
      },
    ]);

    const result = await migrateVideoQueueV3(db);
    assert.equal(result.recoveredCapacity, 1);
    assert.equal(result.recoveredConfirmed, 1);

    const capacity = await db("o_videoGenerationTask").where("id", 1).first();
    assert.equal(capacity.status, "queued");
    assert.equal(capacity.phase, "capacity_wait");
    assert.equal(capacity.providerModelKey, "dreamina:seedance2.0");

    const confirmed = await db("o_videoGenerationTask").where("id", 2).first();
    assert.equal(confirmed.status, "processing");
    assert.equal(confirmed.providerModelKey, "dreamina:seedance2.0fast");

    const uncertain = await db("o_videoGenerationTask").where("id", 3).first();
    assert.equal(uncertain.status, "failed");
    assert.equal(uncertain.providerModelKey, "dreamina:seedance2.0_vip");
    assert.equal((await migrateVideoQueueV3(db)).skipped, true);
  } finally {
    await db.destroy();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
