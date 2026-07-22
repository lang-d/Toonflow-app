import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-novel-event-extraction-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let chunkNovelEventExtractionIds: typeof import("../src/services/novelEventExtraction").chunkNovelEventExtractionIds;
let novelEventIdsFromPayload: typeof import("../src/services/novelEventExtraction").novelEventIdsFromPayload;

before(async () => {
  const service = await import("../src/services/novelEventExtraction");
  chunkNovelEventExtractionIds = service.chunkNovelEventExtractionIds;
  novelEventIdsFromPayload = service.novelEventIdsFromPayload;
});

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("novel event extraction groups at most five chapters per task", () => {
  assert.deepEqual(chunkNovelEventExtractionIds([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), [
    [1, 2, 3, 4, 5],
    [6, 7, 8, 9, 10],
    [11],
  ]);
  assert.deepEqual(chunkNovelEventExtractionIds([1, 2, 2, 3], 99), [[1, 2, 3]]);
  assert.deepEqual(novelEventIdsFromPayload(JSON.stringify({ novelIds: [8, 9] })), [8, 9]);
  assert.deepEqual(novelEventIdsFromPayload(JSON.stringify({ novelId: 7 })), [7]);
  assert.match(fs.readFileSync(path.join(process.cwd(), "src", "services", "novelEventExtraction.ts"), "utf8"), /payload\.novelId/);
});

test("novel routes enqueue unified tasks instead of starting CleanNovel inline", () => {
  const addRoute = fs.readFileSync(path.join(process.cwd(), "src", "routes", "novel", "addNovel.ts"), "utf8");
  const generateRoute = fs.readFileSync(path.join(process.cwd(), "src", "routes", "novel", "event", "generateEvents.ts"), "utf8");
  assert.match(addRoute, /enqueueNovelEventExtraction/);
  assert.match(generateRoute, /enqueueNovelEventExtraction/);
  assert.doesNotMatch(addRoute, /cleanNovel/);
  assert.doesNotMatch(generateRoute, /createUnifiedTask/);
});

test("worker, recovery, cancellation and chapter reads use grouped novel-event facts", () => {
  const worker = fs.readFileSync(path.join(process.cwd(), "src", "services", "unifiedTaskWorker.ts"), "utf8");
  const coordinator = fs.readFileSync(path.join(process.cwd(), "src", "services", "taskCoordinator.ts"), "utf8");
  const novelRoute = fs.readFileSync(path.join(process.cwd(), "src", "routes", "novel", "getNovel.ts"), "utf8");
  assert.match(worker, /executeNovelEventExtractionTask\(payload, task\)/);
  assert.match(worker, /failPendingNovelEventExtraction/);
  assert.match(coordinator, /task\.handler === "novel-event"/);
  assert.match(coordinator, /eventState:\s*-1/);
  assert.match(novelRoute, /eventExtraction/);
  assert.match(novelRoute, /phase/);
  assert.match(novelRoute, /progress/);
});

test("frontend handoff keeps chapter facts authoritative after grouped tasks finish", () => {
  const doc = fs.readFileSync(path.join(process.cwd(), "docs", "frontend-novel-event-extraction-async.md"), "utf8");
  assert.match(doc, /novelEventExtraction/);
  assert.match(doc, /eventState/);
  assert.match(doc, /eventAnalysis\.vue/);
});
