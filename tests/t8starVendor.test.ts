import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { transform } from "sucrase";
import { VM } from "vm2";

type AxiosCall = { method: "get" | "post"; url: string; body?: any; options?: any };

function loadVendor(responses: any[]) {
  const calls: AxiosCall[] = [];
  const code = fs.readFileSync(path.join(process.cwd(), "data", "vendor", "t8star.ts"), "utf8");
  const jsCode = transform(code, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
  const exports: Record<string, any> = {};
  const queue = [...responses];
  const axios = {
    post: async (url: string, body: any, options: any) => {
      calls.push({ method: "post", url, body, options });
      return { data: queue.shift() };
    },
    get: async (url: string, options: any) => {
      calls.push({ method: "get", url, options });
      return { data: queue.shift() };
    },
  };
  new VM({
    sandbox: {
      exports,
      axios,
      logger: () => {},
      urlToBase64: async (url: string) => `base64:${url}`,
      pollTask: async (fn: () => Promise<any>) => {
        for (let index = 0; index < 10; index++) {
          const result = await fn();
          if (result.completed || result.error) return result;
        }
        return { completed: false, error: "test poll limit reached" };
      },
      createOpenAI: () => ({ chat: () => ({}) }),
    },
  }).run(jsCode);
  exports.vendor.inputValues.apiKey = "test-key";
  return { exports, calls };
}

const imageConfig = {
  prompt: "portrait",
  referenceList: [{ type: "image", sourceType: "base64", base64: "data:image/png;base64,abc" }],
  size: "2K",
  aspectRatio: "9:16",
};

const imageModel = {
  name: "GPT Image 2",
  modelName: "gpt-image-2",
  type: "image",
  mode: ["text", "singleImage", "multiReference"],
};

const musicModel = {
  name: "Suno V5.5",
  modelName: "chirp-fenix",
  type: "music",
  durationRange: { max: 480 },
  durationControl: "targetOnly",
  outputFormats: ["mp3"],
  vocal: "optional",
  lyrics: "optional",
  referenceAudio: false,
  loop: false,
};

test("T8Star defaults to the synchronous low-cost image endpoint", async () => {
  const runtime = loadVendor([{ data: [{ url: "https://example.com/image.png" }] }]);
  const result = await runtime.exports.imageRequest(imageConfig, imageModel);

  assert.equal(result, "https://example.com/image.png");
  assert.equal(runtime.calls[0].url, "https://ai.t8star.org/v1/images/generations");
  assert.equal(runtime.calls[0].body.model, "gpt-image-2");
  assert.equal(runtime.calls[0].body.size, "1152x2048");
  assert.deepEqual(runtime.calls[0].body.image, ["data:image/png;base64,abc"]);
  assert.equal(runtime.calls[0].body.image_urls, undefined);
  assert.equal(runtime.calls[0].body.resolution, undefined);
});

test("T8Star low-cost image endpoint maps base64 results", async () => {
  const runtime = loadVendor([{ data: [{ b64_json: "encoded-image" }] }]);
  const result = await runtime.exports.imageRequest(
    { ...imageConfig, referenceList: [], size: "1K", aspectRatio: "1:1" },
    imageModel,
  );

  assert.equal(result, "data:image/png;base64,encoded-image");
  assert.equal(runtime.calls[0].body.size, "1024x1024");
  assert.equal(runtime.calls[0].body.image, undefined);
});

test("T8Star low-cost channel maps 4K landscape dimensions within provider limits", async () => {
  const runtime = loadVendor([{ data: [{ url: "https://example.com/4k.png" }] }]);
  await runtime.exports.imageRequest(
    { ...imageConfig, referenceList: [], size: "4K", aspectRatio: "16:9" },
    imageModel,
  );

  assert.equal(runtime.calls[0].body.size, "3840x2160");
});

test("T8Star keeps the legacy async channel disabled by default", () => {
  const runtime = loadVendor([]);

  assert.equal(runtime.exports.imageSubmit, undefined);
  assert.equal(runtime.exports.imagePoll, undefined);
});

test("T8Star sends instrumental music through the documented clip feed protocol", async () => {
  const runtime = loadVendor([
    {
      clips: [
        { id: "submitted-clip-1", audio_url: "", status: "submitted" },
        { id: "submitted-clip-2", audio_url: "", status: "submitted" },
      ],
    },
    [
      { id: "submitted-clip-2", status: "complete", audio_url: "https://cdn.example/wrong-variant.mp3" },
      { id: "submitted-clip-1", status: "complete", audio_url: "https://cdn.example/music.mp3" },
    ],
  ]);
  const result = await runtime.exports.musicRequest(
    {
      prompt: "restrained piano and cello score, 78 BPM",
      title: "Debt Pulse",
      tags: "cinematic score, piano, cello, restrained",
      negativePrompt: "triumphant brass",
      vocalMode: "instrumental",
      durationSec: 22,
      referenceList: [{ type: "audio", sourceType: "base64", base64: "ignored" }],
      loop: true,
    },
    musicModel,
  );

  assert.deepEqual(result, {
    candidates: [
      { providerId: "submitted-clip-1", data: "https://cdn.example/music.mp3" },
      { providerId: "submitted-clip-2", data: "https://cdn.example/wrong-variant.mp3" },
    ],
  });
  assert.equal(runtime.calls[0].url, "https://ai.t8star.org/suno/generate");
  assert.equal(runtime.calls[0].options.headers.Authorization, "Bearer test-key");
  const submittedBody = runtime.calls[0].body as Record<string, unknown>;
  const unsupportedFieldsPresent = ["durationSec", "referenceList", "loop", "negative_tags", "make_instrumental", "generation_type"].map((key) => Object.prototype.hasOwnProperty.call(submittedBody, key));
  assert.deepEqual(submittedBody, {
    prompt: "",
    tags: "cinematic score, piano, cello, restrained",
    mv: "chirp-fenix",
    title: "Debt Pulse",
    continue_clip_id: null,
    continue_at: null,
    infill_start_s: null,
    infill_end_s: null,
  });
  assert.deepEqual(unsupportedFieldsPresent, [false, false, false, false, false, false]);
  assert.equal(runtime.calls[1].url, "https://ai.t8star.org/suno/feed/submitted-clip-1,submitted-clip-2");
});

test("T8Star retains exact submitted clips when one instrumental candidate fails", async () => {
  const runtime = loadVendor([
    { clips: [{ id: "submitted-clip-1", status: "submitted" }, { id: "submitted-clip-2", status: "submitted" }] },
    [
      { id: "submitted-clip-2", status: "failed", fail_reason: "provider rejected candidate" },
      { id: "submitted-clip-1", status: "complete", audio_url: "https://cdn.example/usable.mp3" },
    ],
  ]);

  const result = await runtime.exports.musicRequest({ prompt: "restrained piano", vocalMode: "instrumental", tags: "piano, restrained" }, musicModel);

  assert.deepEqual(result, {
    candidates: [
      { providerId: "submitted-clip-1", data: "https://cdn.example/usable.mp3" },
      { providerId: "submitted-clip-2", error: "provider rejected candidate" },
    ],
  });
});

test("T8Star refuses a completed instrumental response that omits the submitted clip", async () => {
  const runtime = loadVendor([
    { clips: [{ id: "submitted-clip-1", audio_url: "", status: "submitted" }] },
    [{ id: "different-clip", status: "complete", audio_url: "https://cdn.example/wrong.mp3" }],
  ]);

  await assert.rejects(
    () => runtime.exports.musicRequest({ prompt: "restrained piano", vocalMode: "instrumental", tags: "piano, restrained" }, musicModel),
    /test poll limit reached/,
  );
});

test("T8Star treats the documented live submit data string as an asynchronous Suno task identifier", async () => {
  const runtime = loadVendor([
    { code: "success", data: "submitted-task-1", message: "" },
    { code: "success", data: { status: "SUCCESS", data: [{ audio_url: "https://cdn.example/submitted-data.mp3" }] } },
  ]);

  const result = await runtime.exports.musicRequest(
    { prompt: "warm female vocal, sparse piano accompaniment", lyrics: "[Verse]\nA quiet room", vocalMode: "vocal", tags: "cinematic pop, piano" },
    musicModel,
  );

  assert.deepEqual(result, { candidates: [{ data: "https://cdn.example/submitted-data.mp3" }] });
  assert.equal(runtime.calls[1].url, "https://ai.t8star.org/suno/fetch/submitted-task-1");
});

test("T8Star sends confirmed lyrics as the Suno prompt for vocal music", async () => {
  const runtime = loadVendor([{ clips: [{ audio_url: "https://cdn.example/vocal.mp3" }] }]);
  const result = await runtime.exports.musicRequest(
    {
      prompt: "warm female vocal, sparse piano accompaniment",
      lyrics: "[Verse]\nA quiet room",
      vocalMode: "vocal",
      title: "Quiet Room",
      tags: "cinematic pop, female vocal, piano",
    },
    musicModel,
  );

  assert.deepEqual(result, { candidates: [{ data: "https://cdn.example/vocal.mp3" }] });
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].body.prompt, "[Verse]\nA quiet room");
  assert.equal(runtime.calls[0].body.tags, "cinematic pop, female vocal, piano");
  assert.equal(runtime.calls[0].body.make_instrumental, undefined);
  assert.equal(runtime.calls[0].body.generation_type, undefined);
});

