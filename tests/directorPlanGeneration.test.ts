import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-director-plan-generation-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let db: any;
let service: typeof import("../src/services/directorPlanGeneration");
let retention: typeof import("../src/services/retention");
let textAsset: typeof import("../src/services/textAsset");

async function appendAllDirectorPlanSections(
  generationId: string,
  contentForSection: (sectionKey: (typeof service.DIRECTOR_PLAN_SECTION_KEYS)[number]) => string,
) {
  for (const sectionKey of service.DIRECTOR_PLAN_SECTION_KEYS) {
    const content = contentForSection(sectionKey);
    const result = await service.appendDirectorPlanSection({
      generationId,
      sectionKey,
      chunkIndex: 0,
      content,
    });
    assert.equal(result.accepted, 1);
  }
}

before(async () => {
  db = (await import("../src/utils/db")).db;
  service = await import("../src/services/directorPlanGeneration");
  retention = await import("../src/services/retention");
  textAsset = await import("../src/services/textAsset");

  await db.schema.createTable("o_script", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
  });
  await db.schema.createTable("o_directorPlanGeneration", (table: any) => {
    table.string("generationId").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("expectedSectionCount");
    table.string("state");
    table.integer("textAssetId");
    table.integer("version");
    table.string("contentHash");
    table.text("errorJson");
    table.integer("createdAt");
    table.integer("updatedAt");
  });
  await db.schema.createTable("o_directorPlanGenerationChunk", (table: any) => {
    table.increments("id");
    table.string("generationId");
    table.string("sectionKey");
    table.integer("chunkIndex");
    table.text("content");
    table.string("contentHash");
    table.integer("createdAt");
    table.integer("updatedAt");
    table.unique(["generationId", "sectionKey", "chunkIndex"]);
  });
  await db.schema.createTable("o_textAsset", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.string("targetType");
    table.string("targetId");
    table.string("filePath");
    table.text("summary");
    table.integer("size");
    table.string("hash");
    table.integer("version");
    table.string("state");
    table.integer("createTime");
    table.integer("updateTime");
  });
  await db("o_script").insert([
    { id: 10, projectId: 1 },
    { id: 11, projectId: 1 },
  ]);
});

