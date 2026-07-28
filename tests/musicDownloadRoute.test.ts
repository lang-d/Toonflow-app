import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "toonflow-music-download-"));
process.env.TOONFLOW_APP_DATA_DIR = path.join(root, "app");
process.env.TOONFLOW_WORKSPACE_DIR = path.join(root, "workspace");
process.env.TOONFLOW_STORAGE_MODE = "workspace";
process.env.TOONFLOW_SYSTEM_DATA_DIR = path.resolve("data");
process.env.TOONFLOW_SKIP_SKILL_EMBEDDINGS = "1";
process.env.NODE_ENV = "test";

let db: any;
let downloadRoute: any;
let resolveMediaFilePath: typeof import("../src/services/storagePaths").resolveMediaFilePath;

async function postDownload(body: Record<string, unknown>) {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use("/", downloadRoute);
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function createAudioAsset(projectId: number, filename: string, content: string) {
  const relativePath = `/${projectId}/assets/audio/${filename}`;
  const localPath = resolveMediaFilePath(relativePath);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, content);
  const [assetsId] = await db("o_assets").insert({ projectId, name: "Music", type: "audio", startTime: Date.now() });
  const [childAssetId] = await db("o_assets").insert({ projectId, assetsId, name: filename, type: "audio", startTime: Date.now() });
  const [imageId] = await db("o_image").insert({ assetsId: childAssetId, filePath: relativePath, type: "audio", state: "complete" });
  await db("o_assets").where("id", childAssetId).update({ imageId });
  return { assetsId: Number(assetsId), childAssetId: Number(childAssetId), relativePath };
}

before(async () => {
  const [dbModule, routeModule, paths] = await Promise.all([
    import("../src/utils/db"),
    import("../src/routes/production/music/download"),
    import("../src/services/storagePaths"),
  ]);
  db = dbModule.default;
  await dbModule.dbReady;
  downloadRoute = routeModule.default;
  resolveMediaFilePath = paths.resolveMediaFilePath;
});

after(async () => {
  await db?.destroy();
  await fs.rm(root, { recursive: true, force: true });
});

test("downloads generated and trimmed music library versions plus cue candidates", async () => {
  const projectId = 2026072401;
  const now = Date.now();
  await db("o_project").insert({ id: projectId, name: "Music downloads", createTime: now });
  const [itemId] = await db("o_musicLibraryItem").insert({ projectId, workKey: "theme", workType: "score_theme", title: "Theme", state: "ready", createTime: now, updateTime: now });
  const [editionId] = await db("o_musicLibraryEdition").insert({ projectId, libraryItemId: itemId, editionKey: "master", editionType: "master", title: "Theme", state: "ready", createTime: now, updateTime: now });
  const generatedAsset = await createAudioAsset(projectId, "theme-v1.mp3", "generated-audio");
  const trimmedAsset = await createAudioAsset(projectId, "theme-cut-v1.wav", "trimmed-audio");
  const [generatedVersionId] = await db("o_musicLibraryVersion").insert({ projectId, editionId, version: 1, assetsId: generatedAsset.assetsId, childAssetId: generatedAsset.childAssetId, generationConfigJson: "{}", derivationType: "generated", state: "complete", createTime: now, updateTime: now });
  const [trimmedVersionId] = await db("o_musicLibraryVersion").insert({ projectId, editionId, version: 2, assetsId: trimmedAsset.assetsId, childAssetId: trimmedAsset.childAssetId, generationConfigJson: "{}", derivationType: "trimmed", sourceVersionId: generatedVersionId, state: "complete", createTime: now, updateTime: now });
  await db("o_musicCue").insert({ id: 8101, projectId, planId: 7101, planVersion: 1, cueKey: "cue-1", cueType: "bgm", title: "Cue", startRefJson: "{}", endRefJson: "{}", musicSpecJson: "{}", state: "ready", createTime: now, updateTime: now });
  const cueAsset = await createAudioAsset(projectId, "cue-v1.flac", "cue-audio");
  await db("o_musicCueAsset").insert({ id: 9101, projectId, cueId: 8101, version: 1, assetsId: cueAsset.assetsId, childAssetId: cueAsset.childAssetId, prompt: "", compiledPromptJson: "{}", state: "complete", selected: 0, createTime: now, updateTime: now });

  const generated = await postDownload({ projectId, targetType: "libraryVersion", targetId: generatedVersionId });
  assert.equal(generated.status, 200);
  assert.equal(generated.headers.get("content-type"), "audio/mpeg");
  assert.match(generated.headers.get("access-control-expose-headers") || "", /Content-Disposition/);
  assert.match(generated.headers.get("content-disposition") || "", /theme-v1\.mp3/);
  assert.equal(await generated.text(), "generated-audio");

  const trimmed = await postDownload({ projectId, targetType: "libraryVersion", targetId: trimmedVersionId });
  assert.equal(trimmed.status, 200);
  assert.equal(trimmed.headers.get("content-type"), "audio/wav");
  assert.match(trimmed.headers.get("content-disposition") || "", /theme-cut-v1\.wav/);
  assert.equal(await trimmed.text(), "trimmed-audio");

  const cue = await postDownload({ projectId, targetType: "cueAsset", targetId: 9101 });
  assert.equal(cue.status, 200);
  assert.equal(cue.headers.get("content-type"), "audio/flac");
  assert.match(cue.headers.get("content-disposition") || "", /cue-v1\.flac/);
  assert.equal(await cue.text(), "cue-audio");
});

test("rejects cross-project, incomplete, missing-asset and missing-file downloads", async () => {
  const projectId = 2026072402;
  const otherProjectId = 2026072403;
  const now = Date.now();
  await db("o_project").insert([{ id: projectId, name: "Download failures", createTime: now }, { id: otherProjectId, name: "Other project", createTime: now }]);
  const [itemId] = await db("o_musicLibraryItem").insert({ projectId, workKey: "failures", workType: "score_theme", title: "Failures", state: "ready", createTime: now, updateTime: now });
  const [editionId] = await db("o_musicLibraryEdition").insert({ projectId, libraryItemId: itemId, editionKey: "master", editionType: "master", title: "Failures", state: "ready", createTime: now, updateTime: now });
  const asset = await createAudioAsset(projectId, "missing-file.mp3", "will-be-removed");
  const [missingFileVersionId] = await db("o_musicLibraryVersion").insert({ projectId, editionId, version: 1, assetsId: asset.assetsId, childAssetId: asset.childAssetId, generationConfigJson: "{}", state: "complete", createTime: now, updateTime: now });
  await fs.unlink(resolveMediaFilePath(asset.relativePath));
  const [incompleteVersionId] = await db("o_musicLibraryVersion").insert({ projectId, editionId, version: 2, generationConfigJson: "{}", state: "generating", createTime: now, updateTime: now });
  const [missingAssetVersionId] = await db("o_musicLibraryVersion").insert({ projectId, editionId, version: 3, generationConfigJson: "{}", state: "complete", createTime: now, updateTime: now });

  for (const body of [
    { projectId: otherProjectId, targetType: "libraryVersion", targetId: missingFileVersionId },
    { projectId, targetType: "libraryVersion", targetId: incompleteVersionId },
    { projectId, targetType: "libraryVersion", targetId: missingAssetVersionId },
    { projectId, targetType: "libraryVersion", targetId: missingFileVersionId },
  ]) {
    const response = await postDownload(body);
    assert.equal(response.status, 400);
    const payload = await response.json() as { message?: string };
    assert.ok(payload.message);
    assert.doesNotMatch(payload.message || "", /toonflow-music-download-|workspace[\\/]/i);
  }
});
