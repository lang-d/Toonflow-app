import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-storyboard-generation-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let db: any;
let service: typeof import("../src/services/storyboardGeneration");

function groupName(groupKey: string) {
  return groupKey === "G01" ? "Opening" : "Escalation";
}

function groupIntent(groupKey: string) {
  return groupKey === "G01" ? "Establish the character relationship" : "Escalate the visible conflict";
}

function row(index: number, groupKey = index < 6 ? "G01" : "G02") {
  return {
    version: 1 as const,
    index,
    groupKey,
    groupName: groupName(groupKey),
    groupIntent: groupIntent(groupKey),
    beatId: `B${String(index + 1).padStart(2, "0")}`,
    durationSec: 3,
    location: "Interior room",
    timeOfDay: "Day",
    picture: `Storyboard picture ${index + 1}`,
    shotSize: "Medium shot",
    cameraMove: "Static",
    action: `Character completes action ${index + 1}`,
    characters: [
      {
        assetId: 1,
        name: "Hero",
        action: `Action ${index + 1}`,
        orientation: "Facing right",
        spatialPosition: "Center foreground",
      },
    ],
    visibleEmotion: "Steady gaze and calm breath",
    dialogue: [],
    soundEffects: ["Room tone"],
    requiredAssets: [
      { assetId: 1, name: "Hero", type: "role" as const, order: 0 },
      { assetId: 2, name: "Interior room", type: "scene" as const, order: 1 },
    ],
  };
}

function plan(groupKey: string, indexes: number[]) {
  return {
    groupKey,
    groupName: groupName(groupKey),
    groupIntent: groupIntent(groupKey),
    storyboardIndexes: indexes,
  };
}

async function countRows(table: string, where: Record<string, unknown>) {
  const value = await db(table).where(where).count({ count: "*" }).first();
  return Number(value.count);
}

before(async () => {
  db = (await import("../src/utils/db")).db;
  service = await import("../src/services/storyboardGeneration");
  await db.schema.createTable("o_project", (table: any) => {
    table.integer("id").primary();
    table.string("videoModel");
  });
  await db.schema.createTable("o_vendorConfig", (table: any) => {
    table.string("id").primary();
    table.text("models");
  });
  await db.schema.createTable("o_script", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.string("name");
    table.text("content");
  });
  await db.schema.createTable("o_assets", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.string("name");
    table.string("type");
  });
  await db.schema.createTable("o_storyboard", (table: any) => {
    table.increments("id");
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("index");
    table.integer("trackId");
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
    table.string("state");
    table.integer("shouldGenerateImage");
    table.text("referenceImages");
    table.integer("createTime");
  });
  await db.schema.createTable("o_assets2Storyboard", (table: any) => {
    table.integer("storyboardId");
    table.integer("assetId");
  });
  await db.schema.createTable("o_videoTrack", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("duration");
    table.string("groupKey");
    table.string("groupName");
    table.string("groupIntent");
    table.text("groupPlanJson");
    table.text("musicPlanJson");
    table.string("reviewState");
    table.text("reviewIssuesJson");
    table.integer("archived").defaultTo(0);
  });
  await db.schema.createTable("o_storyboardGeneration", (table: any) => {
    table.increments("id");
    table.string("generationId").unique();
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("expectedRowCount");
    table.text("groupPlanJson");
    table.string("state");
    table.integer("revision");
    table.text("errorJson");
    table.integer("createdAt");
    table.integer("updatedAt");
  });
  await db.schema.createTable("o_storyboardGenerationRow", (table: any) => {
    table.increments("id");
    table.string("generationId");
    table.integer("rowIndex");
    table.text("rowJson");
    table.string("rowHash");
    table.integer("createdAt");
    table.integer("updatedAt");
    table.unique(["generationId", "rowIndex"]);
  });
  await db("o_project").insert({ id: 1, videoModel: "" });
  await db("o_vendorConfig").insert({
    id: "dreamina",
    models: JSON.stringify([
      {
        type: "video",
        modelName: "short-video",
        name: "Short Video",
        durationResolutionMap: [{ duration: [5], resolution: ["720p"] }],
      },
    ]),
  });
  await db("o_script").insert(
    [10, 20, 21, 22, 23, 24, 30, 40, 50, 60, 61, 70, 80, 90].map((id) => ({
      id,
      projectId: 1,
      name: `script-${id}`,
      content: `script ${id}`,
    })),
  );
  await db("o_assets").insert([
    { id: 1, projectId: 1, name: "Hero", type: "role" },
    { id: 2, projectId: 1, name: "Interior room", type: "scene" },
  ]);
});

