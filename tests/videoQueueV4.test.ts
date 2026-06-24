import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { upgradeDreaminaModelsV5 } from "../src/lib/migrations/videoQueueV5";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-video-queue-v4-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.TOONFLOW_SKIP_DB_INIT = "1";
process.env.NODE_ENV = "test";

let db: any;
let queue: typeof import("../src/utils/videoGenerationQueue");
let migration: typeof import("../src/lib/migrations/videoQueueV4");
let config: typeof import("../src/lib/videoQueueConfig");

before(async () => {
  db = (await import("../src/utils/db")).db;
  queue = await import("../src/utils/videoGenerationQueue");
  migration = await import("../src/lib/migrations/videoQueueV4");
  config = await import("../src/lib/videoQueueConfig");

  await db.schema.createTable("o_setting", (table: any) => {
    table.string("key").primary();
    table.text("value");
  });
  await db.schema.createTable("o_vendorConfig", (table: any) => {
    table.string("id").primary();
    table.text("models");
  });
  await db.schema.createTable("o_video", (table: any) => {
    table.integer("id").primary();
    table.string("state");
    table.string("errorReason");
  });
  await db.schema.createTable("o_tasks", (table: any) => {
    table.integer("id").primary();
    table.string("state");
    table.string("reason");
  });
  await db.schema.createTable("o_videoGenerationTask", (table: any) => {
    table.integer("id").primary();
    table.integer("videoId");
    table.integer("taskCenterId");
    table.string("vendorId");
    table.string("model");
    table.string("providerModelKey");
    table.text("requestJson");
    table.string("phase");
    table.string("status");
    table.string("state");
    table.string("submitId");
    table.integer("providerSubmittedAt");
    table.integer("confirmStartedAt");
    table.integer("remoteConfirmedAt");
    table.string("errorReason");
    table.text("rawOutput");
    table.integer("nextSubmitTime");
    table.integer("nextPollTime");
    table.integer("startTime");
    table.integer("updateTime");
    table.integer("finishTime");
  });
});

