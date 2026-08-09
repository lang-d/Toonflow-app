import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import axios from "axios";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-video-queue-v6-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.TOONFLOW_SKIP_DB_INIT = "1";
process.env.NODE_ENV = "test";

let db: any;
let migration: typeof import("../src/lib/migrations/videoQueueV6");
let coordinator: typeof import("../src/services/taskCoordinator");
let worker: typeof import("../src/services/unifiedTaskWorker");
let handler: typeof import("../src/services/videoQueue/taskHandler");
let registry: typeof import("../src/services/videoQueue/registry");
let dreaminaCli: any;
let axiosClient: any;

async function insertTask(id: number, patch: Record<string, unknown> = {}) {
  const now = Date.now();
  await db("o_tasks").insert({
    id,
    taskId: `task-${id}`,
    version: 1,
    taskClass: "Video generation",
    taskType: "video",
    projectId: 1,
    scriptId: 1,
    episode: 1,
    businessType: "video-generation",
    businessId: id,
    handler: null,
    status: "processing",
    phase: "processing",
    progress: 35,
    state: "processing",
    priority: 0,
    attempt: 0,
    maxAttempts: 1,
    availableAt: now,
    createdAt: now,
    updateTime: now,
    startTime: now,
    ...patch,
  });
}

async function insertDetail(id: number, patch: Record<string, unknown> = {}) {
  const now = Date.now();
  await db("o_videoGenerationTask").insert({
    id,
    videoId: id,
    projectId: 1,
    scriptId: 1,
    taskCenterId: id,
    vendorId: "dreamina",
    model: "dreamina:multimodal2video:seedance2.0_vip",
    providerModelKey: "dreamina:seedance2.0_vip",
    requestJson: JSON.stringify({ version: 2, input: {}, references: [], relatedObjects: {} }),
    phase: "processing",
    status: "processing",
    state: "processing",
    startTime: now,
    updateTime: now,
    ...patch,
  });
}

before(async () => {
  db = (await import("../src/utils/db")).db;
  migration = await import("../src/lib/migrations/videoQueueV6");
  coordinator = await import("../src/services/taskCoordinator");
  worker = await import("../src/services/unifiedTaskWorker");
  handler = await import("../src/services/videoQueue/taskHandler");
  registry = await import("../src/services/videoQueue/registry");
  dreaminaCli = (await import("../src/utils/dreaminaCli")).default;
  axiosClient = axios;

  await db.schema.createTable("o_setting", (table: any) => {
    table.string("key").primary();
    table.text("value");
  });
  await db.schema.createTable("o_tasks", (table: any) => {
    table.integer("id").primary();
    table.string("taskId");
    table.integer("version");
    table.string("taskClass");
    table.string("taskType");
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("episode");
    table.string("targetType");
    table.string("targetId");
    table.string("nodeId");
    table.string("businessType");
    table.integer("businessId");
    table.string("handler");
    table.text("payloadJson");
    table.text("resultJson");
    table.string("status");
    table.string("phase");
    table.float("progress");
    table.string("state");
    table.text("reason");
    table.integer("priority");
    table.integer("attempt");
    table.integer("maxAttempts");
    table.integer("availableAt");
    table.string("providerTaskId");
    table.integer("providerSubmittedAt");
    table.string("idempotencyKey");
    table.string("model");
    table.string("describe");
    table.text("relatedObjects");
    table.string("leaseOwner");
    table.integer("leaseExpiresAt");
    table.integer("createdAt");
    table.integer("startTime");
    table.integer("updateTime");
    table.integer("finishTime");
  });
  await db.schema.createTable("o_taskEvent", (table: any) => {
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
    table.integer("businessId");
    table.string("status");
    table.string("phase");
    table.float("progress");
    table.text("resultJson");
    table.text("reason");
    table.integer("createdAt");
  });
  await db.schema.createTable("o_videoGenerationTask", (table: any) => {
    table.integer("id").primary();
    table.integer("videoId");
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("taskCenterId");
    table.string("vendorId");
    table.string("model");
    table.string("providerModelKey");
    table.string("providerCapacityKey");
    table.string("providerAccountId");
    table.text("requestJson");
    table.string("submitId");
    table.string("phase");
    table.string("status");
    table.string("state");
    table.integer("providerSubmittedAt");
    table.integer("nextSubmitTime");
    table.integer("nextPollTime");
    table.integer("startTime");
    table.integer("updateTime");
  });
  await db.schema.createTable("o_videoProviderCapacity", (table: any) => {
    table.increments("id");
    table.string("vendorId");
    table.string("providerAccountId");
    table.string("providerModelKey");
    table.integer("capacityBlocked");
    table.integer("blockedUntil");
    table.string("lastProviderCode");
    table.integer("createTime");
    table.integer("updateTime");
    table.unique(["vendorId", "providerAccountId", "providerModelKey"]);
  });
});