after(async () => {
  await db?.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("storyboard generation resumes batches, is idempotent, and commits atomically", async () => {
  const started = await service.beginStoryboardGeneration({
    projectId: 1,
    scriptId: 10,
    expectedRowCount: 12,
    groups: [plan("G01", [0, 1, 2, 3, 4, 5]), plan("G02", [6, 7, 8, 9, 10, 11])],
  });
  const firstRows = Array.from({ length: 10 }, (_, index) => row(index));
  const first = await service.appendStoryboardRows({
    generationId: started.generationId,
    startIndex: 0,
    rows: firstRows,
  });
  assert.equal(first.accepted, 10);
  assert.equal(first.nextIndex, 10);

  const retry = await service.appendStoryboardRows({
    generationId: started.generationId,
    startIndex: 0,
    rows: firstRows,
  });
  assert.equal(retry.accepted, 0);
  assert.equal(retry.nextIndex, 10);

  const second = await service.appendStoryboardRows({
    generationId: started.generationId,
    startIndex: 10,
    rows: [row(10), row(11)],
  });
  assert.equal(second.nextIndex, 12);

  const committed = await service.commitStoryboardGeneration(started.generationId);
  assert.equal(committed.status, "committed");
  if (committed.status !== "committed") return;
  assert.equal(committed.rowCount, 12);
  assert.equal(await countRows("o_storyboard", { projectId: 1, scriptId: 10 }), 12);
  assert.equal(await countRows("o_storyboardGenerationRow", { generationId: started.generationId }), 0);
  const saved = await db("o_storyboard").where({ projectId: 1, scriptId: 10 }).orderBy("index", "asc");
  assert.ok(saved.every((item: any) => item.factStatus === "ready" && item.videoDesc === ""));
  assert.equal((await db("o_videoTrack").where({ projectId: 1, scriptId: 10, archived: 0 })).length, 2);
});

test("begin rejects missing or cross-project script scope", async () => {
  await assert.rejects(
    () =>
      service.beginStoryboardGeneration({
        projectId: 1,
        scriptId: 999,
        expectedRowCount: 1,
        groups: [plan("G01", [0])],
      }),
    /script 999 does not exist in project 1/,
  );
});

test("append accepts out-of-order batches and commit writes formal rows by index", async () => {
  const started = await service.beginStoryboardGeneration({
    projectId: 1,
    scriptId: 60,
    expectedRowCount: 4,
    groups: [plan("G01", [0, 1]), plan("G02", [2, 3])],
  });

  const later = await service.appendStoryboardRows({
    generationId: started.generationId,
    startIndex: 2,
    rows: [row(2, "G02"), row(3, "G02")],
  });
  assert.equal(later.accepted, 2);
  assert.equal(later.nextIndex, 0);
  assert.equal(later.totalAccepted, 2);

  const incomplete = await service.commitStoryboardGeneration(started.generationId);
  assert.equal(incomplete.status, "invalid");
  assert.equal(await countRows("o_storyboard", { projectId: 1, scriptId: 60 }), 0);

  const earlier = await service.appendStoryboardRows({
    generationId: started.generationId,
    startIndex: 0,
    rows: [row(0, "G01"), row(1, "G01")],
  });
  assert.equal(earlier.accepted, 2);
  assert.equal(earlier.nextIndex, 4);
  assert.equal(earlier.totalAccepted, 4);

  const committed = await service.commitStoryboardGeneration(started.generationId);
  assert.equal(committed.status, "committed");
  const saved = await db("o_storyboard").where({ projectId: 1, scriptId: 60 }).orderBy("index", "asc");
  assert.deepEqual(
    saved.map((item: any) => item.index),
    [0, 1, 2, 3],
  );
});

test("new generation supersedes unfinished generation for the same script", async () => {
  const first = await service.beginStoryboardGeneration({
    projectId: 1,
    scriptId: 61,
    expectedRowCount: 2,
    groups: [plan("G01", [0, 1])],
  });
  await service.appendStoryboardRows({
    generationId: first.generationId,
    startIndex: 0,
    rows: [row(0, "G01")],
  });

  const second = await service.beginStoryboardGeneration({
    projectId: 1,
    scriptId: 61,
    expectedRowCount: 1,
    groups: [plan("G01", [0])],
  });
  const firstState = await db("o_storyboardGeneration").where({ generationId: first.generationId }).first();
  assert.equal(firstState.state, "superseded");

  const oldCommit = await service.commitStoryboardGeneration(first.generationId);
  assert.equal(oldCommit.status, "failed");
  if (oldCommit.status === "failed") assert.equal(oldCommit.error.code, "GENERATION_SUPERSEDED");

  await service.appendStoryboardRows({
    generationId: second.generationId,
    startIndex: 0,
    rows: [{ ...row(0, "G01"), picture: "new generation picture" }],
  });
  assert.equal((await service.commitStoryboardGeneration(second.generationId)).status, "committed");
  const saved = await db("o_storyboard").where({ projectId: 1, scriptId: 61 }).first();
  assert.equal(saved.picture, "new generation picture");
});

test("commit accepts brief row group intent and normalizes formal rows from the group plan", async () => {
  const started = await service.beginStoryboardGeneration({
    projectId: 1,
    scriptId: 20,
    expectedRowCount: 2,
    groups: [plan("G01", [0, 1])],
  });
  await service.appendStoryboardRows({
    generationId: started.generationId,
    startIndex: 0,
    rows: [
      { ...row(0, "G01"), groupIntent: "brief intent" },
      { ...row(1, "G01"), groupName: "Short name", groupIntent: "another brief intent" },
    ],
  });

  const result = await service.commitStoryboardGeneration(started.generationId);
  assert.equal(result.status, "committed");
  const saved = await db("o_storyboard").where({ projectId: 1, scriptId: 20 }).orderBy("index", "asc");
  assert.equal(saved.length, 2);
  assert.ok(saved.every((item: any) => item.groupName === groupName("G01")));
  assert.ok(saved.every((item: any) => item.groupIntent === groupIntent("G01")));
  assert.ok(saved.every((item: any) => JSON.parse(item.tableRowJson).groupIntent === groupIntent("G01")));
});

test("chinese storyboard group keys are normalized to stable ASCII keys", async () => {
  const started = await service.beginStoryboardGeneration({
    projectId: 1,
    scriptId: 70,
    expectedRowCount: 4,
    groups: [
      { groupKey: "围剿", groupName: "围剿", groupIntent: "Close the box together", storyboardIndexes: [0, 1] },
      { groupKey: "反击", groupName: "反击", groupIntent: "The receipt fights back", storyboardIndexes: [2, 3] },
    ],
  });
  const append = await service.appendStoryboardRows({
    generationId: started.generationId,
    startIndex: 0,
    rows: [
      { ...row(0, "围剿"), groupName: "围剿", groupIntent: "row intent A" },
      { ...row(1, "围剿"), groupName: "围剿", groupIntent: "row intent A" },
      { ...row(2, "反击"), groupName: "反击", groupIntent: "row intent B" },
      { ...row(3, "反击"), groupName: "反击", groupIntent: "row intent B" },
    ],
  });
  assert.equal(append.accepted, 4);

  const draftRows = await db("o_storyboardGenerationRow").where({ generationId: started.generationId }).orderBy("rowIndex", "asc");
  assert.deepEqual(
    draftRows.map((item: any) => JSON.parse(item.rowJson).groupKey),
    ["G01", "G01", "G02", "G02"],
  );

  const result = await service.commitStoryboardGeneration(started.generationId);
  assert.equal(result.status, "committed");
  const saved = await db("o_storyboard").where({ projectId: 1, scriptId: 70 }).orderBy("index", "asc");
  assert.deepEqual(
    saved.map((item: any) => item.groupKey),
    ["G01", "G01", "G02", "G02"],
  );
  assert.deepEqual(
    saved.map((item: any) => item.groupName),
    ["围剿", "围剿", "反击", "反击"],
  );
  assert.ok(saved.every((item: any) => JSON.parse(item.tableRowJson).groupKey === item.groupKey));

  const tracks = await db("o_videoTrack").where({ projectId: 1, scriptId: 70, archived: 0 }).orderBy("groupKey", "asc");
  assert.deepEqual(
    tracks.map((item: any) => ({ groupKey: item.groupKey, groupName: item.groupName })),
    [
      { groupKey: "G01", groupName: "围剿" },
      { groupKey: "G02", groupName: "反击" },
    ],
  );
});

test("conflicting retry and incomplete commit never replace formal rows", async () => {
  const before = await countRows("o_storyboard", { projectId: 1, scriptId: 10 });
  const started = await service.beginStoryboardGeneration({
    projectId: 1,
    scriptId: 10,
    expectedRowCount: 2,
    groups: [plan("G01", [0, 1])],
  });
  await service.appendStoryboardRows({
    generationId: started.generationId,
    startIndex: 0,
    rows: [row(0, "G01")],
  });
  const conflictRow = { ...row(0, "G01"), picture: "Different content" };
  const conflict = await service.appendStoryboardRows({
    generationId: started.generationId,
    startIndex: 0,
    rows: [conflictRow],
  });
  assert.equal(conflict.accepted, 0);
  assert.ok(conflict.issues.length > 0);
  const commit = await service.commitStoryboardGeneration(started.generationId);
  assert.equal(commit.status, "invalid");
  const generation = await db("o_storyboardGeneration").where({ generationId: started.generationId }).first();
  assert.equal(generation.state, "invalid");
  assert.match(generation.errorJson, /expectedRowCount/);
  assert.equal(await countRows("o_storyboard", { projectId: 1, scriptId: 10 }), before);
});

test("commit repairs wrong groupKey from the unique storyboard index owner", async () => {
  const wrongIndex = await service.beginStoryboardGeneration({
    projectId: 1,
    scriptId: 22,
    expectedRowCount: 2,
    groups: [plan("G01", [0]), plan("G02", [1])],
  });
  await service.appendStoryboardRows({
    generationId: wrongIndex.generationId,
    startIndex: 0,
    rows: [row(0, "G01"), row(1, "G01")],
  });

  const result = await service.commitStoryboardGeneration(wrongIndex.generationId);

  assert.equal(result.status, "committed");
  if (result.status === "committed") {
    assert.deepEqual(result.repairs, [{ index: 1, fromGroupKey: "G01", toGroupKey: "G02", reason: "index-owner" }]);
  }
  const saved = await db("o_storyboard").where({ projectId: 1, scriptId: 22 }).orderBy("index", "asc");
  assert.equal(saved[1].groupKey, "G02");
  assert.equal(saved[1].groupName, "Escalation");
  assert.equal(saved[1].groupIntent, "Escalate the visible conflict");
});

test("commit keeps invalid status when storyboard index is not owned by any group", async () => {
  const unknown = await service.beginStoryboardGeneration({
    projectId: 1,
    scriptId: 21,
    expectedRowCount: 2,
    groups: [plan("G01", [0])],
  });
  await service.appendStoryboardRows({
    generationId: unknown.generationId,
    startIndex: 0,
    rows: [row(0, "G01"), row(1, "G01")],
  });

  const result = await service.commitStoryboardGeneration(unknown.generationId);

  assert.equal(result.status, "invalid");
  if (result.status === "invalid") {
    assert.ok(result.issues.some((issue) => issue.message.includes("row index 1 is not listed in group G01")));
  }
  assert.equal(await countRows("o_storyboard", { projectId: 1, scriptId: 21 }), 0);
});

test("commit keeps invalid status when storyboard index has multiple group owners", async () => {
  const ambiguous = await service.beginStoryboardGeneration({
    projectId: 1,
    scriptId: 24,
    expectedRowCount: 1,
    groups: [plan("G01", [0]), plan("G02", [0])],
  });
  await service.appendStoryboardRows({
    generationId: ambiguous.generationId,
    startIndex: 0,
    rows: [row(0, "G01")],
  });

  const result = await service.commitStoryboardGeneration(ambiguous.generationId);

  assert.equal(result.status, "invalid");
  if (result.status === "invalid") {
    assert.equal(result.repairs, undefined);
    assert.ok(result.issues.some((issue) => issue.field === "groups.G02"));
  }
  assert.equal(await countRows("o_storyboard", { projectId: 1, scriptId: 24 }), 0);
});

test("commit rejects storyboard groups that exceed the default video model duration", async () => {
  await db("o_project").where({ id: 1 }).update({ videoModel: "dreamina:short-video" });
  try {
    const started = await service.beginStoryboardGeneration({
      projectId: 1,
      scriptId: 80,
      expectedRowCount: 3,
      groups: [plan("G01", [0, 1, 2])],
    });
    await service.appendStoryboardRows({
      generationId: started.generationId,
      startIndex: 0,
      rows: [row(0, "G01"), row(1, "G01"), row(2, "G01")],
    });

    const result = await service.commitStoryboardGeneration(started.generationId);
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      assert.ok(result.issues.some((issue) => issue.field === "groups.G01.durationSec"));
      assert.ok(result.issues.some((issue) => issue.message.includes("exceeds Short Video max duration 5s")));
    }
    assert.equal(await countRows("o_storyboard", { projectId: 1, scriptId: 80 }), 0);
  } finally {
    await db("o_project").where({ id: 1 }).update({ videoModel: "" });
  }
});

test("commit repairs wrong groupKey before duration validation", async () => {
  await db("o_project").where({ id: 1 }).update({ videoModel: "dreamina:short-video" });
  try {
    const started = await service.beginStoryboardGeneration({
      projectId: 1,
      scriptId: 23,
      expectedRowCount: 4,
      groups: [plan("G01", [0]), plan("G02", [1, 2, 3])],
    });
    await service.appendStoryboardRows({
      generationId: started.generationId,
      startIndex: 0,
      rows: [row(0, "G01"), row(1, "G01"), row(2, "G01"), row(3, "G01")],
    });

    const result = await service.commitStoryboardGeneration(started.generationId);

    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      assert.deepEqual(result.repairs, [
        { index: 1, fromGroupKey: "G01", toGroupKey: "G02", reason: "index-owner" },
        { index: 2, fromGroupKey: "G01", toGroupKey: "G02", reason: "index-owner" },
        { index: 3, fromGroupKey: "G01", toGroupKey: "G02", reason: "index-owner" },
      ]);
      assert.ok(result.issues.some((issue) => issue.field === "groups.G02.durationSec"));
      assert.equal(result.issues.some((issue) => issue.message.includes("row index 1 is not listed in group G01")), false);
    }
    const generation = await db("o_storyboardGeneration").where({ generationId: started.generationId }).first();
    assert.match(generation.errorJson, /"repairs"/);
    assert.match(generation.errorJson, /groups\.G02\.durationSec/);
    assert.equal(await countRows("o_storyboard", { projectId: 1, scriptId: 23 }), 0);
  } finally {
    await db("o_project").where({ id: 1 }).update({ videoModel: "" });
  }
});

