import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildImageArgs,
  buildMusicArgs,
  discoverDreaminaMediaModels,
  discoverDreaminaMusicModels,
  discoverMusicCommandsFromHelp,
  extractMusicDurationRange,
  extractSupportedFlags,
  findFirstDreaminaImageFile,
  parseDreaminaImagePollOutput,
  parseDreaminaTaskOutput,
  resolveDreaminaImagePollResult,
} from "../src/utils/dreaminaCli";

test("Dreamina image async output keeps querying tasks pending", () => {
  const submitId = "image-submit-a";
  const querying = parseDreaminaImagePollOutput(
    JSON.stringify({
      submit_id: submitId,
      gen_status: "querying",
      queue_info: { queue_idx: 7, queue_status: 1, queue_length: 20 },
    }),
    submitId,
  );
  assert.equal(querying.status, "generating");
  assert.deepEqual(querying.queueInfo, { index: 7, status: 1, length: 20 });
  assert.equal(querying.imageUrl, undefined);

  const success = parseDreaminaImagePollOutput(
    JSON.stringify({
      submit_id: submitId,
      gen_status: "success",
      image_url: "https://example.com/right.png",
    }),
    submitId,
  );
  assert.equal(success.status, "success");
  assert.equal(success.imageUrl, "https://example.com/right.png");

  const mixed = parseDreaminaImagePollOutput(
    [
      JSON.stringify({ submit_id: submitId, gen_status: "querying" }),
      JSON.stringify({ submit_id: "image-submit-b", gen_status: "success", image_url: "https://example.com/wrong.png" }),
    ].join("\n"),
    submitId,
  );
  assert.equal(mixed.status, "generating");
  assert.equal(mixed.imageUrl, undefined);
});

test("Dreamina 5.0 image models are discovered from their CLI command help", () => {
  const textToImageHelp = "--model_version string supported values: 3.0, 4.7, 5.0";
  const imageToImageHelp = "--model_version string supported values: 4.7, 5.0";

  const textToImage = discoverDreaminaMediaModels("text2image", textToImageHelp).find((model) => model.modelName === "text2image:5.0");
  const imageToImage = discoverDreaminaMediaModels("image2image", imageToImageHelp).find((model) => model.modelName === "image2image:5.0");

  assert.deepEqual(textToImage?.mode, ["text"]);
  assert.deepEqual(imageToImage?.mode, ["singleImage", "multiReference"]);
  assert.equal(textToImage?.type, "image");
  assert.equal(imageToImage?.type, "image");
});

test("Dreamina 5.0 text-to-image args retain the CLI model key and remain asynchronous", () => {
  const imageArgs = buildImageArgs(
    { prompt: "test", size: "4K", aspectRatio: "16:9", referenceList: [] },
    { name: "image", modelName: "text2image:5.0", type: "image" } as any,
  );
  assert.equal(imageArgs.command, "text2image");
  assert.equal(imageArgs.args.includes("--resolution_type=4k"), true);
  assert.equal(imageArgs.args.includes("--model_version=5.0"), true);
  assert.equal(imageArgs.args.includes("--generate_num=1"), true);
  assert.equal(imageArgs.args.some((arg) => arg.startsWith("--poll=")), false);
});

test("Dreamina image args keep an explicit requested count and reject invalid counts", () => {
  const explicit = buildImageArgs(
    { prompt: "test", size: "2K", aspectRatio: "16:9", generateCount: 3 },
    { name: "image", modelName: "text2image:5.0", type: "image" } as any,
  );
  assert.equal(explicit.args.includes("--generate_num=3"), true);
  assert.throws(
    () => buildImageArgs(
      { prompt: "test", size: "2K", aspectRatio: "16:9", generateCount: 1.5 },
      { name: "image", modelName: "text2image:5.0", type: "image" } as any,
    ),
    /generateCount must be an integer from 1 to 10/,
  );
});

