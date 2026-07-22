import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "toonflow-music-library-"));
process.env.TOONFLOW_APP_DATA_DIR = path.join(root, "app");
process.env.TOONFLOW_WORKSPACE_DIR = path.join(root, "workspace");
process.env.TOONFLOW_STORAGE_MODE = "workspace";
process.env.TOONFLOW_SYSTEM_DATA_DIR = path.resolve("data");
process.env.TOONFLOW_SKIP_SKILL_EMBEDDINGS = "1";
process.env.NODE_ENV = "test";

let db: any;
let library: typeof import("../src/services/musicLibrary");
let trimMusicLibraryVersion: typeof import("../src/services/musicAudioTrim").trimMusicLibraryVersion;
let probeAudioDurationMs: typeof import("../src/services/musicAudioTrim").probeAudioDurationMs;
let projectMediaDirectory: typeof import("../src/services/storagePaths").projectMediaDirectory;
let resolveMediaFilePath: typeof import("../src/services/storagePaths").resolveMediaFilePath;

before(async () => {
  const [dbModule, libraryModule, trimModule, paths] = await Promise.all([
    import("../src/utils/db"),
    import("../src/services/musicLibrary"),
    import("../src/services/musicAudioTrim"),
    import("../src/services/storagePaths"),
  ]);
  db = dbModule.default;
  await dbModule.dbReady;
  library = libraryModule;
  trimMusicLibraryVersion = trimModule.trimMusicLibraryVersion;
  probeAudioDurationMs = trimModule.probeAudioDurationMs;
  projectMediaDirectory = paths.projectMediaDirectory;
  resolveMediaFilePath = paths.resolveMediaFilePath;
});

after(async () => {
  await db?.destroy();
  await fs.rm(root, { recursive: true, force: true });
});