test("transaction failure is recorded as failed and keeps existing formal rows", async () => {
  await db("o_storyboard").insert({
    projectId: 1,
    scriptId: 30,
    index: 0,
    factStatus: "legacy",
    factVersion: 1,
    factRevision: 0,
    tableRowJson: "",
    duration: "1",
    scene: "old",
    location: "old",
    timeOfDay: "old",
    picture: "old",
    action: "old",
    shotSize: "old",
    cameraMove: "old",
    dialogue: "",
    sound: "",
    visibleEmotion: "old",
    groupKey: "OLD",
    groupName: "OLD",
    groupIntent: "OLD",
    beatId: "OLD",
    videoDesc: "old",
    prompt: "",
    filePath: "",
    state: "old",
    shouldGenerateImage: 0,
    referenceImages: "[]",
    createTime: Date.now(),
  });
  await db.raw(`
    CREATE TRIGGER fail_storyboard_generation_insert
    BEFORE INSERT ON o_storyboard
    WHEN NEW.scriptId = 30
    BEGIN
      SELECT RAISE(ABORT, 'simulated storyboard commit failure');
    END
  `);

  const started = await service.beginStoryboardGeneration({
      projectId: 1,
      scriptId: 30,
      expectedRowCount: 1,
      groups: [plan("G01", [0])],
    });
  try {
    await service.appendStoryboardRows({
      generationId: started.generationId,
      startIndex: 0,
      rows: [row(0, "G01")],
    });

    const result = await service.commitStoryboardGeneration(started.generationId);
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.match(result.error.message, /simulated storyboard commit failure/);
    }
    const generation = await db("o_storyboardGeneration").where({ generationId: started.generationId }).first();
    assert.equal(generation.state, "failed");
    assert.match(generation.errorJson, /simulated storyboard commit failure/);

    const formalRows = await db("o_storyboard").where({ projectId: 1, scriptId: 30 });
    assert.equal(formalRows.length, 1);
    assert.equal(formalRows[0].factStatus, "legacy");
    assert.equal(formalRows[0].picture, "old");
  } finally {
    await db.raw("DROP TRIGGER IF EXISTS fail_storyboard_generation_insert");
  }

  const immediateRetry = await service.commitStoryboardGeneration(started.generationId);
  assert.equal(immediateRetry.status, "failed");
  await db("o_storyboardGeneration")
    .where({ generationId: started.generationId })
    .update({ updatedAt: Date.now() - service.STORYBOARD_FAILED_RETRY_COOLDOWN_MS - 1000 });
  const retry = await service.commitStoryboardGeneration(started.generationId);
  assert.equal(retry.status, "committed");
  const retriedRows = await db("o_storyboard").where({ projectId: 1, scriptId: 30 });
  assert.equal(retriedRows.length, 1);
  assert.equal(retriedRows[0].factStatus, "ready");
  assert.equal(retriedRows[0].picture, "Storyboard picture 1");
});

