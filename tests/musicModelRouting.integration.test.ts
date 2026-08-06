import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "toonflow-music-model-routing-"));
process.env.TOONFLOW_APP_DATA_DIR = path.join(root, "app");
process.env.TOONFLOW_WORKSPACE_DIR = path.join(root, "workspace");
process.env.TOONFLOW_STORAGE_MODE = "workspace";
process.env.TOONFLOW_SYSTEM_DATA_DIR = path.resolve("data");
process.env.TOONFLOW_SKIP_SKILL_EMBEDDINGS = "1";
process.env.NODE_ENV = "test";

let db: any;
let queueMusicLibraryGenerate: typeof import("../src/services/musicTaskQueue").queueMusicLibraryGenerate;
let queueMusicLibraryCompilePrompt: typeof import("../src/services/musicTaskQueue").queueMusicLibraryCompilePrompt;
let setProjectDefaultMusicModel: typeof import("../src/services/musicModelSelection").setProjectDefaultMusicModel;
let createMusicLibraryItem: typeof import("../src/services/musicLibrary").createMusicLibraryItem;
let saveMusicLibraryEdition: typeof import("../src/services/musicLibrary").saveMusicLibraryEdition;
let saveMusicPromptVersion: typeof import("../src/services/musicLibrary").saveMusicPromptVersion;

before(async () => {
  const [dbModule, queueModule, selectionModule, libraryModule, vendorModule] = await Promise.all([
    import("../src/utils/db"),
    import("../src/services/musicTaskQueue"),
    import("../src/services/musicModelSelection"),
    import("../src/services/musicLibrary"),
    import("../src/utils/vendor"),
  ]);
  db = dbModule.default;
  await dbModule.dbReady;
  queueMusicLibraryGenerate = queueModule.queueMusicLibraryGenerate;
  queueMusicLibraryCompilePrompt = queueModule.queueMusicLibraryCompilePrompt;
  setProjectDefaultMusicModel = selectionModule.setProjectDefaultMusicModel;
  createMusicLibraryItem = libraryModule.createMusicLibraryItem;
  saveMusicLibraryEdition = libraryModule.saveMusicLibraryEdition;
  saveMusicPromptVersion = libraryModule.saveMusicPromptVersion;
  vendorModule.writeCode("t8star", await fs.readFile(path.resolve("data/vendor/t8star.ts"), "utf8"));
  const runtimeModels = vendorModule.getRuntime("t8star")?.vendor?.models || [];
  const vendorConfig = await db("o_vendorConfig").where("id", "t8star").first();
  if (vendorConfig) await db("o_vendorConfig").where("id", "t8star").update({ enable: 1, models: JSON.stringify(runtimeModels) });
  else await db("o_vendorConfig").insert({ id: "t8star", enable: 1, inputValues: "{}", models: JSON.stringify(runtimeModels) });
  vendorModule.invalidateCache("t8star");
  const available = await vendorModule.getModelList("t8star");
  assert.ok(available.some((item: any) => item.type === "music" && item.modelName === "chirp-fenix"));
  if (!(await db("o_modelPrompt").where({ vendorId: "t8star", model: "chirp-fenix" }).first())) {
    await db("o_modelPrompt").insert({ vendorId: "t8star", model: "chirp-fenix", fileName: "suno-v55.md", path: "music/suno-v55.md" });
  }
});

after(async () => {
  await db?.destroy();
  await fs.rm(root, { recursive: true, force: true });
});

async function createFixture(projectId: number, promptModel: string | null = "best:chirp-fenix") {
  await db("o_project").insert({ id: projectId, name: `Routing ${projectId}`, createTime: Date.now() });
  const item = await createMusicLibraryItem({
    projectId,
    workKey: "routing-work",
    workType: "score_theme",
    title: "Routing work",
  });
  const edition = await saveMusicLibraryEdition({
    projectId,
    libraryItemId: Number(item.id),
    editionKey: "master",
    editionType: "master",
    title: "Master",
    vocalMode: "instrumental",
  });
  const prompt = await saveMusicPromptVersion({
    projectId,
    targetType: "edition",
    editionId: Number(edition.id),
    promptMode: promptModel ? "modelSpecific" : "generic",
    model: promptModel,
    prompt: "Restrained acoustic score",
    generationConfig: { tags: "acoustic, restrained" },
    source: "legacy",
  });
  return { editionId: Number(edition.id), promptVersionId: Number(prompt.id) };
}

test("explicit execution model overrides prompt provenance and is frozen into the task", async () => {
  const projectId = 2026080101;
  const fixture = await createFixture(projectId);
  const compileTask = await queueMusicLibraryCompilePrompt({
    projectId,
    editionId: fixture.editionId,
    model: "t8star:chirp-fenix",
  });
  const compiled = await db("o_tasks").where("id", compileTask.legacyTaskId).first();
  assert.equal(compiled.model, "t8star:chirp-fenix");
  assert.equal(JSON.parse(compiled.payloadJson).model, "t8star:chirp-fenix");
  const queued = await queueMusicLibraryGenerate({
    projectId,
    ...fixture,
    model: "t8star:chirp-fenix",
  });
  const task = await db("o_tasks").where("id", queued.legacyTaskId).first();
  const payload = JSON.parse(task.payloadJson);
  assert.equal(task.model, "t8star:chirp-fenix");
  assert.equal(payload.model, "t8star:chirp-fenix");
  assert.equal(payload.promptVersionId, fixture.promptVersionId);
});

test("project default is used only when the request has no explicit model", async () => {
  const projectId = 2026080102;
  const fixture = await createFixture(projectId, null);
  await setProjectDefaultMusicModel(projectId, "t8star:chirp-fenix");
  const queued = await queueMusicLibraryGenerate({ projectId, ...fixture });
  const task = await db("o_tasks").where("id", queued.legacyTaskId).first();
  assert.equal(task.model, "t8star:chirp-fenix");
  assert.equal(JSON.parse(task.payloadJson).model, "t8star:chirp-fenix");
});

test("missing or unavailable execution model is rejected before task creation", async () => {
  const projectId = 2026080103;
  const fixture = await createFixture(projectId);
  const beforeCount = Number((await db("o_tasks").count("id as count").first()).count);
  await assert.rejects(
    () => queueMusicLibraryGenerate({ projectId, ...fixture }),
    (cause: any) => cause?.code === "MUSIC_MODEL_REQUIRED",
  );
  await assert.rejects(
    () => queueMusicLibraryGenerate({ projectId, ...fixture, model: "best:chirp-fenix" }),
    (cause: any) => cause?.code === "MUSIC_MODEL_UNAVAILABLE",
  );
  const afterCount = Number((await db("o_tasks").count("id as count").first()).count);
  assert.equal(afterCount, beforeCount);
});
