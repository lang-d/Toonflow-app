import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { transform } from "sucrase";
import { VM } from "vm2";

type AxiosCall = { method: "get" | "post" | "put"; url: string; body?: any; options?: any };

function loadVendor(responses: any[]) {
  const calls: AxiosCall[] = [];
  const chats: any[] = [];
  const code = fs.readFileSync(path.join(process.cwd(), "data", "vendor", "geeknow.ts"), "utf8");
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
    put: async (url: string, body: any, options: any) => {
      calls.push({ method: "put", url, body, options });
      return { data: {} };
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
      Buffer,
      logger: () => {},
      urlToBase64: async (url: string) => `data:converted;base64,from:${url}`,
      pollTask: async (fn: () => Promise<any>) => {
        for (let i = 0; i < 5; i += 1) {
          const result = await fn();
          if (result.completed) return result;
        }
        return { completed: true, error: "test poll timeout" };
      },
      createOpenAI,
    },
  }).run(jsCode);
  exports.vendor.inputValues.apiKey = "Bearer test-key";
  return { exports, calls, chats };
}

const imageModel = {
  name: "GPT Image 2 Pro",
  modelName: "gpt-image-2-pro",
  type: "image",
  mode: ["text", "singleImage", "multiReference"],
};

const vipImageModel = {
  name: "GPT Image 2 VIP",
  modelName: "gpt-image-2-vip",
  type: "image",
  mode: ["text", "singleImage", "multiReference"],
};

const manxueVideoModel = {
  name: "Manxue 2.0",
  modelName: "manxue-2.0",
  type: "video",
  mode: ["text", "singleImage", "startEndRequired", ["imageReference:4", "audioReference:1"]],
  audio: "optional",
  durationResolutionMap: [{ duration: [4, 8, 12], resolution: ["480P", "720P"] }],
};

const seedanceVideoModel = {
  name: "Seedance 2.0 Pro",
  modelName: "seedance-2.0-pro",
  type: "video",
  mode: ["text", "singleImage", "startEndRequired", ["imageReference:9", "videoReference:3", "audioReference:3"]],
  audio: "optional",
  durationResolutionMap: [{ duration: [4, 8, 12], resolution: ["480p", "720p", "1080p"] }],
};

test("Geeknow exposes the latest default model set", () => {
  const runtime = loadVendor([]);
  const modelNames = runtime.exports.vendor.models.map((model: any) => model.modelName);

  assert.ok(modelNames.includes("deepseek-v4-pro"));
  assert.ok(modelNames.includes("qwen3-max"));
  assert.ok(modelNames.includes("gpt-image-2-pro"));
  assert.ok(modelNames.includes("gpt-image-2-vip"));
  assert.ok(modelNames.includes("doubao-seedream-5-0-260128"));
  assert.ok(modelNames.includes("manxue-2.0"));
  assert.ok(modelNames.includes("seedance-2.0-pro"));
  assert.ok(!modelNames.includes("gpt-4o"));
  assert.ok(!modelNames.includes("deepseek-chat"));
  assert.ok(!modelNames.includes("gpt-image-2"));
  assert.ok(!modelNames.includes("sora-2"));
});

test("Geeknow text model uses the OpenAI-compatible chat endpoint", () => {
  const runtime = loadVendor([]);
  const result = runtime.exports.textRequest(
    { name: "DeepSeek V4 Pro", modelName: "deepseek-v4-pro", type: "text", think: false },
    false,
    0,
  );

  assert.equal(result.modelName, "deepseek-v4-pro");
  assert.equal(result.options.baseURL, "https://www.geeknow.top/v1");
  assert.equal(result.options.apiKey, "test-key");
});

test("Geeknow image generation uses async task submission and polling", async () => {
  const runtime = loadVendor([
    { id: "task_img_123", object: "image_generation.task", status: "queued" },
    { id: "task_img_123", status: "processing", progress: 42, data: [] },
    { id: "task_img_123", status: "completed", data: [{ b64_json: "encoded-image" }] },
  ]);
  const result = await runtime.exports.imageRequest(
    { prompt: "cinematic apartment", referenceList: [], size: "4K", aspectRatio: "16:9" },
    imageModel,
  );

  assert.equal(result, "data:image/png;base64,encoded-image");
  assert.equal(runtime.calls[0].url, "https://www.geeknow.top/v1/images/generations/async");
  assert.equal(runtime.calls[0].body.model, "gpt-image-2-pro");
  assert.equal(runtime.calls[0].body.size, "3840x2160");
  assert.equal(runtime.calls[0].body.quality, "high");
  assert.equal(runtime.calls[0].body.response_format, "b64_json");
  assert.equal(runtime.calls[1].url, "https://www.geeknow.top/v1/images/generations/async/task_img_123");
});

test("Geeknow async image handles direct URL responses and VIP size mapping", async () => {
  const runtime = loadVendor([{ data: [{ url: "https://cdn.example.com/image.png" }] }]);
  const result = await runtime.exports.imageRequest(
    { prompt: "wide keynote visual", referenceList: [], size: "4K", aspectRatio: "21:9" },
    vipImageModel,
  );

  assert.equal(result, "data:converted;base64,from:https://cdn.example.com/image.png");
  assert.equal(runtime.calls[0].body.model, "gpt-image-2-vip");
  assert.equal(runtime.calls[0].body.size, "3808x1632");
  assert.equal(runtime.calls[0].body.response_format, undefined);
});

