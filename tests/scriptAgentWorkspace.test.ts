import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-script-agent-workspace-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let db: any;
let workspace: typeof import("../src/services/scriptAgentWorkspace");
let agentRun: typeof import("../src/services/agentRun");

before(async () => {
  db = (await import("../src/utils/db")).db;
  workspace = await import("../src/services/scriptAgentWorkspace");
  agentRun = await import("../src/services/agentRun");
  await db.schema.createTable("o_project", (table: any) => {
    table.integer("id").primary();
    table.string("name");
  });
  await db.schema.createTable("o_agentWorkData", (table: any) => {
    table.increments("id").primary();
    table.integer("projectId").notNullable();
    table.string("key").notNullable();
    table.text("data");
    table.integer("updateTime");
  });
  await db.schema.createTable("o_script", (table: any) => {
    table.increments("id").primary();
    table.integer("projectId").notNullable();
    table.string("name").notNullable();
    table.text("content").notNullable();
    table.integer("contentTextAssetId");
    table.integer("createTime");
  });
  await db.schema.createTable("o_textAsset", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId").notNullable();
    table.integer("scriptId");
    table.string("targetType").notNullable();
    table.string("targetId");
    table.text("filePath").notNullable();
    table.text("summary");
    table.integer("size").notNullable().defaultTo(0);
    table.string("hash").notNullable();
    table.integer("version").notNullable().defaultTo(1);
    table.string("state").notNullable().defaultTo("complete");
    table.integer("createTime").notNullable();
    table.integer("updateTime").notNullable();
  });
  await db.schema.createTable("o_agentRun", (table: any) => {
    table.increments("id").primary();
    table.string("runId").notNullable().unique();
    table.string("agentKey").notNullable();
    table.integer("projectId").notNullable();
    table.integer("scriptId").notNullable();
    table.string("isolationKey").notNullable();
    table.string("messageId");
    table.string("status").notNullable();
    table.string("currentStage");
    table.string("currentSubAgent");
    table.text("reason");
    table.text("errorJson");
    table.text("resultJson");
    table.integer("heartbeatAt").notNullable();
    table.integer("startedAt").notNullable();
    table.integer("finishedAt");
    table.integer("createdAt").notNullable();
    table.integer("updatedAt").notNullable();
  });
  await db.schema.createTable("o_agentRunEvent", (table: any) => {
    table.increments("id").primary();
    table.string("runId").notNullable();
    table.string("eventType").notNullable();
    table.text("payloadJson");
    table.integer("createdAt").notNullable();
  });
  await db("o_project").insert([{ id: 1, name: "Project A" }, { id: 2, name: "Project B" }, { id: 3, name: "Project C" }]);
});