after(async () => {
  await db?.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("director plan commits ordered multi-chunk sections and retains drafts", async () => {
  const started = await service.beginDirectorPlanGeneration({ projectId: 1, scriptId: 10 });
  for (const sectionKey of service.DIRECTOR_PLAN_SECTION_KEYS) {
    const first = await service.appendDirectorPlanSection({
      generationId: started.generationId,
      sectionKey,
      chunkIndex: 0,
      content: `${sectionKey}:` + "a".repeat(70_000),
    });
    assert.equal(first.accepted, 1);
    const second = await service.appendDirectorPlanSection({
      generationId: started.generationId,
      sectionKey,
      chunkIndex: 1,
      content: "-tail",
    });
    assert.equal(second.accepted, 1);
    const retry = await service.appendDirectorPlanSection({
      generationId: started.generationId,
      sectionKey,
      chunkIndex: 1,
      content: "-tail",
    });
    assert.equal(retry.accepted, 0);
    assert.equal(retry.conflict, null);
  }

  const result = await service.commitDirectorPlanGeneration(started.generationId);
  assert.equal(result.status, "committed");
  if (result.status !== "committed") return;
  assert.equal(result.sectionCount, 9);
  assert.equal(await db("o_directorPlanGenerationChunk").where({ generationId: started.generationId }).count("*").first().then((v: any) => Number(v["count(*)"] ?? v.count)), 18);
  const saved = await service.readDirectorPlanAsset({ projectId: 1, scriptId: 10, textAssetId: result.textAssetId });
  assert.match(saved.content, /inputCheck:/);
  assert.match(saved.content, /derivedAssets:/);
  assert.match(saved.content, /inputCheck:a+\n-tail/);
  assert.doesNotMatch(saved.content, /a-tail/);
});

test("director plan reads complete committed text over one megabyte", async () => {
  const started = await service.beginDirectorPlanGeneration({ projectId: 1, scriptId: 10 });
  const tailMarker = "DIRECTOR_PLAN_LONG_TAIL_MARKER";
  await appendAllDirectorPlanSections(started.generationId, (sectionKey) =>
    sectionKey === "derivedAssets" ? `${sectionKey}: ${"x".repeat(170_000)} ${tailMarker}` : `${sectionKey}: ${"x".repeat(125_000)}`,
  );

  const result = await service.commitDirectorPlanGeneration(started.generationId);
  assert.equal(result.status, "committed");
  if (result.status !== "committed") return;

  const saved = await service.readDirectorPlanAsset({ projectId: 1, scriptId: 10, textAssetId: result.textAssetId });
  assert.ok(saved.content.length > 1024 * 1024);
  assert.match(saved.content, new RegExp(tailMarker));
});

test("director plan commit strips duplicate section heading from chunk content", async () => {
  const started = await service.beginDirectorPlanGeneration({ projectId: 1, scriptId: 10 });
  await appendAllDirectorPlanSections(started.generationId, (sectionKey) =>
    sectionKey === "continuity" ? "### ③ 资产与连续性锁定\n\n角色连续性：保持既有服装。" : `${sectionKey}: normal content`,
  );

  const result = await service.commitDirectorPlanGeneration(started.generationId);
  assert.equal(result.status, "committed");
  if (result.status !== "committed") return;

  const saved = await service.readDirectorPlanAsset({ projectId: 1, scriptId: 10, textAssetId: result.textAssetId });
  const matches = saved.content.match(/资产与连续性锁定/g) || [];
  assert.equal(matches.length, 1);
  assert.match(saved.content, /角色连续性：保持既有服装。/);
});

test("missing section never creates or reuses a formal scriptPlan", async () => {
  const beforeCount = Number((await db("o_textAsset").where({ targetType: "scriptPlan" }).count({ count: "*" }).first()).count);
  const started = await service.beginDirectorPlanGeneration({ projectId: 1, scriptId: 10 });
  await service.appendDirectorPlanSection({
    generationId: started.generationId,
    sectionKey: "inputCheck",
    chunkIndex: 0,
    content: "truncated output",
  });
  const result = await service.commitDirectorPlanGeneration(started.generationId);
  assert.equal(result.status, "invalid");
  const afterCount = Number((await db("o_textAsset").where({ targetType: "scriptPlan" }).count({ count: "*" }).first()).count);
  assert.equal(afterCount, beforeCount);
});

test("tampered chunk hash invalidates director plan commit without creating a formal version", async () => {
  const beforeCount = Number((await db("o_textAsset").where({ targetType: "scriptPlan" }).count({ count: "*" }).first()).count);
  const started = await service.beginDirectorPlanGeneration({ projectId: 1, scriptId: 10 });
  await appendAllDirectorPlanSections(started.generationId, (sectionKey) => `${sectionKey}: stable content`);
  await db("o_directorPlanGenerationChunk")
    .where({ generationId: started.generationId, sectionKey: "inputCheck", chunkIndex: 0 })
    .update({ content: "tampered content" });

  const result = await service.commitDirectorPlanGeneration(started.generationId);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.match(result.issues.map((issue) => issue.message).join("\n"), /hash mismatch/);
  const afterCount = Number((await db("o_textAsset").where({ targetType: "scriptPlan" }).count({ count: "*" }).first()).count);
  assert.equal(afterCount, beforeCount);
});

test("failed atomic commit does not leave a visible formal scriptPlan", async () => {
  const beforeCount = Number((await db("o_textAsset").where({ targetType: "scriptPlan" }).count({ count: "*" }).first()).count);
  const started = await service.beginDirectorPlanGeneration({ projectId: 1, scriptId: 10 });
  await appendAllDirectorPlanSections(started.generationId, (sectionKey) => `${sectionKey}: atomic content`);
  await db.raw(`
    CREATE TRIGGER fail_director_plan_commit
    BEFORE UPDATE OF state ON o_directorPlanGeneration
    WHEN NEW.state = 'committed'
    BEGIN
      SELECT RAISE(ABORT, 'forced commit failure');
    END
  `);
  try {
    const result = await service.commitDirectorPlanGeneration(started.generationId);
    assert.equal(result.status, "failed");
    const afterCount = Number((await db("o_textAsset").where({ targetType: "scriptPlan" }).count({ count: "*" }).first()).count);
    assert.equal(afterCount, beforeCount);
    const generation = await db("o_directorPlanGeneration").where({ generationId: started.generationId }).first();
    assert.equal(generation.state, "failed");
  } finally {
    await db.raw("DROP TRIGGER IF EXISTS fail_director_plan_commit");
  }
});

test("director plan generation scope rejects another script", async () => {
  const started = await service.beginDirectorPlanGeneration({ projectId: 1, scriptId: 10 });
  await service.assertDirectorPlanGenerationScope({ generationId: started.generationId, projectId: 1, scriptId: 10 });
  await assert.rejects(
    () => service.assertDirectorPlanGenerationScope({ generationId: started.generationId, projectId: 1, scriptId: 11 }),
    /does not belong to current project\/script/,
  );
});

test("director plan state only swallows the exact missing-table compatibility error", async () => {
  const fakeDb = (message: string) =>
    (() => ({
      where() {
        return this;
      },
      whereIn() {
        return this;
      },
      orderBy() {
        return this;
      },
      first() {
        const error: any = new Error(message);
        error.code = "SQLITE_ERROR";
        throw error;
      },
    })) as any;

  assert.deepEqual(await service.getDirectorPlanGenerationState(1, 10, fakeDb("no such table: o_directorPlanGeneration")), {
    current: null,
    lastFailure: null,
  });
  await assert.rejects(
    () => service.getDirectorPlanGenerationState(1, 10, fakeDb("no such column: o_directorPlanGeneration.updatedAt")),
    /no such column/,
  );
});

test("lazy retention keeps 23-hour drafts, removes 24-hour content, and keeps diagnostics for seven days", async () => {
  const now = Date.now();
  const recent = await service.beginDirectorPlanGeneration({ projectId: 1, scriptId: 10 });
  await service.appendDirectorPlanSection({
    generationId: recent.generationId,
    sectionKey: "inputCheck",
    chunkIndex: 0,
    content: "recent",
  });
  await db("o_directorPlanGeneration").where({ generationId: recent.generationId }).update({
    state: "failed",
    updatedAt: now - 23 * 60 * 60 * 1000,
  });
  await db("o_directorPlanGenerationChunk").where({ generationId: recent.generationId }).update({
    updatedAt: now - 23 * 60 * 60 * 1000,
  });

  const old = await service.beginDirectorPlanGeneration({ projectId: 1, scriptId: 10 });
  await service.appendDirectorPlanSection({
    generationId: old.generationId,
    sectionKey: "inputCheck",
    chunkIndex: 0,
    content: "old",
  });
  await db("o_directorPlanGeneration").where({ generationId: old.generationId }).update({
    state: "failed",
    updatedAt: now - retention.GENERATION_CONTENT_TTL_MS - 1,
  });
  await db("o_directorPlanGenerationChunk").where({ generationId: old.generationId }).update({
    updatedAt: now - retention.GENERATION_CONTENT_TTL_MS - 1,
  });

  await retention.runLazyRetentionCleanup({ database: db, now, force: true });
  assert.equal(await db("o_directorPlanGenerationChunk").where({ generationId: recent.generationId }).first().then(Boolean), true);
  assert.equal(await db("o_directorPlanGenerationChunk").where({ generationId: old.generationId }).first().then(Boolean), false);
  assert.equal(await db("o_directorPlanGeneration").where({ generationId: old.generationId }).first().then(Boolean), true);
  assert.equal((await db("o_directorPlanGeneration").where({ generationId: old.generationId }).first()).state, "expired");

  const output = await textAsset.createTextAsset({
    projectId: 1,
    scriptId: 10,
    targetType: "agentOutput",
    content: "diagnostic",
  });
  await db("o_textAsset").where({ id: output.id }).update({ createTime: now - retention.DIAGNOSTIC_RETENTION_MS - 1 });
  await db("o_directorPlanGeneration").where({ generationId: old.generationId }).update({
    updatedAt: now - retention.DIAGNOSTIC_RETENTION_MS - 1,
  });
  await retention.runLazyRetentionCleanup({ database: db, now, force: true });
  assert.equal(await db("o_directorPlanGeneration").where({ generationId: old.generationId }).first().then(Boolean), false);
  assert.equal(await db("o_textAsset").where({ id: output.id }).first().then(Boolean), false);
});