after(async () => {
  await db?.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("provider work timeout ignores time spent in the local queue", () => {
  const now = Date.now();
  assert.equal(queue.isProviderWorkTimedOut({}, 6, now), false);
  assert.equal(
    queue.isProviderWorkTimedOut({ providerSubmittedAt: now - 30 * 60 * 1000 }, 6, now),
    false,
  );
  assert.equal(
    queue.isProviderWorkTimedOut({ providerSubmittedAt: now - 7 * 60 * 60 * 1000 }, 6, now),
    true,
  );
});

test("submitting, confirming and processing tasks occupy configured provider slots", async () => {
  const now = Date.now();
  await db("o_videoGenerationTask").insert([
    {
      id: 10,
      vendorId: "dreamina",
      model: "dreamina:multimodal2video:seedance2.0fast_vip",
      providerModelKey: "dreamina:seedance2.0fast_vip",
      requestJson: "{}",
      phase: "submitting",
      status: "submitting",
      state: "提交中",
      startTime: now,
    },
    {
      id: 11,
      vendorId: "dreamina",
      model: "dreamina:multimodal2video:seedance2.0fast_vip",
      providerModelKey: "dreamina:seedance2.0fast_vip",
      requestJson: "{}",
      phase: "confirming",
      status: "confirming",
      state: "提交中",
      submitId: "submit-11",
      startTime: now,
    },
    {
      id: 12,
      vendorId: "dreamina",
      model: "dreamina:multimodal2video:seedance2.0fast_vip",
      providerModelKey: "dreamina:seedance2.0fast_vip",
      requestJson: "{}",
      phase: "processing",
      status: "processing",
      state: "生成中",
      submitId: "submit-12",
      startTime: now,
    },
    {
      id: 13,
      vendorId: "dreamina",
      model: "dreamina:multimodal2video:seedance2.0fast_vip",
      providerModelKey: "dreamina:seedance2.0fast_vip",
      requestJson: "{}",
      phase: "queued",
      status: "queued",
      state: "排队中",
      startTime: now,
    },
  ]);

  assert.equal(
    await queue.occupiedProviderSlotCount("dreamina:seedance2.0fast_vip", db),
    3,
  );
});

test("only one process owner can hold the video queue scheduler lease", async () => {
  const now = Date.now();
  assert.equal(
    await queue.tryAcquireVideoQueueSchedulerLease(db, "owner-a", now, 10_000),
    true,
  );
  assert.equal(
    await queue.tryAcquireVideoQueueSchedulerLease(db, "owner-b", now + 1_000, 10_000),
    false,
  );
  assert.equal(
    await queue.tryAcquireVideoQueueSchedulerLease(db, "owner-b", now + 10_001, 10_000),
    true,
  );
});

test("queue config stores maxWorkHours and returns the compatibility alias", () => {
  assert.deepEqual(config.normalizeQueueConfigForStorage({ maxWaitHours: 8, maxConcurrent: 1 }), {
    maxConcurrent: 1,
    maxWorkHours: 8,
  });
  const compatible = config.addQueueConfigCompatibility({
    queueConfig: { maxWorkHours: 9 },
  });
  assert.equal(compatible.queueConfig.maxWorkHours, 9);
  assert.equal(compatible.queueConfig.maxWaitHours, 9);
});

test("Dreamina poll timing uses initial, processing, and queued intervals independently", () => {
  const queueConfig = {
    maxConcurrent: 1,
    pollInitialDelaySec: 10,
    pollMinIntervalSec: 20,
    pollMaxIntervalSec: 60,
    maxWorkHours: 6,
    maxWaitHours: 6,
  };
  assert.equal(queue.nextProviderPollDelayMs(queueConfig, undefined, false), 10_000);
  assert.equal(queue.nextProviderPollDelayMs(queueConfig, 2, true), 20_000);
  assert.equal(queue.nextProviderPollDelayMs(queueConfig, 1, true), 60_000);
});

test("Dreamina v5 model upgrade preserves custom polling and adds VIP 4K", () => {
  const models = [
    {
      type: "video",
      modelName: "multimodal2video:seedance2.0_vip",
      queueConfig: {
        pollInitialDelaySec: 60,
        pollMinIntervalSec: 120,
        pollMaxIntervalSec: 600,
        maxWorkHours: 9,
      },
      durationResolutionMap: [{ duration: [5], resolution: ["720p", "1080p"] }],
    },
    {
      type: "video",
      modelName: "multimodal2video:seedance2.0mini",
      queueConfig: {
        pollInitialDelaySec: 45,
        pollMinIntervalSec: 30,
        pollMaxIntervalSec: 90,
        maxWorkHours: 8,
      },
      durationResolutionMap: [{ duration: [5], resolution: ["720p"] }],
    },
  ];
  assert.equal(upgradeDreaminaModelsV5(models), 1);
  assert.deepEqual(models[0].queueConfig, {
    pollInitialDelaySec: 20,
    pollMinIntervalSec: 20,
    pollMaxIntervalSec: 60,
    maxWorkHours: 9,
  });
  assert.deepEqual(models[0].durationResolutionMap[0].resolution, ["720p", "1080p", "4K"]);
  assert.equal(models[1].queueConfig.pollInitialDelaySec, 45);
  assert.equal(models[1].queueConfig.maxWorkHours, 8);
});

test("v4 migration restores only timed-out official tasks and is idempotent", async () => {
  const now = Date.now();
  await db("o_vendorConfig").insert({
    id: "dreamina",
    models: JSON.stringify([
      {
        modelName: "multimodal2video:seedance2.0",
        type: "video",
        queueConfig: { maxConcurrent: 1, maxWaitHours: 6 },
      },
    ]),
  });
  await db("o_video").insert([
    { id: 1, state: "生成失败", errorReason: "old timeout" },
    { id: 2, state: "生成失败", errorReason: "old timeout" },
    { id: 3, state: "生成中", errorReason: "" },
  ]);
  await db("o_tasks").insert([
    { id: 1, state: "生成失败", reason: "old timeout" },
    { id: 2, state: "生成失败", reason: "old timeout" },
    { id: 3, state: "进行中", reason: "" },
  ]);
  await db("o_videoGenerationTask").insert([
    {
      id: 1,
      videoId: 1,
      taskCenterId: 1,
      vendorId: "dreamina",
      model: "dreamina:multimodal2video:seedance2.0",
      requestJson: "{}",
      phase: "failed",
      status: "failed",
      state: "生成失败",
      submitId: "official-submit-1",
      confirmStartedAt: now - 30 * 60 * 1000,
      errorReason: "任务等待超过 6 小时，已标记失败。submit_id=official-submit-1",
      startTime: now - 7 * 60 * 60 * 1000,
    },
    {
      id: 2,
      videoId: 2,
      taskCenterId: 2,
      vendorId: "dreamina",
      model: "dreamina:multimodal2video:seedance2.0",
      requestJson: "{}",
      phase: "failed",
      status: "failed",
      state: "生成失败",
      errorReason: "任务排队超过 6 小时，已标记失败。",
      startTime: now - 7 * 60 * 60 * 1000,
    },
    {
      id: 3,
      videoId: 3,
      taskCenterId: 3,
      vendorId: "dreamina",
      model: "dreamina:multimodal2video:seedance2.0",
      requestJson: "{}",
      phase: "capacity_wait",
      status: "queued",
      state: "排队中",
      startTime: now - 8 * 60 * 60 * 1000,
      nextSubmitTime: now,
    },
  ]);

  const first = await migration.migrateVideoQueueV4(db);
  assert.equal(first.restoredOfficialTasks, 1);
  assert.equal(first.migratedModels, 1);
  const restored = await db("o_videoGenerationTask").where("id", 1).first();
  assert.equal(restored.status, "confirming");
  assert.equal(restored.providerSubmittedAt, now - 30 * 60 * 1000);
  assert.equal(restored.nextPollTime > 0, true);
  assert.equal((await db("o_videoGenerationTask").where("id", 2).first()).status, "failed");
  assert.equal((await db("o_videoGenerationTask").where("id", 3).first()).status, "queued");

  const models = JSON.parse((await db("o_vendorConfig").where("id", "dreamina").first()).models);
  assert.equal(models[0].queueConfig.maxWorkHours, 6);
  assert.equal("maxWaitHours" in models[0].queueConfig, false);
  assert.equal((await migration.migrateVideoQueueV4(db)).skipped, true);
});

test("only a local queued task can be cancelled", async () => {
  const cancelled = await queue.cancelQueuedVideoGenerationTask(3, db, { schedule: false });
  assert.deepEqual(cancelled, {
    taskId: 3,
    videoId: 3,
    status: "cancelled",
    state: "已取消",
  });
  assert.equal((await db("o_videoGenerationTask").where("id", 3).first()).status, "cancelled");
  assert.equal((await db("o_video").where("id", 3).first()).state, "已取消");
  assert.equal((await db("o_tasks").where("id", 3).first()).state, "已取消");

  await db("o_video").insert({ id: 4, state: "生成中" });
  await db("o_tasks").insert({ id: 4, state: "进行中" });
  await db("o_videoGenerationTask").insert({
    id: 4,
    videoId: 4,
    taskCenterId: 4,
    vendorId: "dreamina",
    model: "dreamina:multimodal2video:seedance2.0",
    requestJson: "{}",
    phase: "submitting",
    status: "submitting",
    state: "提交中",
    startTime: Date.now(),
  });
  await assert.rejects(
    queue.cancelQueuedVideoGenerationTask(4, db, { schedule: false }),
    (cause: any) => cause instanceof queue.VideoQueueCancelError && cause.statusCode === 409,
  );
  assert.equal((await db("o_videoGenerationTask").where("id", 4).first()).status, "submitting");
});