test("music library versions are immutable, reusable and trim into a child WAV edition", async () => {
  const projectId = 1900000000001;
  await db("o_project").insert({ id: projectId, name: "Music library test", createTime: Date.now() });
  await db("o_script").insert([{ id: 101, projectId, name: "Episode 1", content: "A reveal" }, { id: 102, projectId, name: "Episode 2", content: "A return" }]);
  const [bibleId] = await db("o_musicBible").insert({ projectId, version: 1, title: "Bible", content: "Restrained score", styleProfileJson: "{}", sourceSummaryJson: "{}", state: "complete", createTime: Date.now(), updateTime: Date.now() });
  const [planId] = await db("o_musicPlan").insert({ projectId, scriptId: 101, mode: "episode", bibleId, bibleVersion: 1, version: 1, content: "Episode use", cueSheetJson: "[]", libraryPlanJson: "[]", state: "complete", createTime: Date.now(), updateTime: Date.now() });
  const cueIds = [201, 202];
  const cueRows = [101, 102].map((scriptId, index) => ({ id: cueIds[index], projectId, scriptId, planId, planVersion: 1, cueKey: `cue-${index + 1}`, cueType: "bgm", title: `Cue ${index + 1}`, startRefJson: "{}", endRefJson: "{}", durationSec: 2, durationMode: "estimated", estimatedDurationSec: 2, musicSpecJson: "{}", state: "ready", createTime: Date.now(), updateTime: Date.now() }));
  await db("o_musicCue").insert(cueRows);

  const item = await library.createMusicLibraryItem({ projectId, bibleId, workKey: "main-theme", workType: "score_theme", title: "Main Theme" });
  const edition = await library.saveMusicLibraryEdition({ projectId, libraryItemId: Number(item.id), editionKey: "master", editionType: "master", title: "Master" });
  const lyricsOne = await library.saveMusicLyricsVersion({ projectId, editionId: Number(edition.id), content: "first lyric", source: "ai" });
  await library.confirmMusicLyricsVersion({ projectId, editionId: Number(edition.id), lyricsVersionId: Number(lyricsOne.id) });
  const lyricsTwo = await library.saveMusicLyricsVersion({ projectId, editionId: Number(edition.id), content: "second lyric", source: "user", basedOnId: Number(lyricsOne.id) });
  await library.confirmMusicLyricsVersion({ projectId, editionId: Number(edition.id), lyricsVersionId: Number(lyricsTwo.id) });
  assert.equal((await db("o_musicLyricsVersion").where("id", lyricsOne.id).first()).state, "superseded");

  const promptOne = await library.saveMusicPromptVersion({ projectId, targetType: "edition", editionId: Number(edition.id), model: "test:model", prompt: "first prompt", generationConfig: { durationSec: 2 } });
  const promptTwo = await library.saveMusicPromptVersion({ projectId, targetType: "edition", editionId: Number(edition.id), model: "test:model", prompt: "second prompt", generationConfig: { durationSec: 2 }, basedOnId: Number(promptOne.id) });
  assert.equal((await db("o_musicPromptVersion").where("id", promptOne.id).first()).state, "superseded");
  assert.equal((await db("o_musicPromptVersion").where("id", promptTwo.id).first()).state, "active");

  const sourceRelative = `/${projectId}/assets/audio/source.wav`;
  const sourcePath = path.join(projectMediaDirectory(projectId), "assets", "audio", "source.wav");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  const ffmpeg = String((await import("ffmpeg-static")).default || "");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-y", sourcePath]);
  const original = await fs.readFile(sourcePath);
  const [parentAssetId] = await db("o_assets").insert({ projectId, name: "Source", type: "audio", startTime: Date.now() });
  const [childAssetId] = await db("o_assets").insert({ projectId, name: "Source.wav", type: "audio", assetsId: parentAssetId, startTime: Date.now() });
  const [imageId] = await db("o_image").insert({ assetsId: childAssetId, filePath: sourceRelative, type: "audio", state: "complete" });
  await db("o_assets").where("id", childAssetId).update({ imageId });
  const sourceVersion = await library.createMusicLibraryVersion({ projectId, editionId: Number(edition.id), promptVersionId: Number(promptTwo.id), lyricsVersionId: Number(lyricsTwo.id), model: "test:model", generationConfig: { durationSec: 2 }, generationDurationSec: 2, effectiveMusicDurationSec: 2 });
  await db("o_musicLibraryVersion").where("id", sourceVersion.id).update({ assetsId: parentAssetId, childAssetId, state: "complete" });
  await library.selectMusicLibraryVersion({ projectId, editionId: Number(edition.id), libraryVersionId: Number(sourceVersion.id) });

  await library.bindMusicCue({ projectId, cueId: Number(cueIds[0]), usageMode: "reuse", editionId: Number(edition.id), libraryVersionId: Number(sourceVersion.id) });
  await library.bindMusicCue({ projectId, cueId: Number(cueIds[1]), usageMode: "reuse", editionId: Number(edition.id), libraryVersionId: Number(sourceVersion.id) });
  assert.equal(await db("o_musicCueBinding").where("libraryVersionId", sourceVersion.id).count("id as count").first().then((row: any) => Number(row.count)), 2);

  const trimmed = await trimMusicLibraryVersion({ projectId, sourceLibraryVersionId: Number(sourceVersion.id), startMs: 250, endMs: 1250, fadeInMs: 100, fadeOutMs: 150, title: "One second edit", bindCueId: Number(cueIds[0]) });
  assert.ok(Math.abs(trimmed.durationMs - 1000) <= 50);
  const derived = await db("o_musicLibraryVersion").where("id", trimmed.libraryVersionId).first();
  const childEdition = await db("o_musicLibraryEdition").where("id", trimmed.editionId).first();
  assert.equal(derived.derivationType, "trimmed");
  assert.equal(Number(derived.sourceVersionId), Number(sourceVersion.id));
  assert.equal(childEdition.editionType, "short_edit");
  assert.equal(Number(childEdition.parentEditionId), Number(edition.id));
  assert.equal(childEdition.selectedVersionId, null);
  assert.equal(Number((await db("o_musicLibraryEdition").where("id", edition.id).first()).selectedVersionId), Number(sourceVersion.id));
  assert.deepEqual(await fs.readFile(sourcePath), original);
  const outputAsset = await db("o_assets").where("id", derived.childAssetId).first();
  const outputMedia = await db("o_image").where("id", outputAsset.imageId).first();
  assert.ok(Math.abs((await probeAudioDurationMs(resolveMediaFilePath(outputMedia.filePath))) - 1000) <= 50);

  const portable = await import("../src/services/projectPortable");
  const exported = await portable.generateProjectSnapshot(projectId, db);
  const imported = await portable.importPortableProject(exported.directory, db);
  const importedItem = await db("o_musicLibraryItem").where({ projectId: imported.projectId, workKey: "main-theme" }).first();
  const importedEditions = await db("o_musicLibraryEdition").where({ projectId: imported.projectId, libraryItemId: importedItem.id });
  const importedVersions = await db("o_musicLibraryVersion").where({ projectId: imported.projectId });
  const importedBindings = await db("o_musicCueBinding").where({ projectId: imported.projectId });
  assert.equal(importedEditions.length, 2);
  assert.equal(importedVersions.length, 2);
  assert.equal(importedBindings.length, 2);
  const importedShortEdition = importedEditions.find((row: any) => row.editionType === "short_edit");
  const importedMasterEdition = importedEditions.find((row: any) => row.editionType === "master");
  const importedTrimmedVersion = importedVersions.find((row: any) => row.derivationType === "trimmed");
  const importedSourceVersion = importedVersions.find((row: any) => row.derivationType === "generated");
  assert.equal(Number(importedShortEdition.parentEditionId), Number(importedMasterEdition.id));
  assert.equal(Number(importedTrimmedVersion.sourceVersionId), Number(importedSourceVersion.id));
  assert.ok(importedBindings.every((row: any) => importedVersions.some((version: any) => Number(version.id) === Number(row.libraryVersionId))));
});

