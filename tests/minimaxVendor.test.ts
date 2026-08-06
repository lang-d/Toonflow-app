import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { transform } from "sucrase";
import { VM } from "vm2";

type AxiosCall = { method: "get" | "post"; url: string; body?: any; options?: any };

function loadVendor(options: { submit?: any; query?: any; file?: any; postError?: any; queryError?: any } = {}) {
  const calls: AxiosCall[] = [];
  const code = fs.readFileSync(path.join(process.cwd(), "data", "vendor", "minimax.ts"), "utf8");
  const jsCode = transform(code, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
  const exports: Record<string, any> = {};
  const axios = {
    post: async (url: string, body: any, requestOptions: any) => {
      calls.push({ method: "post", url, body, options: requestOptions });
      if (options.postError) throw options.postError;
      return { data: options.submit ?? { task_id: "h3-task" } };
    },
    get: async (url: string, requestOptions: any) => {
      calls.push({ method: "get", url, options: requestOptions });
      if (options.queryError) throw options.queryError;
      if (url.includes("/v1/files/retrieve")) return { data: options.file ?? { base_resp: { status_code: 0 }, file: { download_url: "https://cdn.example.test/v1.mp4" } } };
      return { data: options.query ?? { task: { status: "succeeded", content: { url: "https://cdn.example.test/h3.mp4" } } } };
    },
  };
  new VM({
    sandbox: {
      exports,
      axios,
      logger: () => {},
      zipImage: async (value: string) => value,
      urlToBase64: async (url: string) => `data:video/mp4;base64,from:${url}`,
      pollTask: async (fn: () => Promise<any>) => fn(),
      createOpenAI: () => ({ chat: () => ({}) }),
    },
  }).run(jsCode);
  exports.vendor.inputValues.apiKey = "Bearer test-key";
  return { exports, calls };
}

const image = (value: string) => `data:image/png;base64,${Buffer.from(value).toString("base64")}`;
const video = (value: string) => `data:video/mp4;base64,${Buffer.from(value).toString("base64")}`;
const audio = (value: string) => `data:audio/mpeg;base64,${Buffer.from(value).toString("base64")}`;

function h3Config(overrides: Record<string, any> = {}) {
  return {
    prompt: "A character walks forward.",
    duration: 5,
    resolution: "2K",
    aspectRatio: "16:9",
    referenceList: [],
    mode: "text",
    ...overrides,
  };
}

function model(runtime: any, modelName: string) {
  return runtime.exports.vendor.models.find((item: any) => item.modelName === modelName);
}

test("MiniMax exposes H3 and the current Hailuo 2.3 generation only", () => {
  const runtime = loadVendor();
  const videos = runtime.exports.vendor.models.filter((item: any) => item.type === "video");
  assert.equal(runtime.exports.vendor.version, "2.2");
  assert.deepEqual(videos.map((item: any) => item.modelName), ["MiniMax-H3", "MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast"]);
  assert.equal(model(runtime, "MiniMax-H3").audio, true);
  assert.equal(model(runtime, "MiniMax-Hailuo-2.3-Fast").mode.includes("text"), false);
});

test("MiniMax H3 sends the documented V2 text-to-video request and downloads task.content.url", async () => {
  const runtime = loadVendor();
  const result = await runtime.exports.videoRequest(h3Config(), model(runtime, "MiniMax-H3"));

  assert.equal(result, "data:video/mp4;base64,from:https://cdn.example.test/h3.mp4");
  assert.deepEqual(runtime.calls[0], {
    method: "post",
    url: "https://api.minimaxi.com/v2/video_generation",
    body: {
      model: "MiniMax-H3",
      content: [{ type: "text", text: "A character walks forward." }],
      resolution: "2K",
      duration: 5,
      ratio: "16:9",
      aigc_watermark: false,
    },
    options: { headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" } },
  });
  assert.equal(runtime.calls[1].url, "https://api.minimaxi.com/v2/query/video_generation/h3-task");
});

test("MiniMax H3 maps keyframes and multimodal references to documented content roles", async () => {
  const firstLast = loadVendor();
  await firstLast.exports.videoRequest(
    h3Config({ mode: "startEndRequired", referenceList: [{ type: "image", base64: image("first") }, { type: "image", base64: image("last") }] }),
    model(firstLast, "MiniMax-H3"),
  );
  assert.deepEqual(firstLast.calls[0].body.content.slice(1).map((item: any) => item.role), ["first_frame", "last_frame"]);

  const references = loadVendor();
  await references.exports.videoRequest(
    h3Config({
      mode: [["imageReference:9", "videoReference:3", "audioReference:3"]],
      referenceList: [{ type: "image", base64: image("character") }, { type: "video", base64: video("movement") }, { type: "audio", base64: audio("voice") }],
    }),
    model(references, "MiniMax-H3"),
  );
  assert.deepEqual(references.calls[0].body.content.slice(1).map((item: any) => item.role), ["reference_image", "reference_video", "reference_audio"]);
});

test("MiniMax H3 rejects invalid reference contracts before submitting a paid task", async () => {
  const oversizedImage = `data:image/png;base64,${Buffer.alloc(30 * 1024 * 1024 + 1).toString("base64")}`;
  const invalidCases = [
    h3Config({ mode: "text", referenceList: [{ type: "image", base64: image("unexpected") }] }),
    h3Config({ mode: ["singleImage", ["imageReference:9"]], referenceList: [{ type: "image", base64: image("mixed") }] }),
    h3Config({ mode: [["audioReference:3"]], referenceList: [{ type: "audio", base64: audio("alone") }] }),
    h3Config({ mode: [["imageReference:9"]], referenceList: Array.from({ length: 10 }, (_, index) => ({ type: "image", base64: image(`reference-${index}`) })) }),
    h3Config({ mode: "singleImage", referenceList: [{ type: "image", base64: "data:image/gif;base64,AAAA" }] }),
    h3Config({ mode: "singleImage", referenceList: [{ type: "image", base64: oversizedImage }] }),
  ];

  for (const config of invalidCases) {
    const runtime = loadVendor();
    await assert.rejects(() => runtime.exports.videoRequest(config, model(runtime, "MiniMax-H3")));
    assert.equal(runtime.calls.length, 0);
  }
});

test("MiniMax H3 surfaces terminal task and provider failures", async () => {
  const failed = loadVendor({ query: { task: { status: "failed", error: { message: "safety rejection" } } } });
  await assert.rejects(() => failed.exports.videoRequest(h3Config(), model(failed, "MiniMax-H3")), /safety rejection/);

  const cancelled = loadVendor({ query: { task: { status: "cancelled" } } });
  await assert.rejects(() => cancelled.exports.videoRequest(h3Config(), model(cancelled, "MiniMax-H3")), /cancelled/);

  const missingUrl = loadVendor({ query: { task: { status: "succeeded", content: {} } } });
  await assert.rejects(() => missingUrl.exports.videoRequest(h3Config(), model(missingUrl, "MiniMax-H3")), /without a video URL/);

  const providerFailure = loadVendor({ postError: { response: { data: { error: { message: "rate limited" } } } } });
  await assert.rejects(() => providerFailure.exports.videoRequest(h3Config(), model(providerFailure, "MiniMax-H3")), /rate limited/);
});

test("MiniMax Hailuo 2.3 remains on V1 while Fast requires a first-frame image", async () => {
  const runtime = loadVendor({
    submit: { task_id: "v1-task", base_resp: { status_code: 0 } },
    query: { base_resp: { status_code: 0 }, status: "Success", file_id: "v1-file" },
  });
  const result = await runtime.exports.videoRequest(h3Config({ duration: 6, resolution: "768P", mode: "text" }), model(runtime, "MiniMax-Hailuo-2.3"));
  assert.equal(result, "data:video/mp4;base64,from:https://cdn.example.test/v1.mp4");
  assert.equal(runtime.calls[0].url, "https://api.minimaxi.com/v1/video_generation");
  assert.equal(runtime.calls[1].url, "https://api.minimaxi.com/v1/query/video_generation");

  const fast = loadVendor();
  await assert.rejects(() => fast.exports.videoRequest(h3Config({ duration: 6, resolution: "768P", mode: "text" }), model(fast, "MiniMax-Hailuo-2.3-Fast")), /requires exactly one first-frame image/);
  assert.equal(fast.calls.length, 0);
});
