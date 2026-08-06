import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-workbench-video-reviewer-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let u: typeof import("../src/utils").default;
let db: any;
let service: typeof import("../src/services/workbenchVideoReviewer");

before(async () => {
  u = (await import("../src/utils")).default;
  db = (await import("../src/utils/db")).db;
  service = await import("../src/services/workbenchVideoReviewer");

  await db.schema.createTable("o_videoTrack", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.text("prompt");
    table.integer("duration");
    table.string("groupKey");
    table.string("groupName");
    table.string("groupIntent");
    table.text("musicPlanJson");
    table.text("info");
    table.string("reviewState");
    table.text("reviewIssuesJson");
  });
  await db.schema.createTable("o_storyboard", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("trackId");
    table.integer("index");
    table.text("tableRowJson");
    table.string("factStatus");
    table.string("filePath");
  });
  await db.schema.createTable("o_productionReviewSuggestion", (table: any) => {
    table.increments("id").primary();
    table.integer("projectId").notNullable();
    table.integer("scriptId");
    table.string("targetType").notNullable();
    table.string("targetId").notNullable();
    table.integer("parentId");
    table.integer("version").notNullable().defaultTo(1);
    table.string("issueType").notNullable();
    table.string("severity").notNullable();
    table.text("message").notNullable();
    table.text("reason");
    table.text("proposedAction");
    table.text("proposedPatch");
    table.string("status").notNullable().defaultTo("open");
    table.integer("createTime").notNullable();
    table.integer("updateTime").notNullable();
  });
});

beforeEach(async () => {
  await db("o_productionReviewSuggestion").delete();
  await db("o_storyboard").delete();
  await db("o_videoTrack").delete();
  await db("o_videoTrack").insert({
    id: 10,
    projectId: 1,
    scriptId: 2,
    prompt: "A calm character walks across the room with natural camera movement.",
    duration: 5,
    groupKey: "G01",
    groupName: "Opening",
    groupIntent: "Establish the room action",
    musicPlanJson: "[]",
    info: "[]",
    reviewState: "pending",
    reviewIssuesJson: "[]",
  });
});