test("legacy cue migration reuses the canonical library version without duplicating records", async () => {
  const projectId = 1900000000101;
  await db("o_project").insert({ id: projectId, name: "Legacy migration test", createTime: Date.now() });
  await db("o_script").insert({ id: 301, projectId, name: "Episode", content: "A scene" });
  const [bibleId] = await db("o_musicBible").insert({ projectId, version: 1, title: "Bible", content: "Score", styleProfileJson: "{}", sourceSummaryJson: "{}", state: "complete", createTime: Date.now(), updateTime: Date.now() });
  const [planId] = await db("o_musicPlan").insert({ projectId, scriptId: 301, mode: "episode", bibleId, bibleVersion: 1, version: 1, content: "Plan", cueSheetJson: "[]", libraryPlanJson: "[]", state: "complete", createTime: Date.now(), updateTime: Date.now() });
  const [cueId] = await db("o_musicCue").insert({ projectId, scriptId: 301, planId, planVersion: 1, cueKey: "legacy-cue", cueType: "bgm", title: "Cue", startRefJson: "{}", endRefJson: "{}", durationSec: 30, durationMode: "estimated", estimatedDurationSec: 30, musicSpecJson: "{}", state: "ready", createTime: Date.now(), updateTime: Date.now() });
  const item = await library.createMusicLibraryItem({ projectId, bibleId, workKey: "canonical", workType: "score_theme", title: "Canonical" });
  const edition = await library.saveMusicLibraryEdition({ projectId, libraryItemId: Number(item.id), editionKey: "master", editionType: "master" });
  const canonical = await library.createMusicLibraryVersion({ projectId, editionId: Number(edition.id), model: "legacy:model", generationConfig: { durationSec: 30 } });
  const [assetsId] = await db("o_assets").insert({ projectId, name: "Audio", type: "audio", startTime: Date.now() });
  const [childAssetId] = await db("o_assets").insert({ projectId, name: "Audio.mp3", type: "audio", assetsId, startTime: Date.now() });
  await db("o_musicLibraryVersion").where("id", canonical.id).update({ assetsId, childAssetId, state: "complete" });
  await library.bindMusicCue({ projectId, cueId: Number(cueId), usageMode: "new", editionId: Number(edition.id), libraryVersionId: Number(canonical.id) });
  const [legacyCueAssetId] = await db("o_musicCueAsset").insert({ projectId, cueId, version: 1, assetsId, childAssetId, prompt: "", compiledPromptJson: "{}", model: "legacy:model", state: "complete", selected: 0, createTime: Date.now(), updateTime: Date.now() });

  await library.ensureLegacyMusicLibraryMigration(projectId);
  await library.ensureLegacyMusicLibraryMigration(projectId);

  assert.equal(Number((await db("o_musicLibraryVersion").where("id", canonical.id).first()).legacyCueAssetId), Number(legacyCueAssetId));
  assert.equal(Number((await db("o_musicCueBinding").where("cueId", cueId).first()).libraryVersionId), Number(canonical.id));
  assert.equal(Number((await db("o_musicLibraryItem").where({ projectId }).count("id as count").first()).count), 1);
  assert.equal(Number((await db("o_musicLibraryVersion").where({ projectId }).count("id as count").first()).count), 1);
});

