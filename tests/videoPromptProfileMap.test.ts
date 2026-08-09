import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

process.env.TOONFLOW_SKIP_DB_INIT = "1";

const root = process.cwd();

async function profileMapModule() {
  return await import("../src/services/videoPromptCompiler");
}

test("video prompt profile map resolves canonical model IDs without model-name rules", async () => {
  const { parseVideoPromptProfileMap, resolveVideoPromptContentProfile, resolveVideoPromptContentProfiles, resolveVideoPromptProfilePath } = await profileMapModule();
  const content = fs.readFileSync(path.join(root, "data", "modelPrompt", "video", "profileMap.json"), "utf8");
  const profileMap = parseVideoPromptProfileMap(content, "test-map");

  assert.equal(resolveVideoPromptProfilePath(profileMap, "minimax-h3"), "video/minimaxH3VideoMode.md");
  assert.equal(resolveVideoPromptProfilePath(profileMap, "seedance-2"), "video/seedance2Multi-parameterMode.md");
  assert.equal(resolveVideoPromptProfilePath(profileMap, "wan-2.6"), "video/wan2.6Single-imageFirstFrameMode.md");
  assert.equal(resolveVideoPromptProfilePath(profileMap, "unknown-model"), null);
  assert.equal(resolveVideoPromptProfilePath(profileMap, "../minimax-h3"), null);
  assert.equal(resolveVideoPromptContentProfiles(profileMap, "minimax-h3").length, 8);
  assert.equal(resolveVideoPromptContentProfiles(profileMap, "seedance-2").length, 0);
  assert.equal(resolveVideoPromptContentProfile(profileMap, "minimax-h3", "3d-animation-short")?.label, "3D 动画短片");
  assert.equal(resolveVideoPromptContentProfile(profileMap, "minimax-h3", "unknown-type"), null);
});

test("video prompt profile map rejects duplicate IDs and unsafe paths", async () => {
  const { parseVideoPromptProfileMap } = await profileMapModule();
  assert.throws(
    () => parseVideoPromptProfileMap('[{"modelId":"seedance-2","path":"video/a.md"},{"modelId":"seedance-2","path":"video/b.md"}]'),
    /duplicate model ID/,
  );
  assert.throws(
    () => parseVideoPromptProfileMap('[{"modelId":"seedance-2","path":"../outside.md"}]'),
    /unsafe profile path/,
  );
  assert.throws(
    () => parseVideoPromptProfileMap('[{"modelId":"minimax-h3","path":"video/a.md","referenceDialect":"unknown"}]'),
    /invalid reference dialect/,
  );
  assert.throws(
    () => parseVideoPromptProfileMap('[{"modelId":"minimax-h3","path":"video/a.md","contentProfiles":[{"id":"x","label":"X","path":"../outside.md"}]}]'),
    /invalid content profile/,
  );
  assert.throws(
    () => parseVideoPromptProfileMap('[{"modelId":"minimax-h3","path":"video/a.md","contentProfiles":[{"id":"x","label":"X","path":"video/a.md"},{"id":"x","label":"X2","path":"video/b.md"}]}]'),
    /duplicate content profile/,
  );
});

test("H3 reference contract uses official labels and never requests a second-pass repair", async () => {
  const { inspectReferenceTokenContract } = await profileMapModule();
  const items: any[] = [
    { item: { fileType: "image" }, meta: { inputOrder: 1, visualImageIndex: 1 } },
    { item: { fileType: "video" }, meta: { inputOrder: 2, videoReferenceIndex: 1 } },
    { item: { fileType: "audio" }, meta: { inputOrder: 3, audioReferenceIndex: 1 } },
  ];
  const accepted = inspectReferenceTokenContract("<Picture 1> <Video 1> <Audio 1>", items, "h3");
  assert.deepEqual(accepted.issues, []);
  const reported = inspectReferenceTokenContract("@Image1 <Picture 2>", items, "h3");
  assert.deepEqual(reported.expectedReferenceLabels, ["<Picture 1>", "<Video 1>", "<Audio 1>"]);
  assert.ok(reported.issues.length > 0);
  assert.ok(reported.issues.every((issue: any) => issue.severity === "warning"));
  assert.ok(reported.issues.some((issue: any) => issue.token === "@Image1"));
});