after(async () => {
  await db?.destroy?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function withMockedAiText(text: string, fn: () => Promise<void>, inspect?: (input: any) => void) {
  const original = u.Ai.Text;
  (u.Ai as any).Text = () => ({
    invoke: async (input: any) => {
      if (input.output) throw new Error("responseFormat is not supported");
      inspect?.(input);
      return { text };
    },
  });
  try {
    await fn();
  } finally {
    (u.Ai as any).Text = original;
  }
}

test("review context treats a storyboard image as the sole V3 opening visual", async () => {
  await db("o_storyboard").insert({
    id: 101,
    projectId: 1,
    scriptId: 2,
    trackId: 10,
    index: 1,
    factStatus: "ready",
    tableRowJson: JSON.stringify({
      version: 3,
      index: 1,
      groupKey: "G01",
      beatId: "B01",
      durationSec: 5,
      location: "room",
      timeOfDay: "day",
      shotDescription: "The character stands beside the table. A bell rings; the character picks up the box and holds it at chest height.",
      shotSize: "medium",
      dialogue: [],
      soundEffects: [],
      requiredAssets: [],
    }),
  });
  await db("o_videoTrack")
    .where({ id: 10 })
    .update({ info: JSON.stringify([{ sources: "storyboard", id: 101, fileType: "image" }]) });

  let context: any;
  await withMockedAiText(
    '{"issues":[]}',
    async () => {
      await service.reviewVideoTracks({ projectId: 1, scriptId: 2, trackIds: [10] });
    },
    (input) => {
      context = JSON.parse(input.messages[0].content);
    },
  );
  assert.equal(context.storyboards[0].visualStart, "storyboardReference");
  assert.equal(context.storyboards[0].shotDescription, "The character stands beside the table. A bell rings; the character picks up the box and holds it at chest height.");
  assert.equal(context.storyboards[0].shotDescriptionRole, "temporalContinuation");
  assert.equal("picture" in context.storyboards[0], false);
  assert.equal("action" in context.storyboards[0], false);
  assert.equal("shotSize" in context.storyboards[0], false);
});

test("review context keeps full V3 description only for the textual opening fallback", async () => {
  await db("o_storyboard").insert({
    id: 102,
    projectId: 1,
    scriptId: 2,
    trackId: 10,
    index: 1,
    factStatus: "ready",
    tableRowJson: JSON.stringify({
      version: 3,
      index: 1,
      groupKey: "G01",
      beatId: "B01",
      durationSec: 5,
      location: "room",
      timeOfDay: "day",
      shotDescription: "The character stands beside the table. A bell rings; the character picks up the box and holds it at chest height.",
      shotSize: "medium",
      dialogue: [],
      soundEffects: [],
      requiredAssets: [],
    }),
  });

  let context: any;
  await withMockedAiText(
    '{"issues":[]}',
    async () => {
      await service.reviewVideoTracks({ projectId: 1, scriptId: 2, trackIds: [10] });
    },
    (input) => {
      context = JSON.parse(input.messages[0].content);
    },
  );
  assert.equal(context.storyboards[0].visualStart, "textFallback");
  assert.equal(context.storyboards[0].shotDescription, "The character stands beside the table. A bell rings; the character picks up the box and holds it at chest height.");
  assert.equal(context.storyboards[0].shotDescriptionRole, "fullShot");
  assert.equal("picture" in context.storyboards[0], false);
  assert.equal("action" in context.storyboards[0], false);
  assert.equal(context.storyboards[0].shotSize, "medium");
});

test("reviewVideoTracks accepts fallback object with empty issues", async () => {
  await withMockedAiText('{"issues":[]}', async () => {
    const result = await service.reviewVideoTracks({ projectId: 1, scriptId: 2, trackIds: [10] });
    assert.equal(result.suggestions.length, 0);
  });
});

test("reviewVideoTracks treats fallback root array as review issues", async () => {
  await withMockedAiText('[{"issueType":"bgm_in_prompt","severity":"warning","reason":"BGM appears in prompt"}]', async () => {
    const result = await service.reviewVideoTracks({ projectId: 1, scriptId: 2, trackIds: [10] });
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.suggestions[0].issueType, "bgm_in_prompt");
    assert.equal(result.suggestions[0].severity, "warning");
  });
});

test("reviewVideoTracks treats empty fallback root array as no issues", async () => {
  await withMockedAiText("[]", async () => {
    const result = await service.reviewVideoTracks({ projectId: 1, scriptId: 2, trackIds: [10] });
    assert.equal(result.suggestions.length, 0);
  });
});

test("reviewVideoTracks accepts fallback suggestions array with field aliases", async () => {
  await withMockedAiText(
    '{"suggestions":[{"type":"safety_risk","level":"block","message":"Unsafe action detail","suggestion":"Soften the action."}]}',
    async () => {
      const result = await service.reviewVideoTracks({ projectId: 1, scriptId: 2, trackIds: [10] });
      assert.equal(result.suggestions.length, 1);
      assert.equal(result.suggestions[0].issueType, "safety_risk");
      assert.equal(result.suggestions[0].severity, "blocking");
      assert.equal(result.suggestions[0].proposedPatch.suggestedRevision, "Soften the action.");
    },
  );
});

test("reviewVideoTracks records a retryable warning when fallback text is not parseable", async () => {
  await withMockedAiText("not json", async () => {
    const result = await service.reviewVideoTracks({ projectId: 1, scriptId: 2, trackIds: [10] });
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.suggestions[0].issueType, "ai_review_unavailable");
    assert.equal(result.suggestions[0].severity, "warning");
    assert.equal(result.suggestions[0].proposedPatch.retryable, true);
  });
});
