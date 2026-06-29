import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-audio-assets-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let db: any;
let addAudioAssetsRoute: any;
let updateAudioAssetsRoute: any;

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
  addAudioAssetsRoute = (await import("../src/routes/assets/addAudioAssets")).default;
  updateAudioAssetsRoute = (await import("../src/routes/assets/updateAudioAssets")).default;

  await db.schema.createTable("o_assets", (table: any) => {
    table.increments("id");
    table.integer("projectId");
    table.integer("assetsId");
    table.integer("imageId");
    table.string("name");
    table.string("type");
    table.text("prompt");
    table.text("describe");
    table.integer("startTime");
  });
  await db.schema.createTable("o_image", (table: any) => {
    table.increments("id");
    table.integer("assetsId");
    table.string("filePath");
    table.string("type");
    table.string("state");
  });
});

after(async () => {
  await db?.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("addAudioAssets returns parent and child audio IDs", async () => {
  const response = await postRoute(addAudioAssetsRoute, {
    name: "clip",
    describe: "voice clip",
    projectId: 1,
    assetsItem: [
      {
        base64: "data:audio/wav;base64,UklGRg==",
        prompt: "bright voice",
        name: "clip.wav",
        describe: "trimmed clip",
      },
    ],
  });

  assert.equal(response.status, 200);
  const audioAsset = response.body.data.audioAsset;
  assert.equal(audioAsset.name, "clip");
  assert.equal(audioAsset.type, "audio");
  assert.equal(audioAsset.projectId, 1);
  assert.equal(audioAsset.sonAssets.length, 1);
  assert.equal(audioAsset.sonAssets[0].assetsId, audioAsset.id);
  assert.equal(audioAsset.sonAssets[0].name, "clip.wav");
  assert.equal(audioAsset.sonAssets[0].type, "audio");
  assert.ok(audioAsset.sonAssets[0].id);
  assert.ok(audioAsset.sonAssets[0].imageId);
  assert.match(audioAsset.sonAssets[0].filePath, /^\/1\/assets\/audio\/.+\.wav$/);
  assert.match(audioAsset.sonAssets[0].src, /\/oss\/1\/assets\/audio\/.+\.wav/);

  const parent = await db("o_assets").where({ id: audioAsset.id }).first();
  const child = await db("o_assets").where({ id: audioAsset.sonAssets[0].id }).first();
  const image = await db("o_image").where({ id: audioAsset.sonAssets[0].imageId }).first();
  assert.equal(parent.assetsId, null);
  assert.equal(parent.type, "audio");
  assert.equal(child.assetsId, parent.id);
  assert.equal(child.type, "audio");
  assert.equal(image.assetsId, child.id);
  assert.equal(image.filePath, audioAsset.sonAssets[0].filePath);
});

test("updateAudioAssets returns refreshed child audio IDs", async () => {
  const [parentId] = await db("o_assets").insert({
    projectId: 2,
    name: "voice pack",
    type: "audio",
    describe: "old",
    startTime: Date.now(),
  });

  const response = await postRoute(updateAudioAssetsRoute, {
    id: parentId,
    name: "voice pack updated",
    describe: "new",
    projectId: 2,
    assetsItem: [
      {
        base64: "data:audio/wav;base64,UklGRg==",
        prompt: "new prompt",
        name: "new-clip.wav",
        describe: "new child",
      },
    ],
  });

  assert.equal(response.status, 200);
  const audioAsset = response.body.data.audioAsset;
  assert.equal(audioAsset.id, parentId);
  assert.equal(audioAsset.name, "voice pack updated");
  assert.equal(audioAsset.describe, "new");
  assert.equal(audioAsset.sonAssets.length, 1);
  assert.equal(audioAsset.sonAssets[0].assetsId, parentId);
  assert.equal(audioAsset.sonAssets[0].name, "new-clip.wav");
  assert.ok(audioAsset.sonAssets[0].id);
});
