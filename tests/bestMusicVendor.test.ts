import assert from "node:assert/strict";
import test from "node:test";
import { transform } from "sucrase";
import { VM } from "vm2";
import { upgradeBestMusicVendorCode } from "../src/lib/dbFixes/vendorConfigFixes";

const baseBestVendor = `
const vendor = { id: "best", version: "2.7.6", inputs: [], inputValues: { apiKey: "" }, models: [] };
const getBaseUrl = () => "https://api.4022543.xyz";
exports.vendor = vendor;
`;

function loadVendor(responses: any[], inputValues: Record<string, string> = { apiKey: "test-key" }) {
  const calls: any[] = [];
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
  const jsCode = transform(upgradeBestMusicVendorCode(baseBestVendor), { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
  new VM({
    sandbox: {
      exports,
      axios,
      logger: () => {},
      pollTask: async (fn: () => Promise<any>) => {
        for (let index = 0; index < 3; index += 1) {
          const result = await fn();
          if (result.completed || result.error) return result;
        }
        return { completed: false, error: "test poll limit reached" };
      },
    },
  }).run(jsCode);
  Object.assign(exports.vendor.inputValues, inputValues);
  return { exports, calls };
}

test("best upgrade is idempotent, keeps the adapter code, and hides Suno V5.5", () => {
  const upgraded = upgradeBestMusicVendorCode(baseBestVendor);
  assert.equal(upgradeBestMusicVendorCode(upgraded), upgraded);
  const runtime = loadVendor([]);
  const model = runtime.exports.vendor.models.find((item: any) => item.modelName === "chirp-fenix");
  assert.equal(model, undefined);
  assert.equal(typeof runtime.exports.musicRequestCheck, "function");
});

test("best uses the music key, boolean Suno flags, and a shared request check", async () => {
  const runtime = loadVendor(
    [{ data: "task-vocal" }, { data: { status: "SUCCESS", data: [{ id: "clip-1", audio_url: "https://cdn.example/vocal.mp3" }] } }],
    { apiKey: "Bearer generic-key", musicKey: "Bearer music-key" },
  );
  const model = { modelName: "chirp-fenix" };
  assert.deepEqual(runtime.exports.musicRequestCheck({ vocalMode: "instrumental", prompt: "", tags: "piano" }, model).issues.map((issue: any) => issue.code), ["instrumental_prompt_required"]);
  const result = await runtime.exports.musicRequest(
    { vocalMode: "vocal", lyrics: "[Verse]\nA quiet room", prompt: "quiet vocal ballad", title: "Quiet Room", tags: "piano, female vocal", negativePrompt: "heavy drums" },
    model,
  );
  assert.deepEqual(result, { candidates: [{ providerId: "clip-1", data: "https://cdn.example/vocal.mp3" }] });
  assert.equal(runtime.calls[0].options.headers.Authorization, "Bearer music-key");
  assert.equal(runtime.calls[0].body.custom_mode, true);
  assert.equal(runtime.calls[0].body.make_instrumental, false);
});

test("best accepts long music text and rejects only unsupported request modes", async () => {
  const runtime = loadVendor([]);
  const model = { modelName: "chirp-fenix" };
  assert.deepEqual(runtime.exports.musicRequestCheck({ vocalMode: "instrumental", prompt: "p".repeat(2000), tags: "t".repeat(500) }, model).issues, []);
  await assert.rejects(
    () => runtime.exports.musicRequest({ vocalMode: "instrumental", prompt: "piano", tags: "piano", referenceList: [{ type: "audio" }] }, model),
    /reference audio/i,
  );
});