after(async () => {
  await db?.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("v6 migration makes unified tasks authoritative and is idempotent", async () => {
  const now = Date.now();
  await insertTask(1, { status: "queued", phase: "queued" });
  await insertTask(2, { status: "processing", phase: "processing" });
  await insertTask(3, { status: "submitting", phase: "submitting" });
  await insertTask(4, { status: "processing", phase: "confirming" });
  await insertTask(5, { status: "completed", phase: "completed", progress: 100 });
  await insertDetail(1, { vendorId: "zealman", model: "zealman:minimax-h3-u06", providerModelKey: "zealman:minimax-h3-u06", status: "queued", phase: "remote_unavailable", nextSubmitTime: now });
  await insertDetail(2, { vendorId: "zealman", model: "zealman:minimax-h3-u06", providerModelKey: "zealman:minimax-h3-u06", providerAccountId: "https://node.example:8443/", submitId: "prompt-2", status: "processing", phase: "processing", providerSubmittedAt: now - 1000, nextPollTime: now });
  await insertDetail(3, { status: "submitting", phase: "submitting" });
  await insertDetail(4, { submitId: "submit-4", status: "confirming", phase: "confirming", providerSubmittedAt: now - 1000, nextPollTime: now });
  await insertDetail(5, { status: "completed", phase: "completed" });

  const result = await migration.migrateVideoQueueV6(db);
  assert.equal(result.skipped, false);
  const queued = await db("o_tasks").where("id", 1).first();
  assert.equal(queued.handler, "video-generation");
  assert.equal(queued.status, "queued");
  assert.deepEqual(JSON.parse(queued.payloadJson), { queueTaskId: 1 });

  const zealman = await db("o_tasks").where("id", 2).first();
  assert.equal(zealman.status, "processing");
  assert.equal(zealman.providerTaskId, "prompt-2");
  assert.equal(zealman.progress, null);
  assert.equal((await db("o_videoGenerationTask").where("id", 2).first()).providerCapacityKey, "zealman:https://node.example:8443");

  assert.equal((await db("o_tasks").where("id", 3).first()).status, "queued");
  assert.equal((await db("o_tasks").where("id", 4).first()).status, "processing");
  assert.equal((await db("o_tasks").where("id", 4).first()).providerTaskId, "submit-4");
  assert.equal((await db("o_videoGenerationTask").where("id", 4).first()).providerCapacityKey, "dreamina:seedance2.0_vip");
  assert.equal((await migration.migrateVideoQueueV6(db)).skipped, true);
});

test("restart recovery polls saved provider ids and requeues only pre-submit video work", async () => {
  const expired = Date.now() - 1000;
  await insertTask(20, { handler: "video-generation", payloadJson: JSON.stringify({ queueTaskId: 20 }), leaseExpiresAt: expired, phase: "submitting" });
  await insertDetail(20, { status: "submitting", phase: "submitting", submitId: null });
  await insertTask(21, { handler: "video-generation", payloadJson: JSON.stringify({ queueTaskId: 21 }), leaseExpiresAt: expired, phase: "submitting" });
  await insertDetail(21, { status: "processing", phase: "processing", submitId: "remote-21" });

  await worker.recoverInterruptedUnifiedTasks(db);
  const preSubmit = await db("o_tasks").where("id", 20).first();
  assert.equal(preSubmit.status, "queued");
  assert.equal(preSubmit.providerTaskId, null);
  const submitted = await db("o_tasks").where("id", 21).first();
  assert.equal(submitted.status, "processing");
  assert.equal(submitted.phase, "resume-provider-query");
  assert.equal(submitted.providerTaskId, "remote-21");
});

test("normal provider polling waits are never recovered or pulled ahead of availableAt", async () => {
  const now = Date.now();
  await insertTask(22, {
    handler: "video-generation",
    payloadJson: JSON.stringify({ queueTaskId: 22 }),
    providerTaskId: "remote-22",
    status: "processing",
    phase: "remote_reconcile",
    availableAt: now + 60_000,
    leaseExpiresAt: null,
  });
  await insertDetail(22, { status: "processing", phase: "remote_reconcile", submitId: "remote-22" });

  assert.equal(await worker.recoverInterruptedUnifiedTasks(db), 0);
  let task = await db("o_tasks").where("id", 22).first();
  assert.equal(task.phase, "remote_reconcile");
  assert.equal(task.availableAt, now + 60_000);
  assert.equal(task.version, 1);
  assert.equal((await coordinator.whereRunnableUnifiedTask(db("o_tasks"), now).where("id", 22)).length, 0);

  await db("o_tasks").where("id", 22).update({ availableAt: now - 1 });
  assert.equal(await worker.recoverInterruptedUnifiedTasks(db), 0);
  task = await db("o_tasks").where("id", 22).first();
  assert.equal(task.phase, "remote_reconcile");
  assert.equal((await coordinator.whereRunnableUnifiedTask(db("o_tasks"), now).where("id", 22)).length, 1);
});

test("processing video polls are runnable and stale callbacks lose CAS", async () => {
  const now = Date.now();
  await insertTask(30, {
    handler: "video-generation",
    payloadJson: JSON.stringify({ queueTaskId: 30 }),
    providerTaskId: "remote-30",
    status: "processing",
    phase: "processing",
    availableAt: now - 1,
  });
  await insertDetail(30, { submitId: "remote-30" });
  await insertTask(31, {
    handler: "video-generation",
    payloadJson: JSON.stringify({ queueTaskId: 31 }),
    providerTaskId: "remote-31",
    status: "processing",
    phase: "finalizing",
    availableAt: now - 1,
  });
  await insertDetail(31, { submitId: "remote-31" });

  const runnable = await coordinator.whereRunnableUnifiedTask(db("o_tasks"), now).whereIn("id", [30, 31]);
  assert.deepEqual(runnable.map((row: any) => row.id), [30]);
  assert.equal(await coordinator.updateUnifiedTask(30, { status: "failed", expectedVersion: 99 }, db), null);
  const updated = await coordinator.updateUnifiedTask(30, {
    status: "failed",
    phase: "failed",
    expectedVersion: 1,
    expectedStatus: "processing",
    expectedProviderTaskId: "remote-30",
  }, db);
  assert.equal(updated?.status, "failed");
  assert.equal(await coordinator.updateUnifiedTask(30, {
    status: "completed",
    expectedVersion: 1,
    expectedStatus: "processing",
    expectedProviderTaskId: "remote-30",
  }, db), null);
  assert.equal(coordinator.formatTaskEvent({
    id: 1,
    taskId: "task-progress-null",
    version: 1,
    taskType: "video",
    projectId: 1,
    businessId: 42,
    status: "processing",
    phase: "processing",
    progress: null,
    createdAt: now,
  }).progress, null);
  assert.equal(coordinator.formatTaskEvent({
    id: 1,
    taskId: "task-video-business-id",
    version: 1,
    taskType: "video",
    projectId: 1,
    businessId: 42,
    status: "processing",
    createdAt: now,
  }).businessId, 42);
});

test("task snapshot preserves video businessId while targetId remains the track", async () => {
  await insertTask(42, {
    taskId: "task-video-candidate-42",
    targetType: "videoTrack",
    targetId: "track-7",
    businessId: 9001,
  });
  const tasks = await coordinator.getTaskSnapshot({ projectId: 1, taskIds: ["task-video-candidate-42"] }, db);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].taskId, "task-video-candidate-42");
  assert.equal(tasks[0].targetType, "videoTrack");
  assert.equal(tasks[0].targetId, "track-7");
  assert.equal(tasks[0].businessId, 9001);
});