test("committing generation returns an explicit failed status", async () => {
  const started = await service.beginStoryboardGeneration({
    projectId: 1,
    scriptId: 61,
    expectedRowCount: 1,
    groups: [plan("G01", [0])],
  });
  await db("o_storyboardGeneration").where({ generationId: started.generationId }).update({ state: "committing" });

  const result = await service.commitStoryboardGeneration(started.generationId);
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.code, "COMMIT_IN_PROGRESS");
    assert.equal(result.error.retryable, true);
  }
});

test("stale committing generation can recover and commit when no newer formal table exists", async () => {
  const started = await service.beginStoryboardGeneration({
    projectId: 1,
    scriptId: 40,
    expectedRowCount: 1,
    groups: [plan("G01", [0])],
  });
  await service.appendStoryboardRows({
    generationId: started.generationId,
    startIndex: 0,
    rows: [row(0, "G01")],
  });
  await db("o_storyboardGeneration")
    .where({ generationId: started.generationId })
    .update({
      state: "committing",
      updatedAt: Date.now() - service.STORYBOARD_COMMIT_STALE_MS - 1000,
    });

  const result = await service.commitStoryboardGeneration(started.generationId);
  assert.equal(result.status, "committed");
  const generation = await db("o_storyboardGeneration").where({ generationId: started.generationId }).first();
  assert.equal(generation.state, "committed");
  const formalRows = await db("o_storyboard").where({ projectId: 1, scriptId: 61 }).orderBy("index", "asc");
  assert.equal(formalRows.length, 1);
  assert.equal(formalRows[0].factStatus, "ready");
});