test("concurrent lyrics and prompt writes allocate unique versions and one active prompt", async () => {
  const projectId = 1900000000201;
  await db("o_project").insert({ id: projectId, name: "Version concurrency test", createTime: Date.now() });
  const item = await library.createMusicLibraryItem({ projectId, workKey: "versions", workType: "score_theme", title: "Versions" });
  const edition = await library.saveMusicLibraryEdition({ projectId, libraryItemId: Number(item.id), editionKey: "master", editionType: "master" });
  const lyrics = await Promise.all(Array.from({ length: 4 }, (_, index) => library.saveMusicLyricsVersion({ projectId, editionId: Number(edition.id), content: `lyrics ${index}` })));
  assert.deepEqual(lyrics.map((row: any) => Number(row.version)).sort((a, b) => a - b), [1, 2, 3, 4]);
  const prompts = await Promise.all(Array.from({ length: 4 }, (_, index) => library.saveMusicPromptVersion({ projectId, targetType: "edition", editionId: Number(edition.id), model: "test:model", prompt: `prompt ${index}`, generationConfig: { durationSec: 30 } })));
  assert.deepEqual(prompts.map((row: any) => Number(row.version)).sort((a, b) => a - b), [1, 2, 3, 4]);
  await library.confirmMusicLyricsVersion({ projectId, editionId: Number(edition.id), lyricsVersionId: Number(lyrics[0].id) });
  const linkedPrompt = await library.saveMusicPromptVersion({ projectId, targetType: "edition", editionId: Number(edition.id), lyricsVersionId: Number(lyrics[0].id), model: "test:model", prompt: "linked prompt", generationConfig: { durationSec: 30 } });
  const editedPrompt = await library.saveMusicPromptVersion({ projectId, targetType: "edition", editionId: Number(edition.id), basedOnId: Number(linkedPrompt.id), model: "test:model", prompt: "edited linked prompt", generationConfig: { durationSec: 30 } });
  assert.equal(Number(editedPrompt.lyricsVersionId), Number(lyrics[0].id));
  await assert.rejects(() => library.saveMusicPromptVersion({ projectId, targetType: "edition", editionId: Number(edition.id), model: "test:model", prompt: "raw lyrics", generationConfig: { durationSec: 30, lyrics: "must not be accepted" } }), /confirmed lyrics version/);
  assert.equal(Number((await db("o_musicPromptVersion").where({ projectId, editionId: edition.id, state: "active" }).count("id as count").first()).count), 1);
});

test("cue bindings reject incomplete, missing-edition and silence references", async () => {
  const projectId = 1900000000301;
  await db("o_project").insert({ id: projectId, name: "Binding validation test", createTime: Date.now() });
  await db("o_script").insert({ id: 401, projectId, name: "Episode", content: "Scene" });
  const [bibleId] = await db("o_musicBible").insert({ projectId, version: 1, title: "Bible", content: "Score", styleProfileJson: "{}", sourceSummaryJson: "{}", state: "complete", createTime: Date.now(), updateTime: Date.now() });
  const [planId] = await db("o_musicPlan").insert({ projectId, scriptId: 401, mode: "episode", bibleId, bibleVersion: 1, version: 1, content: "Plan", cueSheetJson: "[]", libraryPlanJson: "[]", state: "complete", createTime: Date.now(), updateTime: Date.now() });
  const [cueId] = await db("o_musicCue").insert({ projectId, scriptId: 401, planId, planVersion: 1, cueKey: "binding", cueType: "bgm", title: "Binding", startRefJson: "{}", endRefJson: "{}", durationSec: 30, durationMode: "estimated", estimatedDurationSec: 30, musicSpecJson: "{}", state: "ready", createTime: Date.now(), updateTime: Date.now() });
  const item = await library.createMusicLibraryItem({ projectId, workKey: "binding", workType: "score_theme", title: "Binding" });
  const edition = await library.saveMusicLibraryEdition({ projectId, libraryItemId: Number(item.id), editionKey: "master", editionType: "master" });
  const generating = await library.createMusicLibraryVersion({ projectId, editionId: Number(edition.id), model: "test:model", generationConfig: { durationSec: 30 } });

  await assert.rejects(() => library.bindMusicCue({ projectId, cueId: Number(cueId), usageMode: "new" }), /requires editionId/);
  await assert.rejects(() => library.bindMusicCue({ projectId, cueId: Number(cueId), usageMode: "new", editionId: Number(edition.id), libraryVersionId: Number(generating.id) }), /completed/);
  await assert.rejects(() => library.bindMusicCue({ projectId, cueId: Number(cueId), usageMode: "silence", editionId: Number(edition.id) }), /cannot bind/);
  const planned = await library.bindMusicCue({ projectId, cueId: Number(cueId), usageMode: "new", editionId: Number(edition.id) });
  assert.equal(planned.state, "planned");
  const missing = await library.bindMusicCue({ projectId, cueId: Number(cueId), usageMode: "reuse", editionId: Number(edition.id) });
  assert.equal(missing.state, "missing_asset");
});
