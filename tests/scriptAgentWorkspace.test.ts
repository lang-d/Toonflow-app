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
  });
  await db.schema.createTable("o_script", (table: any) => {
    table.increments("id").primary();
    table.integer("projectId").notNullable();
    table.string("name").notNullable();
    table.text("content").notNullable();
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
  assert.deepEqual(restored.scripts, [{ id: script.id, name: "EP01", content: "Saved backend script" }]);
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
  await assert.rejects(() => workspace.readScriptAgentScripts({ projectId: 1, ids: [script.id] }), /does not belong to the current project/);
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
  assert.equal(saved.content, "manual edit");
});