test("stale committing generation superseded by a newer commit no longer blocks begin", async () => {
  const stale = await service.beginStoryboardGeneration({
    projectId: 1,
    scriptId: 50,
    expectedRowCount: 1,
    groups: [plan("G01", [0])],
  });
  await service.appendStoryboardRows({
    generationId: stale.generationId,
    startIndex: 0,
    rows: [row(0, "G01")],
  });
  const staleUpdatedAt = Date.now() - service.STORYBOARD_COMMIT_STALE_MS - 2000;
  await db("o_storyboardGeneration").where({ generationId: stale.generationId }).update({
    state: "committing",
    updatedAt: staleUpdatedAt,
  });
  await db("o_storyboardGeneration").insert({
    generationId: "00000000-0000-4000-8000-000000000050",
    projectId: 1,
    scriptId: 50,
    expectedRowCount: 1,
    groupPlanJson: JSON.stringify([plan("G01", [0])]),
    state: "committed",
    revision: 7,
    errorJson: null,
    createdAt: staleUpdatedAt + 1000,
    updatedAt: staleUpdatedAt + 1000,
  });

  const next = await service.beginStoryboardGeneration({
    projectId: 1,
    scriptId: 50,
    expectedRowCount: 1,
    groups: [plan("G01", [0])],
  });
  assert.equal(next.nextIndex, 0);
  const recovered = await db("o_storyboardGeneration").where({ generationId: stale.generationId }).first();
  assert.equal(recovered.state, "superseded");
  assert.match(recovered.errorJson, /STALE_COMMIT_SUPERSEDED/);
});

