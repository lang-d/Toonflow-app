import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildAssetImageGenerationInput } from "../src/services/assetImageGenerationInput";

test("asset image provider input preserves the saved prompt without a backend wrapper", () => {
  const savedPrompt = "  A documentary photograph of a small Chinese family dining room.  ";
  const referenceList = [{ type: "image" as const, base64: "data:image/png;base64,abc" }];

  const input = buildAssetImageGenerationInput(savedPrompt, referenceList, "1K");

  assert.deepEqual(input, {
    prompt: savedPrompt,
    referenceList,
    size: "1K",
    aspectRatio: "16:9",
  });
  assert.doesNotMatch(input.prompt, /基础参数|画风风格|系统规范|标准场景图/);
});

test("asset image provider input rejects an empty saved prompt before dispatch", () => {
  assert.throws(
    () => buildAssetImageGenerationInput("  \n", [], "1K"),
    /资产图片提示词不能为空/,
  );
});

test("asset image task passes the exact prepared input to the provider", () => {
  const worker = fs.readFileSync(
    path.join(process.cwd(), "src", "services", "backgroundTaskHandlers.ts"),
    "utf8",
  );

  assert.match(
    worker,
    /runRecoverable\(\s*buildAssetImageGenerationInput\(payload\.prompt, references, payload\.resolution\),\s*task,?\s*\)/,
  );
  assert.doesNotMatch(worker, /buildAssetPrompt|基础参数|画风风格|系统规范|标准场景图/);
});
