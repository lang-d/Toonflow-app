import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import knex from "knex";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-storyboard-review-write-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

type StoryboardTableAgentReviewItem = import("../src/services/productionReview").StoryboardTableAgentReviewItem;
let resolveStoryboardTableAgentReviewItemTargets: typeof import("../src/services/productionReview").resolveStoryboardTableAgentReviewItemTargets;

let db: any;

const item = (overrides: Partial<StoryboardTableAgentReviewItem> = {}): StoryboardTableAgentReviewItem => ({
  scope: "storyboard",
  storyboardIndex: 14,
  issueType: "visible_emotion",
  severity: "warning",
  field: "visibleEmotion",
  message: "Current field has an abstract emotion.",
  reason: "The shot needs a visible action.",
  suggestedAction: "Replace it with observable behavior.",
  owner: "storyboardTable",
  ...overrides,
});

before(async () => {
  ({ resolveStoryboardTableAgentReviewItemTargets } = await import("../src/services/productionReview"));
  db = knex({ client: "sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_storyboard", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("index");
  });
  await db("o_storyboard").insert([
    { id: 5304, projectId: 1, scriptId: 2, index: 14 },
    { id: 5305, projectId: 1, scriptId: 2, index: 21 },
  ]);
});

after(async () => {
  await db?.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("resolves a storyboard review item from its formal index", async () => {
  const [resolved] = await resolveStoryboardTableAgentReviewItemTargets(
    { projectId: 1, scriptId: 2, items: [item()] },
    db,
  );
  assert.equal(resolved.storyboardId, 5304);
  assert.equal(resolved.storyboardIndex, 14);
});

test("uses the formal index even when a model supplied a guessed storyboard id", async () => {
  const [resolved] = await resolveStoryboardTableAgentReviewItemTargets(
    { projectId: 1, scriptId: 2, items: [item({ storyboardId: 15 })] },
    db,
  );
  assert.equal(resolved.storyboardId, 5304);
});

test("leaves explicit non-storyboard scopes unchanged", async () => {
  const [resolved] = await resolveStoryboardTableAgentReviewItemTargets(
    { projectId: 1, scriptId: 2, items: [item({ scope: "global", storyboardId: undefined, storyboardIndex: undefined })] },
    db,
  );
  assert.equal(resolved.scope, "global");
  assert.equal(resolved.storyboardId, undefined);
});

test("rejects an index outside the current project and script scope", async () => {
  await assert.rejects(
    resolveStoryboardTableAgentReviewItemTargets({ projectId: 1, scriptId: 2, items: [item({ storyboardIndex: 99 })] }, db),
    /index 99/,
  );
});
