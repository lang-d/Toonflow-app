import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-production-review-admission-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let db: any;
let generateVideoRouter: any;
let batchGenerateVideoRouter: any;

function validStoryboardRow() {
  return {
    version: 1,
    index: 0,
    groupKey: "G01",
    groupName: "Opening",
    groupIntent: "Establish the scene",
    beatId: "B01",
    durationSec: 5,
    location: "Kitchen",
    timeOfDay: "Day",
    picture: "A character enters the kitchen.",
    shotSize: "Medium",
    cameraMove: "Static",
    action: "The character opens the door.",
    characters: [],
    visibleEmotion: "Calm",
    dialogue: [],
    soundEffects: ["Door opens"],
    requiredAssets: [],
  };
}

async function invokeRouter(router: any, body: Record<string, unknown>) {
  const handlers = router.stack.flatMap((layer: any) => layer.route?.stack?.map((item: any) => item.handle) || []);
  const req: any = { body, path: "/" };

  return new Promise<{ statusCode: number; payload: any }>((resolve, reject) => {
    let index = 0;
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      send(payload: any) {
        resolve({ statusCode: this.statusCode, payload });
        return this;
      },
    };
    const next = (cause?: unknown) => {
      if (cause) {
        reject(cause);
        return;
      }
      const handler = handlers[index++];
      if (!handler) {
        reject(new Error("Router completed without sending a response"));
        return;
      }
      try {
        Promise.resolve(handler(req, res, next)).catch(reject);
      } catch (error) {
        reject(error);
      }
    };
    next();
  });
}

function singleRequest(prompt = "A calm character enters the room.") {
  return {
    projectId: 1,
    scriptId: 2,
    uploadData: [],
    prompt,
    model: "",
    mode: "[]",
    resolution: "720p",
    duration: 5,
    trackId: 10,
  };
}

function batchRequest() {
  return {
    projectId: 1,
    scriptId: 2,
    trackData: [
      {
        uploadData: [],
        trackId: 10,
        prompt: "A calm character enters the room.",
        duration: 5,
      },
    ],
    model: "",
    mode: "[]",
    resolution: "720p",
  };
}

before(async () => {
  await import("../src/utils");
  db = (await import("../src/utils/db")).db;
  generateVideoRouter = (await import("../src/routes/production/workbench/generateVideo")).default;
  batchGenerateVideoRouter = (await import("../src/routes/production/workbench/batchGenerateVideo")).default;

  await db.schema.createTable("o_project", (table: any) => {
    table.integer("id").primary();
    table.string("videoRatio");
  });
  await db.schema.createTable("o_videoTrack", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.string("groupKey");
    table.string("reviewState");
  });
  await db.schema.createTable("o_productionReviewSuggestion", (table: any) => {
    table.increments("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.string("targetType");
    table.string("targetId");
    table.string("issueType");
    table.string("severity");
    table.string("message");
    table.string("status");
    table.integer("createTime");
    table.integer("updateTime");
  });
  await db.schema.createTable("o_storyboard", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("trackId");
    table.integer("index");
    table.text("tableRowJson");
    table.string("factStatus");
  });
  await db("o_project").insert({ id: 1, videoRatio: "16:9" });
});

beforeEach(async () => {
  await db("o_storyboard").delete();
  await db("o_productionReviewSuggestion").delete();
  await db("o_videoTrack").delete();
  await db("o_videoTrack").insert({
    id: 10,
    projectId: 1,
    scriptId: 2,
    groupKey: "G01",
    reviewState: "blocked",
  });
  await db("o_productionReviewSuggestion").insert({
    projectId: 1,
    scriptId: 2,
    targetType: "storyboardGroup",
    targetId: "G01",
    issueType: "group_cross_scene",
    severity: "blocking",
    message: "Storyboard group may cross scene boundaries.",
    status: "open",
    createTime: Date.now(),
    updateTime: Date.now(),
  });
});

after(async () => {
  await db?.destroy?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("single video generation does not use production review as admission control", async () => {
  const beforeReview = await db("o_productionReviewSuggestion").where({ targetId: "G01" }).first();
  const result = await invokeRouter(generateVideoRouter, singleRequest());

  assert.equal(result.statusCode, 400);
  assert.notEqual(result.payload.message, "Video generation is blocked by open production review issues");
  assert.match(result.payload.message, /分镜|storyboard/i);

  const track = await db("o_videoTrack").where({ id: 10 }).first();
  const afterReview = await db("o_productionReviewSuggestion").where({ id: beforeReview.id }).first();
  assert.equal(track.reviewState, "blocked");
  assert.equal(afterReview.severity, "blocking");
  assert.equal(afterReview.status, "open");
});

test("batch video generation does not reject a batch because a track review is blocked", async () => {
  const result = await invokeRouter(batchGenerateVideoRouter, batchRequest());

  assert.equal(result.statusCode, 400);
  assert.notEqual(result.payload.message, "Video generation is blocked by open production review issues");
  assert.match(result.payload.message, /分镜|storyboard/i);
});

test("deterministic empty prompt validation still blocks an invalid request", async () => {
  await db("o_storyboard").insert({
    id: 100,
    projectId: 1,
    scriptId: 2,
    trackId: 10,
    index: 0,
    tableRowJson: JSON.stringify(validStoryboardRow()),
    factStatus: "ready",
  });

  const result = await invokeRouter(generateVideoRouter, singleRequest(""));

  assert.equal(result.statusCode, 400);
  assert.equal(result.payload.data.issue.issueType, "empty_prompt");
  assert.equal(result.payload.data.issue.severity, "blocking");
  assert.notEqual(result.payload.message, "Video generation is blocked by open production review issues");
});