after(async () => {
  await db?.destroy?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("workspace is persisted by project without a browser callback", async () => {
  const beforeSave = await workspace.getScriptAgentWorkspace(1);
  assert.equal(beforeSave.storySkeleton, "");

  await workspace.saveScriptAgentStage({ projectId: 1, stage: "storySkeleton", content: "Saved backend skeleton" });
  const script = await workspace.upsertScriptAgentScript({ projectId: 1, name: "EP01", content: "Saved backend script" });
  const restored = await workspace.getScriptAgentWorkspace(1);

  assert.equal(restored.storySkeleton, "Saved backend skeleton");
  assert.equal(restored.scripts.length, 1);
  assert.equal(restored.scripts[0].id, script.id);
  assert.equal(restored.scripts[0].name, "EP01");
  assert.equal(restored.scripts[0].content, "Saved backend script");
  assert.equal(restored.scripts[0].contentAsset?.id, script.contentAsset.id);
  const storedScript = await db("o_script").where({ id: script.id }).first();
  assert.equal(storedScript.content, "");
  assert.equal(Number(storedScript.contentTextAssetId), script.contentAsset.id);
  assert.equal((await db("o_textAsset").where({ id: script.contentAsset.id }).first()).summary, "");
  const workspaceRow = await db("o_agentWorkData").where({ projectId: 1, key: workspace.SCRIPT_AGENT_KEY }).first();
  const workspaceData = JSON.parse(workspaceRow.data);
  assert.equal("storySkeleton" in workspaceData, false);
  assert.equal(Number(workspaceData.storySkeletonTextAssetId) > 0, true);
});

test("concurrent first workspace reads create one canonical row", async () => {
  const workspaces = await Promise.all(Array.from({ length: 4 }, () => workspace.getScriptAgentWorkspace(3)));
  const rows = await db("o_agentWorkData").where({ projectId: 3, key: workspace.SCRIPT_AGENT_KEY }).orderBy("id", "asc");

  assert.equal(rows.length, 1);
  assert.equal(new Set(workspaces.map((item) => item.workspaceId)).size, 1);
});

test("existing duplicate workspace rows keep the earliest row as canonical", async () => {
  await db("o_agentWorkData").insert([
    { projectId: 2, key: workspace.SCRIPT_AGENT_KEY, data: JSON.stringify({ storySkeleton: "canonical", adaptationStrategy: "" }) },
    { projectId: 2, key: workspace.SCRIPT_AGENT_KEY, data: JSON.stringify({ storySkeleton: "duplicate", adaptationStrategy: "" }) },
  ]);

  const restored = await workspace.getScriptAgentWorkspace(2);
  assert.equal(restored.storySkeleton, "canonical");
  assert.equal(restored.workspaceId, Number((await db("o_agentWorkData").where({ projectId: 2, key: workspace.SCRIPT_AGENT_KEY }).orderBy("id", "asc").first()).id));
});

test("script IDs are scoped to their project", async () => {
  const script = await workspace.upsertScriptAgentScript({ projectId: 2, name: "Other project", content: "private" });
  await assert.rejects(
    () => workspace.upsertScriptAgentScript({ projectId: 1, id: script.id, name: "Wrong", content: "Wrong" }),
    /does not belong to the current project/,
  );
  await assert.rejects(() => workspace.readScriptAgentScripts({ projectId: 1, ids: [script.id] }), /do(?:es)? not belong to the current project/);
});

test("manual workspace writes are blocked only while the scoped Script Agent run is active", async () => {
  const created = await agentRun.createAgentRun({
    agentKey: workspace.SCRIPT_AGENT_KEY,
    projectId: 1,
    scriptId: workspace.SCRIPT_AGENT_SCRIPT_ID,
    isolationKey: workspace.scriptAgentIsolationKey(1),
  });
  assert.equal(created.created, true);
  await assert.rejects(
    () => workspace.saveScriptAgentStage({ projectId: 1, stage: "adaptationStrategy", content: "manual edit" }),
    /Script Agent is running/,
  );
  await workspace.saveScriptAgentStage({ projectId: 1, stage: "adaptationStrategy", content: "agent write", allowWhileRun: true });
  if (created.created) await agentRun.finishAgentRun(created.run.runId, { status: "completed" });
  const saved = await workspace.saveScriptAgentStage({ projectId: 1, stage: "adaptationStrategy", content: "manual edit" });
  assert.equal(saved.contentAsset.size, Buffer.byteLength("manual edit", "utf8"));
});

test("large script content is file-backed and metadata-only workspace reads omit bodies", async () => {
  const content = "大文本剧本内容。\n".repeat(200_000);
  const script = await workspace.upsertScriptAgentScript({ projectId: 1, name: "Large", content });
  const metadataOnly = await workspace.getScriptAgentWorkspace(1, db, { includeContent: false, includeScriptContent: false });
  const item = metadataOnly.scripts.find((row) => row.id === script.id)!;
  assert.equal("content" in item, false);
  assert.equal(item.contentAsset?.size, Buffer.byteLength(content, "utf8"));
  assert.equal("storySkeleton" in metadataOnly, false);
  const [restored] = await workspace.readScriptAgentScripts({ projectId: 1, ids: [script.id] }, db);
  assert.equal(restored.content, content);
});

test("legacy inline script and workspace text migrate idempotently", async () => {
  const storage = await import("../src/services/scriptWorkspaceText");
  const [scriptId] = await db("o_script").insert({ projectId: 3, name: "Legacy", content: "legacy script" });
  const row = await db("o_agentWorkData").where({ projectId: 3, key: workspace.SCRIPT_AGENT_KEY }).first();
  await db("o_agentWorkData").where({ id: row.id }).update({
    data: JSON.stringify({ storySkeleton: "legacy skeleton", adaptationStrategy: "legacy strategy" }),
  });
  const first = await storage.migrateScriptWorkspaceTextStorage(db);
  const second = await storage.migrateScriptWorkspaceTextStorage(db);
  assert.equal(first.scriptsMigrated, 1);
  assert.equal(first.stagesMigrated, 2);
  assert.equal(second.scriptsMigrated, 0);
  assert.equal(second.stagesMigrated, 0);
  const stored = await db("o_script").where({ id: scriptId }).first();
  assert.equal(stored.content, "");
  assert.equal(await storage.readScriptContent(stored, db), "legacy script");
  const restored = await workspace.getScriptAgentWorkspace(3, db);
  assert.equal(restored.storySkeleton, "legacy skeleton");
  assert.equal(restored.adaptationStrategy, "legacy strategy");
});

test("unified retention deletes only expired unreferenced script assets", async () => {
  const retention = await import("../src/services/retention");
  const script = await workspace.upsertScriptAgentScript({ projectId: 2, name: "TTL", content: "first" });
  const oldAssetId = script.contentAsset.id;
  const updated = await workspace.upsertScriptAgentScript({ projectId: 2, id: script.id, name: "TTL", content: "second" });
  const stage = await workspace.saveScriptAgentStage({ projectId: 2, stage: "storySkeleton", content: "long-lived stage" });
  const now = Date.now();
  await db("o_textAsset").where({ id: oldAssetId }).update({ updateTime: now - retention.GENERATION_CONTENT_TTL_MS - 1 });
  await db("o_textAsset").where({ id: updated.contentAsset.id }).update({ updateTime: now - retention.GENERATION_CONTENT_TTL_MS - 1 });
  await db("o_textAsset").where({ id: stage.contentAsset.id }).update({ updateTime: now - retention.GENERATION_CONTENT_TTL_MS - 1 });
  const result = await retention.runLazyRetentionCleanup({ database: db, now, force: true });
  assert.equal(result.scriptWorkspaceAssets, 1);
  assert.equal(await db("o_textAsset").where({ id: oldAssetId }).first(), undefined);
  assert.ok(await db("o_textAsset").where({ id: updated.contentAsset.id }).first());
  assert.ok(await db("o_textAsset").where({ id: stage.contentAsset.id }).first());
  const [restored] = await workspace.readScriptAgentScripts({ projectId: 2, ids: [script.id] }, db);
  assert.equal(restored.content, "second");
});

test("failed pointer switch preserves the current script and leaves only TTL garbage", async () => {
  const storage = await import("../src/services/scriptWorkspaceText");
  const script = await workspace.upsertScriptAgentScript({ projectId: 1, name: "Atomic", content: "current body" });
  await assert.rejects(
    () =>
      storage.replaceScriptContent(
        {
          projectId: 1,
          scriptId: script.id,
          content: "must not become current",
          beforeCommit: async () => {
            throw new Error("simulated transaction rejection");
          },
        },
        db,
      ),
    /simulated transaction rejection/,
  );
  const stored = await db("o_script").where({ id: script.id }).first();
  assert.equal(Number(stored.contentTextAssetId), script.contentAsset.id);
  assert.equal(await storage.readScriptContent(stored, db), "current body");
  const rows = await db("o_textAsset").where({ projectId: 1, scriptId: script.id }).orderBy("id", "asc");
  assert.equal(rows.at(-1).state, "archived");
});

test("missing current files recover only from retained legacy content", async () => {
  const fsPromises = await import("node:fs/promises");
  const storage = await import("../src/services/scriptWorkspaceText");
  const textAssets = await import("../src/services/textAsset");
  const script = await workspace.upsertScriptAgentScript({ projectId: 1, name: "Recover", content: "file body" });
  const asset = await db("o_textAsset").where({ id: script.contentAsset.id }).first();
  await fsPromises.unlink(textAssets.resolveTextAssetPath(asset.filePath));
  await db("o_script").where({ id: script.id }).update({ content: "legacy recovery body" });
  const row = await db("o_script").where({ id: script.id }).first();
  assert.equal(await storage.readScriptContent(row, db), "legacy recovery body");
  const rebuilt = await db("o_script").where({ id: script.id }).first();
  assert.notEqual(Number(rebuilt.contentTextAssetId), script.contentAsset.id);
  assert.equal(rebuilt.content, "");

  const rebuiltAsset = await db("o_textAsset").where({ id: rebuilt.contentTextAssetId }).first();
  await fsPromises.unlink(textAssets.resolveTextAssetPath(rebuiltAsset.filePath));
  await assert.rejects(() => storage.readScriptContent(rebuilt, db), /missing or unreadable/);
});

test("retention preserves failed file deletions and retries them later", async () => {
  const retention = await import("../src/services/retention");
  const script = await workspace.upsertScriptAgentScript({ projectId: 2, name: "Retry", content: "old" });
  const oldAsset = await db("o_textAsset").where({ id: script.contentAsset.id }).first();
  await workspace.upsertScriptAgentScript({ projectId: 2, id: script.id, name: "Retry", content: "current" });
  const now = Date.now();
  await db("o_textAsset").where({ id: oldAsset.id }).update({
    filePath: "projects/../../invalid-script-path.md",
    updateTime: now - retention.GENERATION_CONTENT_TTL_MS - 1,
  });
  const failed = await retention.runLazyRetentionCleanup({ database: db, now, force: true });
  assert.equal(failed.scriptWorkspaceAssetFailures, 1);
  assert.ok(await db("o_textAsset").where({ id: oldAsset.id }).first());

  await db("o_textAsset").where({ id: oldAsset.id }).update({ filePath: oldAsset.filePath });
  const retried = await retention.runLazyRetentionCleanup({ database: db, now: now + 1, force: true });
  assert.equal(retried.scriptWorkspaceAssets, 1);
  assert.equal(await db("o_textAsset").where({ id: oldAsset.id }).first(), undefined);
});
