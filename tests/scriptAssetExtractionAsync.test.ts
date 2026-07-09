import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-script-asset-extraction-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let chunkScriptAssetExtractionIds: typeof import("../src/services/scriptAssetExtraction").chunkScriptAssetExtractionIds;

before(async () => {
  const service = await import("../src/services/scriptAssetExtraction");
  chunkScriptAssetExtractionIds = service.chunkScriptAssetExtractionIds;
});

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("script asset extraction chunks batches into at most five scripts per task", () => {
  assert.deepEqual(chunkScriptAssetExtractionIds([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), [
    [1, 2, 3, 4, 5],
    [6, 7, 8, 9, 10],
    [11, 12],
  ]);
  assert.deepEqual(chunkScriptAssetExtractionIds([1, 2, 3, 4], 99), [[1, 2, 3, 4]]);
  assert.deepEqual(chunkScriptAssetExtractionIds([1, 2, 3], 1), [[1], [2], [3]]);
});

test("extractAssets route creates unified tasks instead of running extraction inline", () => {
  const routeSource = fs.readFileSync(path.join(process.cwd(), "src", "routes", "script", "extractAssets.ts"), "utf8");
  assert.match(routeSource, /createUnifiedTask/);
  assert.match(routeSource, /formatUnifiedTaskEnvelope/);
  assert.match(routeSource, /handler:\s*"script-asset-extract"/);
  assert.match(routeSource, /targetType:\s*"scriptAssetExtraction"/);
  assert.doesNotMatch(routeSource, /u\.Ai\.Text/);
  assert.doesNotMatch(routeSource, /processGroup/);
  assert.doesNotMatch(routeSource, /unifiedTaskId/);
});

test("unified task worker registers script asset extraction handler and serializes it per project", () => {
  const workerSource = fs.readFileSync(path.join(process.cwd(), "src", "services", "unifiedTaskWorker.ts"), "utf8");
  assert.match(workerSource, /executeScriptAssetExtractionTask/);
  assert.match(workerSource, /"script-asset-extract"/);
  assert.match(workerSource, /getRunningScriptAssetExtractionProjectIds/);
});

test("frontend handoff doc states task status is authoritative", () => {
  const doc = fs.readFileSync(path.join(process.cwd(), "docs", "frontend-script-asset-extraction-async.md"), "utf8");
  assert.match(doc, /queued \| processing \| completed \| failed \| cancelled/);
  assert.match(doc, /scriptAssetExtraction/);
  assert.match(doc, /不要再用 `o_script\.extractState`/);
});

test("script asset extraction cancellation clears legacy script waiting state", () => {
  const coordinator = fs.readFileSync(path.join(process.cwd(), "src", "services", "taskCoordinator.ts"), "utf8");
  assert.match(coordinator, /task\.handler === "script-asset-extract"/);
  assert.match(coordinator, /extractState:\s*-1/);
  assert.match(coordinator, /errorReason:\s*"用户取消"/);
});