test("persisted task events expose the video businessId for Socket delivery", async () => {
  const created = await coordinator.createUnifiedTask({
    taskId: "task-video-socket-43",
    projectId: 1,
    scriptId: 1,
    taskClass: "Video generation",
    taskType: "video",
    targetType: "videoTrack",
    targetId: "track-8",
    businessType: "video-generation",
    businessId: 9002,
    handler: "video-generation",
  }, db);
  const event = await db("o_taskEvent").where("id", created.eventId).first();
  assert.equal(event.businessId, 9002);
  assert.equal(coordinator.formatTaskEvent(event).businessId, 9002);
  assert.equal(coordinator.formatTaskEvent(event).targetId, "track-8");
});

test("capacity reservation is atomic and changes the authoritative phase", async () => {
  await insertTask(40, { handler: "video-generation", payloadJson: JSON.stringify({ queueTaskId: 40 }) });
  await insertDetail(40);
  await insertTask(41, { handler: "video-generation", payloadJson: JSON.stringify({ queueTaskId: 41 }) });
  await insertDetail(41);
  const candidate = [{ key: "zealman:https://one.example:8443", limit: 1, providerAccountId: "https://one.example:8443" }];
  const rows = await Promise.all([
    handler.claimVideoProviderCapacity(await db("o_videoGenerationTask").where("id", 40).first(), await db("o_tasks").where("id", 40).first(), candidate),
    handler.claimVideoProviderCapacity(await db("o_videoGenerationTask").where("id", 41).first(), await db("o_tasks").where("id", 41).first(), candidate),
  ]);
  assert.equal(rows.filter(Boolean).length, 1);
  const occupied = await db("o_videoGenerationTask").where("providerCapacityKey", candidate[0].key);
  assert.equal(occupied.length, 1);
  assert.equal((await db("o_tasks").where("id", occupied[0].taskCenterId).first()).phase, "submitting");
});

