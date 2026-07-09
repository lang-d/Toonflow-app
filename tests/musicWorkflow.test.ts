import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-music-workflow-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let vendorModelSchema: any;
let readMusicSkill: any;
let formatUnifiedTaskEnvelope: typeof import("../src/services/taskCoordinator").formatUnifiedTaskEnvelope;
let isAiObjectContractError: typeof import("../src/services/aiJsonObject").isAiObjectContractError;
let musicProjectIsolationKey: typeof import("../src/services/musicStageState").musicProjectIsolationKey;
let musicEpisodeIsolationKey: typeof import("../src/services/musicStageState").musicEpisodeIsolationKey;
let resolveMusicIsolationKey: typeof import("../src/services/musicStageState").resolveMusicIsolationKey;
let musicProductionToolNames: typeof import("../src/agents/musicProductionAgent/tools").musicProductionToolNames;
let musicAiContractFailureMessage: typeof import("../src/services/musicTaskHandlers").musicAiContractFailureMessage;

before(async () => {
  const [vendorModel, musicDirector, taskCoordinator, aiJsonObject, musicStageState, musicTools, musicTaskHandlers] = await Promise.all([
    import("../src/lib/vendorModelSchema"),
    import("../src/services/musicDirector"),
    import("../src/services/taskCoordinator"),
    import("../src/services/aiJsonObject"),
    import("../src/services/musicStageState"),
    import("../src/agents/musicProductionAgent/tools"),
    import("../src/services/musicTaskHandlers"),
  ]);
  vendorModelSchema = vendorModel.vendorModelSchema;
  readMusicSkill = musicDirector.readMusicSkill;
  formatUnifiedTaskEnvelope = taskCoordinator.formatUnifiedTaskEnvelope;
  isAiObjectContractError = aiJsonObject.isAiObjectContractError;
  musicProjectIsolationKey = musicStageState.musicProjectIsolationKey;
  musicEpisodeIsolationKey = musicStageState.musicEpisodeIsolationKey;
  resolveMusicIsolationKey = musicStageState.resolveMusicIsolationKey;
  musicProductionToolNames = musicTools.musicProductionToolNames;
  musicAiContractFailureMessage = musicTaskHandlers.musicAiContractFailureMessage;
});

