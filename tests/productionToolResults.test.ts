import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

test("image-generation tool results preserve exact complete and partial target facts", async () => {
  const { structuredGenerateDeriveAssetToolResult, structuredGenerateStoryboardToolResult } = await import(
    "../src/agents/productionAgent/tools"
  );

  assert.deepEqual(
    structuredGenerateDeriveAssetToolResult([11, 12], {
      tasks: [{ assetId: 11 }, { assetId: 12 }],
      successCount: 2,
      failedCount: 0,
      errors: [],
    }),
    {
      status: "complete",
      requestedIds: [11, 12],
      submittedIds: [11, 12],
      failedTargets: [],
      successCount: 2,
      failedCount: 0,
      summary: "已创建 2 个衍生资产生图任务，0 个创建失败。",
    },
  );

  const derivePartial = structuredGenerateDeriveAssetToolResult([11, 12], {
    tasks: [{ assetId: 11 }],
    successCount: 1,
    failedCount: 1,
    errors: [{ assetId: 12, error: "missing prompt" }],
  });
  assert.equal(derivePartial.status, "partial");
  assert.deepEqual(derivePartial.submittedIds, [11]);
  assert.deepEqual(derivePartial.failedTargets, [{ assetId: 12, reason: "missing prompt" }]);

  const storyboardAllFailed = structuredGenerateStoryboardToolResult([21, 22], {
    tasks: [],
    successCount: 0,
    failedCount: 2,
    errors: [
      { storyboardId: 21, error: "missing panel prompt" },
      { storyboardId: 22, error: "storyboard not found" },
    ],
  });
  assert.equal(storyboardAllFailed.status, "partial");
  assert.deepEqual(storyboardAllFailed.submittedIds, []);
  assert.deepEqual(storyboardAllFailed.failedTargets, [
    { storyboardId: 21, reason: "missing panel prompt" },
    { storyboardId: 22, reason: "storyboard not found" },
  ]);

  const unreportedTarget = structuredGenerateStoryboardToolResult([31, 32], {
    tasks: [{ storyboardId: 31 }],
    successCount: 1,
    failedCount: 0,
    errors: [],
  });
  assert.equal(unreportedTarget.status, "partial");
  assert.deepEqual(unreportedTarget.failedTargets, [
    { storyboardId: 32, reason: "image generation result did not report a submitted task" },
  ]);
});