test("executor registry normalizes model capacity keys and honors Dreamina cooldown", async () => {
  const executor = registry.getVideoProviderExecutor("dreamina");
  const context: any = {
    row: { vendorId: "dreamina", providerModelKey: "dreamina:seedance2.0_vip" },
    task: {},
    request: { input: {} },
    modelName: "multimodal2video:seedance2.0_vip",
    modelConfig: { queueConfig: { maxConcurrent: 2 } },
    references: async () => [],
  };
  const ready = await executor.reserveSubmission(context);
  assert.equal(ready.kind, "ready");
  if (ready.kind === "ready") {
    assert.equal(ready.candidates[0].key, "dreamina:seedance2.0_vip");
    assert.equal(ready.candidates[0].limit, 2);
  }
  const now = Date.now();
  await db("o_videoProviderCapacity").insert({
    vendorId: "dreamina",
    providerAccountId: "default",
    providerModelKey: "dreamina:seedance2.0_vip",
    capacityBlocked: 1,
    blockedUntil: now + 60_000,
    createTime: now,
    updateTime: now,
  });
  const waiting = await executor.reserveSubmission(context);
  assert.equal(waiting.kind, "wait");
  if (waiting.kind === "wait") assert.equal(waiting.phase, "capacity_wait");
  assert.equal(registry.getVideoProviderExecutor("unknown").vendorId, "*");
});

