import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

test("runtime-discovered vendor models are not replaced by an empty builtin catalog", () => {
  const source = fs.readFileSync(
    path.join(root, "src", "lib", "dbFixes", "vendorConfigFixes.ts"),
    "utf8",
  );
  assert.match(source, /defaultModelList\.length > 0/);
  assert.match(source, /if \(shouldUpdateModels\)/);
});

test("Dreamina refresh preserves the previous catalog when discovery is empty", () => {
  const source = fs.readFileSync(
    path.join(root, "src", "routes", "setting", "dreamina", "refreshModels.ts"),
    "utf8",
  );
  const emptyGuard = source.indexOf("models.length === 0");
  const databaseUpdate = source.indexOf('.where("id", "dreamina").update');
  assert.ok(emptyGuard >= 0, "missing empty discovery guard");
  assert.ok(databaseUpdate > emptyGuard, "Dreamina models must be validated before updating the database");
  assert.match(source, /invalidateCache\("dreamina"\)/);
});

test("Production Agent degrades video metadata without blocking its text model", () => {
  const source = fs.readFileSync(
    path.join(root, "src", "agents", "productionAgent", "index.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /if \(!models\.length\) throw/);
  assert.match(source, /buildProductionProjectModelContext/);
  assert.match(source, /实际生成视频前必须刷新供应商模型或重新选择可用模型/);
  assert.match(source, /u\.Ai\.Text\(\s*"productionAgent:decisionAgent"/);
});

test("video generation endpoints reject unavailable models before enqueueing", () => {
  for (const fileName of ["generateVideo.ts", "batchGenerateVideo.ts"]) {
    const source = fs.readFileSync(
      path.join(root, "src", "routes", "production", "workbench", fileName),
      "utf8",
    );
    assert.match(source, /assertVideoModelAvailable\(durationPolicy\)/, fileName);
    assert.ok(
      source.indexOf("assertVideoModelAvailable(durationPolicy)") <
        source.indexOf("enqueueVideoGeneration({"),
      `${fileName} must validate the model before enqueueing`,
    );
  }
});

test("workbench endpoints validate a requested video prompt type before creating work", () => {
  const endpointNames = ["generateVideoPrompt.ts", "batchGeneratePrompt.ts", "generateVideo.ts", "batchGenerateVideo.ts"];
  for (const fileName of endpointNames) {
    const source = fs.readFileSync(
      path.join(root, "src", "routes", "production", "workbench", fileName),
      "utf8",
    );
    assert.match(source, /assertVideoPromptTypeForModel\(model, videoPromptType\)/, fileName);
  }
});