test("Dreamina image polling accepts the first downloadable result without waiting for all provider candidates", () => {
  const submitId = "image-submit-a";
  const querying = parseDreaminaImagePollOutput(
    JSON.stringify({ submit_id: submitId, gen_status: "querying", image_url: "https://example.com/early.png" }),
    submitId,
  );
  const early = resolveDreaminaImagePollResult(querying, {
    data: "data:image/png;base64,EARLY",
    rawOutput: "querying",
    failureFallback: "unexpected failure",
  });
  assert.equal(early.completed, true);
  assert.equal(early.data, "data:image/png;base64,EARLY");

  const unknown = parseDreaminaImagePollOutput("temporary query transport issue", submitId);
  const unknownResult = resolveDreaminaImagePollResult(unknown, {
    rawOutput: "temporary query transport issue",
    failureFallback: "unexpected failure",
  });
  assert.equal(unknownResult.completed, false);

  const stillGenerating = resolveDreaminaImagePollResult(
    parseDreaminaImagePollOutput(JSON.stringify({ submit_id: submitId, gen_status: "querying" }), submitId),
    { rawOutput: "still generating", failureFallback: "unexpected failure" },
  );
  assert.equal(stillGenerating.completed, false);

  const success = parseDreaminaImagePollOutput(
    JSON.stringify({ submit_id: submitId, gen_status: "success", image_url: "https://example.com/final.png" }),
    submitId,
  );
  const complete = resolveDreaminaImagePollResult(success, {
    data: success.imageUrl,
    rawOutput: "success",
    failureFallback: "unexpected failure",
  });
  assert.equal(complete.completed, true);
  assert.equal(complete.data, "https://example.com/final.png");

  const noResultYet = resolveDreaminaImagePollResult(success, {
    rawOutput: "success without media",
    failureFallback: "unexpected failure",
  });
  assert.equal(noResultYet.completed, false);

  const failed = parseDreaminaImagePollOutput(
    JSON.stringify({ submit_id: submitId, gen_status: "failed", fail_reason: "provider rejected request" }),
    submitId,
  );
  const failure = resolveDreaminaImagePollResult(failed, {
    rawOutput: "failed",
    failureFallback: "unexpected failure",
  });
  assert.equal(failure.completed, true);
  assert.equal(failure.error, "provider rejected request");

  const finishWithoutMedia = resolveDreaminaImagePollResult(
    parseDreaminaImagePollOutput(JSON.stringify({ submit_id: submitId, gen_status: "querying", queue_info: { queue_status: "Finish" } }), submitId),
    { rawOutput: "finish without media", failureFallback: "unexpected failure" },
  );
  assert.equal(finishWithoutMedia.completed, false);

  const finishWithFirstImage = resolveDreaminaImagePollResult(
    parseDreaminaImagePollOutput(JSON.stringify({ submit_id: submitId, gen_status: "querying", queue_info: { queue_status: "Finish" } }), submitId),
    { data: "data:image/png;base64,FIRST", rawOutput: "finish with first image", failureFallback: "unexpected failure" },
  );
  assert.equal(finishWithFirstImage.completed, true);
  assert.equal(finishWithFirstImage.data, "data:image/png;base64,FIRST");
});

test("Dreamina multi-image downloads persist the first generated image only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-dreamina-first-image-"));
  try {
    const baseTime = new Date("2026-08-09T15:50:37.000Z");
    for (const [name, offset] of [["task_image_4.png", 3], ["task_image_1.png", 0], ["task_image_2.png", 1], ["task_image_3.png", 2]] as const) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, name);
      fs.utimesSync(file, baseTime, new Date(baseTime.getTime() + offset * 1000));
    }
    assert.equal(path.basename(findFirstDreaminaImageFile(dir) || ""), "task_image_1.png");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Dreamina music commands are discovered only from CLI help", () => {
  const currentHelp = [
    "Generator Commands:",
    "  text2image           Submit a Dreamina text-to-image task",
    "  text2video           Submit a Dreamina text-to-video task",
  ].join("\n");
  assert.deepEqual(discoverMusicCommandsFromHelp(currentHelp), []);

  const musicHelp = [
    "Generator Commands:",
    "  text2music           Submit a Dreamina SeedMusic task",
    "  text2video           Submit a Dreamina text-to-video task",
  ].join("\n");
  assert.deepEqual(discoverMusicCommandsFromHelp(musicHelp), ["text2music"]);
});

test("Dreamina music args include only supported optional flags", () => {
  const help = [
    "--prompt string",
    "--model_version supported values: seedmusic1.0_preview",
    "--duration int",
    "--lyrics string",
    "--vocal_mode string",
    "--seed int",
  ].join("\n");
  const args = buildMusicArgs(
    {
      prompt: "Pop Ballad, Chinese lyrics, BPM around 70.",
      durationSec: 90,
      lyrics: "short lyric idea",
      vocalMode: "vocal",
      negativePrompt: "heavy metal",
      outputFormat: "mp3",
      seed: 42,
      referenceList: [],
    },
    {
      name: "SeedMusic",
      modelName: "text2music:seedmusic1.0_preview",
      type: "music",
      supportedFlags: extractSupportedFlags(help),
    } as any,
  );
  assert.equal(args.command, "text2music");
  assert.equal(args.args.includes("--model_version=seedmusic1.0_preview"), true);
  assert.equal(args.args.includes("--duration=90"), true);
  assert.equal(args.args.includes("--lyrics=short lyric idea"), true);
  assert.equal(args.args.includes("--vocal_mode=vocal"), true);
  assert.equal(args.args.includes("--seed=42"), true);
  assert.equal(args.args.some((arg) => arg.startsWith("--negative_prompt=")), false);
  assert.equal(args.args.some((arg) => arg.startsWith("--output_format=")), false);
});

test("Dreamina music declares a duration parameter only when its CLI help exposes one", () => {
  assert.equal(discoverDreaminaMusicModels("text2music", "--prompt string\n--duration_sec int")[0]?.durationParameter, true);
  assert.equal(discoverDreaminaMusicModels("text2music", "--prompt string\n--lyrics string")[0]?.durationParameter, false);
});

test("Dreamina music duration range is not capped by video duration limits", () => {
  const help = [
    "--duration int supported values: 70, 90, 120",
    "--smart_duration bool",
  ].join("\n");
  assert.deepEqual(extractMusicDurationRange(help), { min: 70, max: 120 });
});

test("Dreamina task parser extracts audio urls for music results", () => {
  const submitId = "music-submit-a";
  const parsed = parseDreaminaTaskOutput(
    JSON.stringify({
      submit_id: submitId,
      gen_status: "success",
      audio_url: "https://example.com/right.mp3",
    }),
    submitId,
  );
  assert.equal(parsed.status, "success");
  assert.equal(parsed.audioUrl, "https://example.com/right.mp3");
});
