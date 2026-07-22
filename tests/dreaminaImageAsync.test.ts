import assert from "node:assert/strict";
import test from "node:test";
import {
  buildImageArgs,
  buildMusicArgs,
  discoverDreaminaMediaModels,
  discoverMusicCommandsFromHelp,
  extractMusicDurationRange,
  extractSupportedFlags,
  parseDreaminaImagePollOutput,
  parseDreaminaTaskOutput,
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
  assert.equal(imageArgs.args.some((arg) => arg.startsWith("--poll=")), false);
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