test("T8Star fails completed Suno tasks that do not provide a downloadable audio URL", async () => {
  const runtime = loadVendor([
    { data: { task_id: "music-task-2" } },
    { code: "success", data: { status: "SUCCESS", data: [{ id: "clip-1" }] } },
  ]);

  await assert.rejects(
    () => runtime.exports.musicRequest({ prompt: "vocal piano", lyrics: "[Verse]\nTest", vocalMode: "vocal", tags: "piano" }, musicModel),
    /未返回可下载音频/,
  );
});

test("T8Star rejects Suno submissions that provide neither audio nor a task id", async () => {
  const runtime = loadVendor([{ code: "accepted", message: "queued", clips: [{ status: "submitted" }] }]);

  await assert.rejects(
    () => runtime.exports.musicRequest({ prompt: "vocal piano", lyrics: "[Verse]\nTest", vocalMode: "vocal", tags: "piano" }, musicModel),
    (cause: any) => {
      assert.match(cause.message, /任务 ID 或音频结果/);
      assert.match(cause.message, /responseSummary=/);
      assert.doesNotMatch(cause.message, /instrumental piano|test-key/);
      return true;
    },
  );
});

test("T8Star refuses ambiguous Suno vocal mode instead of inferring it from lyrics", async () => {
  const runtime = loadVendor([]);

  await assert.rejects(
    () => runtime.exports.musicRequest({ prompt: "instrumental piano", lyrics: "[Verse]\nUnexpected", tags: "piano" }, musicModel),
    /需要明确的 vocalMode/,
  );
  assert.equal(runtime.calls.length, 0);
});
