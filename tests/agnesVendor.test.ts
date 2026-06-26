import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { transform } from "sucrase";
import { VM } from "vm2";

type AxiosCall = { method: "get" | "post"; url: string; body?: any; options?: any };

function loadVendor(responses: any[]) {
  const calls: AxiosCall[] = [];
  const chats: any[] = [];
  const code = fs.readFileSync(path.join(process.cwd(), "data", "vendor", "agnes.ts"), "utf8");
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
  const createOpenAI = (options: any) => ({
    chat: (modelName: string) => {
      const chat = { provider: "openai", options, modelName };
      chats.push(chat);
      return chat;
    },
  });
  new VM({
    sandbox: {
      exports,
      axios,
      logger: () => {},
      urlToBase64: async (url: string) => `data:video/mp4;base64,from:${url}`,
      pollTask: async (fn: () => Promise<any>) => fn(),
      createOpenAI,
    },
  }).run(jsCode);
  exports.vendor.inputValues.apiKey = "Bearer test-key";
  return { exports, calls, chats };
}

const imageModel = {
  name: "Agnes Image 2.1 Flash",
  modelName: "agnes-image-2.1-flash",
  type: "image",
  mode: ["text", "singleImage", "multiReference"],
};

const videoModel = {
  name: "Agnes Video V2.0",
  modelName: "agnes-video-v2.0",
  type: "video",
  mode: ["text"],
  audio: false,
  durationResolutionMap: [{ duration: [3, 5, 10, 18], resolution: ["480p", "720p", "1080p"] }],
};

test("Agnes text model uses the OpenAI-compatible chat endpoint", () => {
  const runtime = loadVendor([]);
  const result = runtime.exports.textRequest(
    { name: "Agnes 2.0 Flash", modelName: "agnes-2.0-flash", type: "text", think: false },
    false,
    0,
  );

  assert.equal(result.modelName, "agnes-2.0-flash");
  assert.equal(result.options.baseURL, "https://apihub.agnes-ai.com/v1");
  assert.equal(result.options.apiKey, "test-key");
});

test("Agnes image text-to-image requests base64 output", async () => {
  const runtime = loadVendor([{ data: [{ b64_json: "encoded-image" }] }]);
  const result = await runtime.exports.imageRequest(
    { prompt: "floating city", referenceList: [], size: "1K", aspectRatio: "4:3" },
    imageModel,
  );

  assert.equal(result, "data:image/png;base64,encoded-image");
  assert.equal(runtime.calls[0].url, "https://apihub.agnes-ai.com/v1/images/generations");
  assert.equal(runtime.calls[0].body.model, "agnes-image-2.1-flash");
  assert.equal(runtime.calls[0].body.prompt, "floating city");
  assert.equal(runtime.calls[0].body.size, "1024x768");
  assert.equal(runtime.calls[0].body.return_base64, true);
  assert.equal(runtime.calls[0].body.image, undefined);
});

test("Agnes image references are sent as Data URI base64 inputs", async () => {
  const runtime = loadVendor([{ data: [{ b64_json: "edited-image" }] }]);
  const result = await runtime.exports.imageRequest(
    {
      prompt: "make it cinematic",
      referenceList: [
        { type: "image", sourceType: "base64", base64: "data:image/png;base64,abc" },
        { type: "image", sourceType: "base64", base64: "rawbase64" },
      ],
      size: "2K",
      aspectRatio: "16:9",
    },
    imageModel,
  );

  assert.equal(result, "data:image/png;base64,edited-image");
  assert.deepEqual(runtime.calls[0].body.image, ["data:image/png;base64,abc", "data:image/png;base64,rawbase64"]);
  assert.deepEqual(runtime.calls[0].body.extra_body, { response_format: "b64_json" });
  assert.equal(runtime.calls[0].body.return_base64, undefined);
});

test("Agnes video model only exposes text-to-video mode", () => {
  const runtime = loadVendor([]);
  const model = runtime.exports.vendor.models.find((item: any) => item.modelName === "agnes-video-v2.0");

  assert.deepEqual(model.mode, ["text"]);
  assert.equal(model.mode.includes("singleImage"), false);
  assert.equal(model.mode.includes("startFrameOptional"), false);
  assert.equal(model.mode.includes("startEndRequired"), false);
});

test("Agnes text-to-video submits and polls the provider task", async () => {
  const runtime = loadVendor([
    { video_id: "video-123", status: "queued" },
    { status: "completed", remixed_from_video_id: "https://cdn.example.com/video.mp4" },
  ]);

  const result = await runtime.exports.videoRequest(
    {
      prompt: "slow camera move through a luminous city",
      duration: 5,
      resolution: "720p",
      aspectRatio: "16:9",
      referenceList: [{ type: "image", sourceType: "base64", base64: "data:image/png;base64,abc" }],
      audio: false,
      mode: ["text"],
    },
    videoModel,
  );

  assert.equal(result, "data:video/mp4;base64,from:https://cdn.example.com/video.mp4");
  assert.equal(runtime.calls[0].method, "post");
  assert.equal(runtime.calls[0].url, "https://apihub.agnes-ai.com/v1/videos");
  assert.equal(runtime.calls[0].body.model, "agnes-video-v2.0");
  assert.equal(runtime.calls[0].body.prompt, "slow camera move through a luminous city");
  assert.equal(runtime.calls[0].body.width, 1280);
  assert.equal(runtime.calls[0].body.height, 720);
  assert.equal(runtime.calls[0].body.num_frames, 121);
  assert.equal(runtime.calls[0].body.frame_rate, 24);
  assert.equal(runtime.calls[0].body.image, undefined);
  assert.equal(runtime.calls[1].method, "get");
  assert.equal(runtime.calls[1].url, "https://apihub.agnes-ai.com/agnesapi");
  assert.deepEqual(runtime.calls[1].options.params, { video_id: "video-123", model_name: "agnes-video-v2.0" });
});
