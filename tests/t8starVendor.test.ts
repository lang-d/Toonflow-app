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
      pollTask: async (fn: () => Promise<any>) => fn(),
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