test("replacing a formal table keeps only the latest storyboards, asset links and active tracks", async () => {
  const first = await service.beginStoryboardGeneration({
    projectId: 1,
    scriptId: 50,
    expectedRowCount: 2,
    groups: [plan("G01", [0, 1])],
  });
  await service.appendStoryboardRows({
    generationId: first.generationId,
    startIndex: 0,
    rows: [row(0, "G01"), row(1, "G01")],
  });
  assert.equal((await service.commitStoryboardGeneration(first.generationId)).status, "committed");

  const second = await service.beginStoryboardGeneration({
    projectId: 1,
    scriptId: 50,
    expectedRowCount: 3,
    groups: [plan("G01", [0]), plan("G02", [1, 2])],
  });
  await service.appendStoryboardRows({
    generationId: second.generationId,
    startIndex: 0,
    rows: [row(0, "G01"), row(1, "G02"), row(2, "G02")],
  });
  assert.equal((await service.commitStoryboardGeneration(second.generationId)).status, "committed");

  const storyboards = await db("o_storyboard").where({ projectId: 1, scriptId: 50 }).orderBy("index", "asc");
  assert.equal(storyboards.length, 3);
  assert.deepEqual(
    storyboards.map((item: any) => item.index),
    [0, 1, 2],
  );
  const storyboardIds = storyboards.map((item: any) => item.id);
  assert.equal(
    await db("o_assets2Storyboard").whereIn("storyboardId", storyboardIds).count({ count: "*" }).first().then((value: any) => Number(value.count)),
    6,
  );
  assert.equal((await db("o_videoTrack").where({ projectId: 1, scriptId: 50, archived: 0 })).length, 2);
  assert.equal((await db("o_videoTrack").where({ projectId: 1, scriptId: 50, archived: 1 })).length, 1);
});