after(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("vendor model schema accepts music models without provider-specific hardcoding", () => {
  const result = vendorModelSchema.parse({
    name: "Music Studio",
    modelName: "music-studio-v1",
    type: "music",
    durationRange: { min: 5, max: 180 },
    outputFormats: ["mp3", "wav"],
    promptDialect: "sectioned",
  });

  assert.equal(result.type, "music");
  assert.equal(result.promptDialect, "sectioned");
});

test("music skill loader reads bundled defaults and falls back when missing", async () => {
  const skill = await readMusicSkill("music_review.md", "fallback");
  assert.match(skill.content, /Music Review Rules/);

  const fallback = await readMusicSkill("missing_music_skill.md", "fallback skill");
  assert.equal(fallback.content, "fallback skill");
  assert.equal(fallback.source, "fallback:missing_music_skill.md");
});

test("unified task envelope does not expose unifiedTaskId for new async music APIs", () => {
  const envelope = formatUnifiedTaskEnvelope({ taskId: "task-uuid", legacyTaskId: 123, status: "queued" }, "musicBible");
  assert.deepEqual(envelope, {
    taskId: "task-uuid",
    legacyTaskId: 123,
    status: "queued",
    targetType: "musicBible",
    targetId: null,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(envelope, "unifiedTaskId"), false);
});

test("music AI object contract errors are detected for user-friendly task failures", () => {
  assert.equal(isAiObjectContractError(new Error("No object generated: response did not match schema.")), true);
  assert.equal(isAiObjectContractError(new Error("Music bible does not match schema: missing content")), true);
  assert.equal(isAiObjectContractError(new Error("network timeout")), false);
  const message = musicAiContractFailureMessage("Music Bible");
  assert.match(message, /AI/);
  assert.match(message, /\u7ed3\u6784\u8981\u6c42/);
  assert.doesNotMatch(message, /No object generated|response did not match schema/);
});

test("task polling contracts accept only string task ids", () => {
  const snapshotRoute = fs.readFileSync(path.join(process.cwd(), "src", "routes", "task", "status", "snapshot.ts"), "utf8");
  const detailsRoute = fs.readFileSync(path.join(process.cwd(), "src", "routes", "task", "taskDetails.ts"), "utf8");
  assert.match(snapshotRoute, /taskIds:\s*z\.array\(z\.string\(\)\.min\(1\)\)/);
  assert.doesNotMatch(snapshotRoute, /z\.union\(\[z\.string\(\),\s*z\.number\(\)\]\)/);
  assert.match(detailsRoute, /taskId:\s*z\.string\(\)\.min\(1\)/);
  assert.doesNotMatch(detailsRoute, /orWhere\("id"/);
});

test("music production agent uses project and episode isolation keys", () => {
  assert.equal(musicProjectIsolationKey(11), "musicProductionAgent:11:project");
  assert.equal(musicEpisodeIsolationKey(11, 22), "musicProductionAgent:11:episode:22");
  assert.equal(resolveMusicIsolationKey({ projectId: 11, mode: "project" }), "musicProductionAgent:11:project");
  assert.equal(resolveMusicIsolationKey({ projectId: 11, scriptId: 22, mode: "episode" }), "musicProductionAgent:11:episode:22");
  assert.throws(() => resolveMusicIsolationKey({ projectId: 11, mode: "episode" }), /scriptId is required/);
});

test("music production agent is registered as an isolated socket and runtime kind", () => {
  const socketIndex = fs.readFileSync(path.join(process.cwd(), "src", "socket", "index.ts"), "utf8");
  const runtimeBridge = fs.readFileSync(path.join(process.cwd(), "src", "runtime", "agentSocketBridge.ts"), "utf8");
  const proxy = fs.readFileSync(path.join(process.cwd(), "src", "socket", "routes", "agentProxy.ts"), "utf8");

  assert.match(socketIndex, /musicProductionAgent/);
  assert.match(runtimeBridge, /musicProductionAgent/);
  assert.match(proxy, /"musicProductionAgent"/);
});

test("music production agent exposes only music tools", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "agents", "musicProductionAgent", "tools.ts"), "utf8");
  assert.doesNotMatch(source, /productionAgent\/tools/);
  assert.deepEqual(
    [...musicProductionToolNames].filter((name) => name.includes("storyboard") || name.includes("video")),
    [],
  );
  assert.ok(musicProductionToolNames.includes("generate_music_bible"));
  assert.ok(musicProductionToolNames.includes("generate_music_cue_audio"));
});

test("music production agent has its own model deployment key", () => {
  const aiSource = fs.readFileSync(path.join(process.cwd(), "src", "utils", "ai.ts"), "utf8");
  const initSource = fs.readFileSync(path.join(process.cwd(), "src", "lib", "initDB.ts"), "utf8");
  const fixSource = fs.readFileSync(path.join(process.cwd(), "src", "lib", "fixDB.ts"), "utf8");

  assert.match(aiSource, /"musicProductionAgent"/);
  assert.match(aiSource, /"musicProductionAgent:decisionAgent"/);
  assert.match(initSource, /key: "musicProductionAgent"/);
  assert.match(fixSource, /key: "musicProductionAgent:decisionAgent"/);
  assert.match(fixSource, /copyAgentDeployModelIfEmpty\("musicProductionAgent", "productionAgent"\)/);
  assert.match(fixSource, /copyAgentDeployModelIfEmpty\("musicProductionAgent:decisionAgent", "productionAgent:decisionAgent"\)/);
});

test("unified task worker renews leases and wraps long music tasks with timeout", () => {
  const workerSource = fs.readFileSync(path.join(process.cwd(), "src", "services", "unifiedTaskWorker.ts"), "utf8");
  const coordinatorSource = fs.readFileSync(path.join(process.cwd(), "src", "services", "taskCoordinator.ts"), "utf8");

  assert.match(coordinatorSource, /export async function renewUnifiedTaskLease/);
  assert.match(workerSource, /TASK_LEASE_RENEW_MS/);
  assert.match(workerSource, /renewUnifiedTaskLease\(Number\(task\.id\), TASK_LEASE_MS\)/);
  assert.match(workerSource, /runTaskHandlerWithTimeout\(task, handler\(payload, task\)\)/);
  assert.match(workerSource, /handler\.startsWith\("music-"\)/);
});
