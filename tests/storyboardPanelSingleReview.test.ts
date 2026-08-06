import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-single-panel-review-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let db: any;
let u: typeof import("../src/utils").default;
let reviewer: typeof import("../src/services/storyboardPanelSingleReview");

before(async () => {
  db = (await import("../src/utils/db")).db;
  u = (await import("../src/utils")).default;
  reviewer = await import("../src/services/storyboardPanelSingleReview");
  await db.schema.createTable("o_storyboard", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("index");
    table.text("prompt");
    table.integer("shouldGenerateImage");
    table.string("factStatus");
    table.text("tableRowJson");
  });
  await db.schema.createTable("o_assets2Storyboard", (table: any) => {
    table.integer("storyboardId");
    table.integer("assetId");
  });
  await db.schema.createTable("o_assets", (table: any) => {
    table.integer("id").primary();
    table.text("name");
  });
  await db.schema.createTable("o_directorPlanGeneration", (table: any) => {
    table.string("generationId").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.string("state");
    table.text("videoStyle");
    table.integer("updatedAt");
  });
  await db("o_directorPlanGeneration").insert({
    generationId: "single-review-style",
    projectId: 9,
    scriptId: 99,
    state: "committed",
    videoStyle: "test-style",
    updatedAt: 1,
  });
  await db("o_storyboard").insert({
    id: 901,
    projectId: 9,
    scriptId: 99,
    index: 0,
    prompt: "@Image2 asset B, @Image1 asset A",
    shouldGenerateImage: 1,
    factStatus: "ready",
    tableRowJson: JSON.stringify({
      version: 3,
      index: 0,
      groupKey: "G01",
      beatId: "B01",
      durationSec: 4,
      location: "yard",
      timeOfDay: "day",
      shotDescription: "A and B are visible together.",
      shotSize: "medium",
      dialogue: [],
      soundEffects: [],
      requiredAssets: [],
    }),
  });
  await db("o_assets").insert([
    { id: 1, name: "asset A" },
    { id: 2, name: "asset B" },
  ]);
  await db("o_assets2Storyboard").insert([
    { storyboardId: 901, assetId: 1 },
    { storyboardId: 901, assetId: 2 },
  ]);
});

after(async () => {
  await db.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("single panel review uses one structured, tool-free model invocation", async () => {
  const originalText = u.Ai.Text;
  const calls: any[] = [];
  (u.Ai as any).Text = (key: string, think: boolean, thinkLevel: number) => ({
    invoke: async (input: any) => {
      calls.push({ key, think, thinkLevel, input });
      return {
        output: {
          summary: "No panel issue found.",
          items: [],
        },
      };
    },
  });
  try {
    const output = await reviewer.runStoryboardPanelSingleReview({ projectId: 9, scriptId: 99 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, "productionAgent:supervisionAgent");
    assert.equal(calls[0].think, false);
    assert.equal(calls[0].input.tools, undefined);
    assert.ok(calls[0].input.output);
    assert.match(calls[0].input.system, /Return only one JSON object matching this output schema/);
    assert.match(calls[0].input.system, /currentEvidence/);
    assert.doesNotMatch(calls[0].input.system, /currentPromptQuote/);
    assert.match(calls[0].input.messages[0].content, /@Image2 asset B, @Image1 asset A/);
    assert.match(calls[0].input.messages[0].content, /"reference":"@Image1"/);
    assert.equal(output.bundle.total, 1);
    assert.deepEqual(output.result, { summary: "No panel issue found.", items: [] });
  } finally {
    (u.Ai as any).Text = originalText;
  }
});

test("single panel review bounds structured failure diagnostics", () => {
  const details = reviewer.storyboardPanelSingleReviewFailureDetails({
    name: "AI_NoObjectGeneratedError",
    message: "schema mismatch",
    finishReason: "length",
    usage: { inputTokens: 10, outputTokens: 20 },
    text: "x".repeat(5000),
    cause: { name: "ZodError", message: "bad field", issues: [{ path: ["items", 0, "owner"] }] },
  });
  assert.equal(details.finishReason, "length");
  assert.equal(details.text?.length, 4000);
  assert.deepEqual(details.usage, { inputTokens: 10, outputTokens: 20 });
  assert.deepEqual(details.cause?.issues, [{ path: ["items", 0, "owner"] }]);
});

test("single panel review does not retry an invalid structured response", async () => {
  const originalText = u.Ai.Text;
  let calls = 0;
  (u.Ai as any).Text = () => ({
    invoke: async () => {
      calls += 1;
      return { output: { summary: "", items: [] } };
    },
  });
  try {
    await assert.rejects(
      reviewer.runStoryboardPanelSingleReview({ projectId: 9, scriptId: 99 }),
      /invalid structured result/,
    );
    assert.equal(calls, 1);
  } finally {
    (u.Ai as any).Text = originalText;
  }
});

test("single panel review schema does not require backend-authored evidence fields", () => {
  const parsed = reviewer.storyboardPanelSingleReviewResultSchema.safeParse({
    summary: "One model-authored issue.",
    items: [
      {
        scope: "storyboard",
        storyboardIndex: 0,
        field: "prompt",
        severity: "warning",
        currentEvidence: "model-authored current evidence",
        upstreamEvidence: "model-authored upstream evidence",
        owner: "storyboardPanel",
        recommendation: "model-authored recommendation",
      },
    ],
  });
  assert.equal(parsed.success, true);
});

test("single panel review source contains no professional evidence hard-coding", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src", "services", "storyboardPanelSingleReview.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /currentPromptQuote/);
  assert.doesNotMatch(source, /foreignAssetNames/);
  assert.doesNotMatch(source, /every listed reference must appear exactly once/);
  assert.doesNotMatch(source, /assertReviewEvidenceMatchesBundle/);
});