test("Dreamina executor returns the unified wait, accepted, pending, and completed outcomes", async () => {
  const executor = registry.getVideoProviderExecutor("dreamina");
  const originalSubmit = dreaminaCli.videoSubmit;
  const originalPoll = dreaminaCli.videoPoll;
  const context: any = {
    row: {
      vendorId: "dreamina",
      providerModelKey: "dreamina:seedance2.0_vip",
      providerSubmittedAt: Date.now() - 1000,
      pollCount: 0,
    },
    task: { phase: "processing", providerTaskId: "submit-contract" },
    request: { input: { prompt: "test" } },
    modelName: "multimodal2video:seedance2.0_vip",
    modelConfig: { queueConfig: { maxConcurrent: 1, pollInitialDelaySec: 1, pollMinIntervalSec: 1, pollMaxIntervalSec: 2, maxWorkHours: 6 } },
    references: async () => [],
  };
  const reservation = { key: "dreamina:seedance2.0_vip", limit: 1 };
  try {
    dreaminaCli.videoSubmit = async () => ({ state: "capacity_wait", providerCode: "1310", rawOutput: "full" });
    const waiting = await executor.submit(context, reservation);
    assert.equal(waiting.kind, "wait");
    if (waiting.kind === "wait") assert.equal(waiting.phase, "capacity_wait");

    dreaminaCli.videoSubmit = async () => ({ state: "submitted", submitId: "submit-contract", confirmed: true, rawOutput: "ok" });
    const accepted = await executor.submit(context, reservation);
    assert.equal(accepted.kind, "accepted");
    if (accepted.kind === "accepted") assert.equal(accepted.providerTaskId, "submit-contract");

    dreaminaCli.videoPoll = async () => ({
      state: "generating",
      rawOutput: "working",
      evidence: { confirmed: true },
      queueInfo: { status: 2 },
    });
    const pending = await executor.poll(context);
    assert.equal(pending.kind, "pending");
    if (pending.kind === "pending") assert.equal(pending.phase, "processing");

    dreaminaCli.videoPoll = async () => ({
      state: "success",
      data: "data:video/mp4;base64,AA==",
      dataType: "base64",
      rawOutput: "done",
      evidence: { confirmed: true },
      queueInfo: {},
    });
    const completed = await executor.poll(context);
    assert.equal(completed.kind, "completed");
  } finally {
    dreaminaCli.videoSubmit = originalSubmit;
    dreaminaCli.videoPoll = originalPoll;
  }
});

test("Zealman executor confirms lost and unavailable remote tasks twice without resubmission", async () => {
  const executor = registry.getVideoProviderExecutor("zealman");
  const originalGet = axiosClient.get;
  const context: any = {
    row: {
      vendorId: "zealman",
      providerModelKey: "zealman:minimax-h3-u06",
      providerAccountId: "https://node.example:8443",
      providerSubmittedAt: Date.now() - 61_000,
      submitId: "prompt-contract",
    },
    task: { phase: "processing", providerTaskId: "prompt-contract" },
    request: { input: { audio: false } },
    modelName: "minimax-h3-u06",
    modelConfig: { queueConfig: { pollMinIntervalSec: 2, maxWorkHours: 6 } },
    references: async () => [],
  };
  try {
    axiosClient.get = async (url: string) => {
      if (url.endsWith("/api/workflow/result")) return { data: { pending: true } };
      if (url.endsWith("/api/comfy/queue-status")) return { data: { busy: false, running_count: 0, pending_count: 0 } };
      if (url.endsWith("/api/comfy/proxy/history")) return { data: {} };
      throw new Error(`unexpected URL ${url}`);
    };
    const firstMissing = await executor.poll(context);
    assert.equal(firstMissing.kind, "pending");
    if (firstMissing.kind === "pending") assert.equal(firstMissing.phase, "remote_reconcile");
    const confirmedMissing = await executor.poll({ ...context, task: { ...context.task, phase: "remote_reconcile" } });
    assert.equal(confirmedMissing.kind, "failed");

    axiosClient.get = async () => { throw new Error("instance powered off"); };
    const firstUnavailable = await executor.poll(context);
    assert.equal(firstUnavailable.kind, "pending");
    if (firstUnavailable.kind === "pending") assert.equal(firstUnavailable.phase, "remote_unavailable_reconcile");
    const confirmedUnavailable = await executor.poll({ ...context, task: { ...context.task, phase: "remote_unavailable_reconcile" } });
    assert.equal(confirmedUnavailable.kind, "failed");
  } finally {
    axiosClient.get = originalGet;
  }
});
