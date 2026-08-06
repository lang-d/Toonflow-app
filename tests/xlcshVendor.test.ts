import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { transform } from "sucrase";
import { VM } from "vm2";

type AxiosCall = { method: "post" | "get"; url: string; body?: any; options: any };

class FakeFormData {
  fields: Array<{ key: string; value: any; options?: any }> = [];

  append(key: string, value: any, options?: any) {
    this.fields.push({ key, value, options });
  }

  getHeaders() {
    return { "content-type": "multipart/form-data; boundary=xlcsh-test" };
  }
}

function loadVendor(options: {
  create?: any;
  poll?: any[];
  createError?: any;
  pollError?: any;
  buffer?: any;
} = {}) {
  const calls: AxiosCall[] = [];
  const pollCalls: Array<{ interval: number; timeout: number }> = [];
  const code = fs.readFileSync(path.join(process.cwd(), "data", "vendor", "xlcsh.ts"), "utf8");
  const jsCode = transform(code, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
  const exports: Record<string, any> = {};
  const pollResponses = [...(options.poll || [{ id: "task_1", status: "completed", metadata: { url: "https://cdn.example.test/result.mp4" } }])];
  const axios = {
    post: async (url: string, body: any, requestOptions: any) => {
      calls.push({ method: "post", url, body, options: requestOptions });
      if (options.createError) throw options.createError;
      return { data: options.create === undefined ? { id: "task_1" } : options.create };
    },
    get: async (url: string, requestOptions: any) => {
      calls.push({ method: "get", url, options: requestOptions });
      if (options.pollError) throw options.pollError;
      return { data: pollResponses.shift() || { id: "task_1", status: "in_progress" } };
    },
  };
  const pollTask = async (fn: () => Promise<any>, interval: number, timeout: number) => {
    pollCalls.push({ interval, timeout });
    for (let index = 0; index < 10; index += 1) {
      const result = await fn();
      if (result.completed || result.error) return result;
    }
    return { completed: false, error: "test poll timeout" };
  };
  new VM({
    sandbox: {
      exports,
      axios,
      Buffer: options.buffer || Buffer,
      FormData: FakeFormData,
      pollTask,
      logger: () => {},
      urlToBase64: async (url: string) => `data:video/mp4;base64,from:${url}`,
    },
  }).run(jsCode);
  exports.vendor.inputValues.apiKey = "Bearer test-key";
  return { exports, calls, pollCalls };
}

const image = (value: string) => `data:image/png;base64,${Buffer.from(value).toString("base64")}`;
const audio = (value: string) => `data:audio/mpeg;base64,${Buffer.from(value).toString("base64")}`;

function videoConfig(overrides: Record<string, any> = {}) {
  return {
    prompt: "A character walks forward.",
    duration: 8,
    resolution: "720p",
    aspectRatio: "16:9",
    referenceList: [],
    mode: ["text"],
    ...overrides,
  };
}

function formValues(form: FakeFormData, key: string) {
  return form.fields.filter((field) => field.key === key).map((field) => field.value);
}

test("XLCSH 2.0 exposes the three documented Seedance models", () => {
  const runtime = loadVendor();
  assert.equal(runtime.exports.vendor.id, "xlcsh");
  assert.equal(runtime.exports.vendor.version, "2.0");
  assert.equal(runtime.exports.vendor.inputValues.baseUrl, "https://new.xlcsh.top/v1");
  assert.deepEqual(runtime.exports.vendor.models.map((model: any) => model.modelName), [
    "seedance-2.0",
    "seedance-2.0-unlimited",
    "seedance-2.0-mini",
  ]);
  for (const model of runtime.exports.vendor.models) {
    assert.deepEqual(model.mode, ["text", "singleImage", "startEndRequired", ["imageReference:9", "audioReference:3"]]);
    assert.equal(model.durationResolutionMap[0].duration.length, 60);
    assert.deepEqual(model.durationResolutionMap[0].resolution, ["480p", "720p", "1080p", "4k"]);
  }
});

test("XLCSH submits text-to-video JSON, then polls until the completed task returns metadata.url", async () => {
  const runtime = loadVendor({
    poll: [
      { id: "task_1", status: "queued" },
      { id: "task_1", status: "in_progress" },
      { id: "task_1", status: "completed", metadata: { url: "https://cdn.example.test/result.mp4" } },
    ],
  });
  runtime.exports.vendor.inputValues.baseUrl = "https://api.example.test///";
  const model = runtime.exports.vendor.models[1];
  const result = await runtime.exports.videoRequest(videoConfig({ duration: 60, resolution: "4K", audio: false }), model);

  assert.equal(result, "data:video/mp4;base64,from:https://cdn.example.test/result.mp4");
  assert.equal(runtime.calls[0].url, "https://api.example.test/v1/videos");
  assert.deepEqual(runtime.calls[0].body, {
    model: "seedance-2.0-unlimited",
    prompt: "A character walks forward.",
    seconds: 60,
    size: "3840x2160",
    aspect_ratio: "16:9",
    resolution: "4k",
    generate_audio: false,
    stream: false,
  });
  assert.equal(runtime.calls[0].options.headers.Authorization, "Bearer test-key");
  assert.equal(runtime.calls[0].options.headers["Content-Type"], "application/json");
  assert.deepEqual(runtime.calls.slice(1).map((call: AxiosCall) => call.url), [
    "https://api.example.test/v1/videos/task_1",
    "https://api.example.test/v1/videos/task_1",
    "https://api.example.test/v1/videos/task_1",
  ]);
  assert.deepEqual(runtime.pollCalls, [{ interval: 3000, timeout: 30 * 60 * 1000 }]);
});

test("XLCSH maps keyframes, reference images, and audio to documented multipart fields", async () => {
  const runtime = loadVendor();
  const model = runtime.exports.vendor.models[0];
  const references = [
    { type: "image", sourceType: "base64", base64: image("start") },
    { type: "image", sourceType: "base64", base64: image("end") },
    { type: "image", sourceType: "base64", base64: image("reference") },
    { type: "audio", sourceType: "base64", base64: audio("voice") },
  ];
  await runtime.exports.videoRequest(videoConfig({
    resolution: "480p",
    aspectRatio: "9:16",
    audio: false,
    referenceList: references,
    mode: ["startEndRequired"],
  }), model);

  const form = runtime.calls[0].body as FakeFormData;
  assert.ok(form instanceof FakeFormData);
  assert.equal(formValues(form, "size")[0], "480x854");
  assert.equal(formValues(form, "generate_audio")[0], "false");
  assert.deepEqual(formValues(form, "input_start_image")[0], Buffer.from("start"));
  assert.deepEqual(formValues(form, "input_end_image")[0], Buffer.from("end"));
  assert.deepEqual(formValues(form, "input_reference"), [Buffer.from("reference")]);
  assert.deepEqual(formValues(form, "input_audio"), [Buffer.from("voice")]);
  assert.match(runtime.calls[0].options.headers["content-type"], /^multipart\/form-data/);
});

test("XLCSH maps a single image to input_start_image and preserves multi-reference order", async () => {
  const runtime = loadVendor();
  const model = runtime.exports.vendor.models[2];
  await runtime.exports.videoRequest(videoConfig({
    referenceList: [
      { type: "image", sourceType: "base64", base64: image("start") },
      { type: "image", sourceType: "base64", base64: image("a") },
      { type: "image", sourceType: "base64", base64: image("b") },
    ],
    mode: ["singleImage"],
  }), model);
  const singleForm = runtime.calls[0].body as FakeFormData;
  assert.deepEqual(formValues(singleForm, "input_start_image"), [Buffer.from("start")]);
  assert.deepEqual(formValues(singleForm, "input_reference"), [Buffer.from("a"), Buffer.from("b")]);

  const multiRuntime = loadVendor();
  await multiRuntime.exports.videoRequest(videoConfig({
    referenceList: [
      { type: "image", sourceType: "base64", base64: image("one") },
      { type: "image", sourceType: "base64", base64: image("two") },
      { type: "audio", sourceType: "base64", base64: audio("voice-1") },
      { type: "audio", sourceType: "base64", base64: audio("voice-2") },
    ],
    mode: [["imageReference:9", "audioReference:3"]],
  }), multiRuntime.exports.vendor.models[0]);
  const multiForm = multiRuntime.calls[0].body as FakeFormData;
  assert.deepEqual(formValues(multiForm, "input_reference"), [Buffer.from("one"), Buffer.from("two")]);
  assert.deepEqual(formValues(multiForm, "input_audio"), [Buffer.from("voice-1"), Buffer.from("voice-2")]);
});

test("XLCSH rejects invalid media contracts before submitting a paid request", async () => {
  const invalidCases = [
    videoConfig({ duration: 0 }),
    videoConfig({ resolution: "2K" }),
    videoConfig({ aspectRatio: "1:1" }),
    videoConfig({ mode: ["startEndRequired"], referenceList: [{ type: "image", sourceType: "base64", base64: image("only-start") }] }),
    videoConfig({ referenceList: Array.from({ length: 10 }, (_, index) => ({ type: "image", sourceType: "base64", base64: image(`image-${index}`) })) }),
    videoConfig({ referenceList: Array.from({ length: 4 }, (_, index) => ({ type: "audio", sourceType: "base64", base64: audio(`audio-${index}`) })) }),
    videoConfig({ referenceList: [{ type: "image", sourceType: "base64", base64: "data:image/gif;base64,AAAA" }] }),
    videoConfig({ referenceList: [{ type: "video", sourceType: "base64", base64: "data:video/mp4;base64,AAAA" }] }),
  ];

  for (const config of invalidCases) {
    const runtime = loadVendor();
    await assert.rejects(() => runtime.exports.videoRequest(config, runtime.exports.vendor.models[0]));
    assert.equal(runtime.calls.length, 0);
  }

  const oversizedRuntime = loadVendor({ buffer: { from: () => ({ length: 10 * 1024 * 1024 + 1 }) } });
  await assert.rejects(() => oversizedRuntime.exports.videoRequest(
    videoConfig({ referenceList: [{ type: "image", sourceType: "base64", base64: "data:image/png;base64,AAAA" }] }),
    oversizedRuntime.exports.vendor.models[0],
  ));
  assert.equal(oversizedRuntime.calls.length, 0);

  const totalRuntime = loadVendor({ buffer: { from: () => ({ length: 7 * 1024 * 1024 }) } });
  await assert.rejects(() => totalRuntime.exports.videoRequest(
    videoConfig({ referenceList: [
      { type: "image", sourceType: "base64", base64: "data:image/png;base64,AAAA" },
      { type: "image", sourceType: "base64", base64: "data:image/png;base64,AAAA" },
    ] }),
    totalRuntime.exports.vendor.models[0],
  ));
  assert.equal(totalRuntime.calls.length, 0);
});

test("XLCSH surfaces missing task IDs, failed tasks, malformed completions, and provider errors", async () => {
  const missingTask = loadVendor({ create: {} });
  await assert.rejects(() => missingTask.exports.videoRequest(videoConfig(), missingTask.exports.vendor.models[0]), /task ID/);
  assert.equal(missingTask.calls.length, 1);

  const failedTask = loadVendor({ poll: [{ id: "task_1", status: "failed", error: { message: "upstream failed" } }] });
  await assert.rejects(() => failedTask.exports.videoRequest(videoConfig(), failedTask.exports.vendor.models[0]), /upstream failed/);

  const missingUrl = loadVendor({ poll: [{ id: "task_1", status: "completed", metadata: {} }] });
  await assert.rejects(() => missingUrl.exports.videoRequest(videoConfig(), missingUrl.exports.vendor.models[0]), /downloadable video URL/);

  const providerFailure = loadVendor({ createError: { response: { data: { error: { message: "provider unavailable" } } } } });
  await assert.rejects(() => providerFailure.exports.videoRequest(videoConfig(), providerFailure.exports.vendor.models[0]), /provider unavailable/);
});
