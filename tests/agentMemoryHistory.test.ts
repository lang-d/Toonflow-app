import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-agent-memory-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let db: any;
let service: typeof import("../src/services/agentMemoryHistory");

before(async () => {
  db = (await import("../src/utils/db")).db;
  service = await import("../src/services/agentMemoryHistory");
  await db.schema.createTable("memories", (table: any) => {
    table.increments("id").primary();
    table.string("isolationKey").notNullable();
    table.string("type").notNullable();
    table.string("role");
    table.string("name");
    table.text("content");
    table.integer("createTime").notNullable();
  });
  await db.schema.createTable("o_textAsset", (table: any) => {
    table.increments("id").primary();
    table.integer("projectId").notNullable();
    table.integer("scriptId");
    table.string("targetType").notNullable();
    table.string("targetId");
    table.string("filePath");
    table.text("summary");
    table.integer("size").notNullable();
  });
});

after(async () => {
  await db?.destroy?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("agent memory history keeps markdown content and exposes full text asset metadata", async () => {
  await db("o_textAsset").insert({
    id: 77,
    projectId: 10,
    scriptId: 21,
    targetType: "agentOutput",
    targetId: "review",
    filePath: "textAssets/10/agentOutput/review.md",
    summary: "完整审核报告摘要",
    size: 1234,
  });
  await db("memories").insert([
    {
      isolationKey: "10:productionAgent:21",
      type: "message",
      role: "assistant:supervision:storyboardTable",
      name: null,
      content: "审核摘要\n[full text asset: 77]",
      createTime: 1000,
    },
    {
      isolationKey: "10:productionAgent:21",
      type: "message",
      role: "user",
      name: null,
      content: "继续返修",
      createTime: 2000,
    },
  ]);

  const history = await service.getAgentMemoryHistory({
    projectId: 10,
    agentType: "productionAgent",
    episodesId: 21,
  });

  assert.equal(history.length, 2);
  assert.equal(history[0].role, "assistant");
  assert.deepEqual(history[0].content, [
    {
      type: "markdown",
      status: "complete",
      data: "审核摘要\n[full text asset: 77]",
      ext: {
        fullTextAsset: {
          id: 77,
          size: 1234,
          summary: "完整审核报告摘要",
          targetType: "agentOutput",
        },
        fullTextAssets: [
          {
            id: 77,
            size: 1234,
            summary: "完整审核报告摘要",
            targetType: "agentOutput",
          },
        ],
      },
    },
  ]);
  assert.equal(history[0].ext.fullTextAsset.id, 77);
  assert.equal(history[1].ext, undefined);
});
