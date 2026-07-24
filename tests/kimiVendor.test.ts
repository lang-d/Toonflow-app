import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { transform } from "sucrase";
import { VM } from "vm2";

function loadVendor() {
  const code = fs.readFileSync(path.join(process.cwd(), "data", "vendor", "kimi.ts"), "utf8");
  const jsCode = transform(code, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
  const exports: Record<string, any> = {};
  const chats: any[] = [];
  const createOpenAI = (options: any) => ({
    chat: (modelName: string) => {
      const chat = { options, modelName };
      chats.push(chat);
      return chat;
    },
  });
  new VM({ sandbox: { exports, createOpenAI } }).run(jsCode);
  return { exports, chats };
}

test("Kimi provides K3 only and starts with the official OpenAI-compatible endpoint", () => {
  const runtime = loadVendor();

  assert.equal(runtime.exports.vendor.id, "kimi");
  assert.deepEqual(runtime.exports.vendor.models, [
    { name: "Kimi K3", modelName: "kimi-k3", type: "text", think: true, supportsTemperature: false },
  ]);
  assert.equal(runtime.exports.vendor.inputValues.baseUrl, "https://api.moonshot.cn/v1");
});

test("Kimi normalizes the base URL and removes an optional Bearer prefix from the key", () => {
  const runtime = loadVendor();
  runtime.exports.vendor.inputValues.apiKey = "Bearer test-key";
  runtime.exports.vendor.inputValues.baseUrl = "https://api.moonshot.cn/";

  const result = runtime.exports.textRequest(runtime.exports.vendor.models[0], true, 0);

  assert.equal(result.modelName, "kimi-k3");
  assert.equal(result.options.baseURL, "https://api.moonshot.cn/v1");
  assert.equal(result.options.apiKey, "test-key");
});