test("Geeknow image references are sent as Data URI inputs", async () => {
  const runtime = loadVendor([
    { task_id: "task_img_ref", status: "queued" },
    { id: "task_img_ref", status: "completed", data: [{ url: "https://cdn.example.com/ref.png" }] },
  ]);
  await runtime.exports.imageRequest(
    {
      prompt: "keep character identity",
      referenceList: [
        { type: "image", sourceType: "base64", base64: "data:image/png;base64,abc" },
        { type: "image", sourceType: "base64", base64: "rawbase64" },
      ],
      size: "2K",
      aspectRatio: "3:2",
    },
    imageModel,
  );

  assert.deepEqual(runtime.calls[0].body.image, ["data:image/png;base64,abc", "data:image/png;base64,rawbase64"]);
});

test("Geeknow manxue video uploads reference images and submits content URL payload", async () => {
  const runtime = loadVendor([
    {
      success: true,
      data: {
        upload_url: "https://upload.example.com/input.png?signature=test",
        public_url: "https://cdn.example.com/input.png",
      },
    },
    { id: "video_123", task_id: "video_123", status: "queued" },
    { id: "video_123", status: "completed", video_url: "https://cdn.example.com/video.mp4" },
  ]);

  const result = await runtime.exports.videoRequest(
    {
      prompt: "@image1; move naturally",
      duration: 8,
      resolution: "720P",
      aspectRatio: "9:16",
      referenceList: [{ type: "image", sourceType: "base64", base64: "data:image/png;base64,abc" }],
      audio: false,
      mode: ["singleImage"],
    },
    manxueVideoModel,
  );

  assert.equal(result, "data:converted;base64,from:https://cdn.example.com/video.mp4");
  assert.equal(runtime.calls[0].method, "post");
  assert.equal(runtime.calls[0].url, "https://www.geeknow.top/api/upload/presign");
  assert.equal(runtime.calls[1].method, "put");
  assert.equal(runtime.calls[1].url, "https://upload.example.com/input.png?signature=test");
  assert.equal(runtime.calls[2].url, "https://www.geeknow.top/v1/videos");
  assert.equal(runtime.calls[2].body.model, "manxue-2.0");
  assert.equal(runtime.calls[2].body.seconds, "8");
  assert.equal(runtime.calls[2].body.ratio, "9:16");
  assert.equal(runtime.calls[2].body.resolution, "720P");
  assert.deepEqual(runtime.calls[2].body.content, [
    { type: "text", text: "@image1; move naturally" },
    { type: "image_url", role: "first_frame", image_url: { url: "https://cdn.example.com/input.png" } },
  ]);
  assert.equal(runtime.calls[3].url, "https://www.geeknow.top/v1/videos/video_123");
});

test("Geeknow seedance video submits URL fields after upload", async () => {
  const runtime = loadVendor([
    { success: true, data: { upload_url: "https://upload.example.com/a.png", public_url: "https://cdn.example.com/a.png" } },
    { success: true, data: { upload_url: "https://upload.example.com/b.png", public_url: "https://cdn.example.com/b.png" } },
    { id: "video_456", status: "queued" },
    { id: "video_456", status: "completed", video_url: "https://cdn.example.com/seedance.mp4" },
  ]);

  await runtime.exports.videoRequest(
    {
      prompt: "transition from first to last frame",
      duration: 12,
      resolution: "1080p",
      aspectRatio: "16:9",
      referenceList: [
        { type: "image", sourceType: "base64", base64: "data:image/png;base64,aaa" },
        { type: "image", sourceType: "base64", base64: "data:image/png;base64,bbb" },
      ],
      audio: false,
      mode: ["startEndRequired"],
    },
    seedanceVideoModel,
  );

  assert.equal(runtime.calls[4].body.model, "seedance-2.0-pro");
  assert.equal(runtime.calls[4].body.duration, 12);
  assert.equal(runtime.calls[4].body.aspect_ratio, "16:9");
  assert.equal(runtime.calls[4].body.resolution, "1080p");
  assert.equal(runtime.calls[4].body.first_image, "https://cdn.example.com/a.png");
  assert.equal(runtime.calls[4].body.last_image, "https://cdn.example.com/b.png");
});

test("Geeknow video failure surfaces provider error message", async () => {
  const runtime = loadVendor([
    { id: "video_123", task_id: "video_123", status: "queued" },
    { id: "video_123", status: "failed", error: { message: "invalid size" } },
  ]);

  await assert.rejects(
    () =>
      runtime.exports.videoRequest(
        {
          prompt: "bad request",
          duration: 12,
          resolution: "720P",
          aspectRatio: "16:9",
          referenceList: [],
          audio: false,
          mode: ["text"],
        },
        manxueVideoModel,
      ),
    /invalid size/,
  );
});
