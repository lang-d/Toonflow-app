import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-storyboard-polling-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let db: any;
let pollingImageRoute: any;

async function postRoute(route: any, body: Record<string, unknown>) {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use("/", route);
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

before(async () => {
  db = (await import("../src/utils/db")).db;
  pollingImageRoute = (await import("../src/routes/production/storyboard/pollingImage")).default;

  await db.schema.createTable("o_storyboard", (table: any) => {
    table.integer("id").primary();
    table.string("state");
    table.string("reason");
    table.string("filePath");
    table.string("prompt");
  });
  await db.schema.createTable("o_editImageTask", (table: any) => {
    table.increments("id");
    table.string("targetType");
    table.integer("targetId");
    table.string("nodeId");
    table.string("status");
    table.string("state");
    table.string("reason");
    table.integer("updateTime");
  });
});

beforeEach(async () => {
  await db("o_editImageTask").delete();
  await db("o_storyboard").delete();
});

after(async () => {
  await db?.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("pollingImage keeps selected storyboard result completed over stale failed task", async () => {
  await db("o_storyboard").insert({
    id: 1,
    state: "已完成",
    reason: "",
    filePath: "/storyboard/final.jpg",
    prompt: "selected final",
  });
  await db("o_editImageTask").insert({
    targetType: "storyboard",
    targetId: 1,
    nodeId: "main",
    status: "failed",
    state: "failed",
    reason: "provider failed",
    updateTime: 200,
  });

  const response = await postRoute(pollingImageRoute, { ids: [1] });

  assert.equal(response.status, 200);
  assert.equal(response.body.data[0].status, "completed");
  assert.equal(response.body.data[0].reason, "");
  assert.equal(response.body.data[0].state, "已完成");
  assert.equal(response.body.data[0].legacyTaskId, undefined);
  assert.equal(response.body.data[0].nodeId, undefined);
});

test("pollingImage still reports active generation over existing storyboard image", async () => {
  await db("o_storyboard").insert({
    id: 2,
    state: "已完成",
    reason: "",
    filePath: "/storyboard/old-final.jpg",
    prompt: "old final",
  });
  await db("o_editImageTask").insert({
    targetType: "storyboard",
    targetId: 2,
    nodeId: "main",
    status: "processing",
    state: "processing",
    reason: "working",
    updateTime: 300,
  });

  const response = await postRoute(pollingImageRoute, { ids: [2] });

  assert.equal(response.status, 200);
  assert.equal(response.body.data[0].status, "processing");
  assert.equal(response.body.data[0].reason, "working");
});

test("pollingImage keeps failed task when storyboard has no final image", async () => {
  await db("o_storyboard").insert({
    id: 3,
    state: "生成失败",
    reason: "provider failed",
    filePath: "",
    prompt: "failed storyboard",
  });
  await db("o_editImageTask").insert({
    targetType: "storyboard",
    targetId: 3,
    nodeId: "main",
    status: "failed",
    state: "failed",
    reason: "provider failed",
    updateTime: 400,
  });

  const response = await postRoute(pollingImageRoute, { ids: [3] });

  assert.equal(response.status, 200);
  assert.equal(response.body.data[0].status, "failed");
  assert.equal(response.body.data[0].reason, "provider failed");
  assert.ok(response.body.data[0].legacyTaskId);
  assert.equal(response.body.data[0].nodeId, "main");
});
