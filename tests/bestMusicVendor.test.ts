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

test("best music upgrade is idempotent and exposes only the Suno V5.5 music model", () => {
  const upgraded = upgradeBestMusicVendorCode(baseBestVendor);
  assert.equal(upgradeBestMusicVendorCode(upgraded), upgraded);
  const runtime = loadVendor([]);
  assert.equal(runtime.exports.vendor.inputs.some((item: any) => item.key === "musicKey"), true);
  assert.deepEqual(runtime.exports.vendor.models.filter((item: any) => item.type === "music"), [
    {
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
    },
  ]);
});

test("best music uses musicKey, submits vocal music, and polls the documented task endpoint", async () => {
  const runtime = loadVendor(
    [{ data: "task-vocal" }, { data: { status: "SUCCESS", data: [{ id: "clip-1", audio_url: "https://cdn.example/vocal.mp3" }] } }],
    { apiKey: "Bearer generic-key", musicKey: "Bearer music-key" },
  );
  const model = runtime.exports.vendor.models.find((item: any) => item.modelName === "chirp-fenix");
  const result = await runtime.exports.musicRequest(
    { vocalMode: "vocal", lyrics: "[Verse]\nA quiet room", prompt: "quiet vocal ballad", title: "Quiet Room", tags: "piano, female vocal", negativePrompt: "heavy drums" },
    model,
  );

  assert.deepEqual(result, { candidates: [{ providerId: "clip-1", data: "https://cdn.example/vocal.mp3" }] });
  assert.equal(runtime.calls[0].url, "https://api.4022543.xyz/suno/submit/music");
  assert.equal(runtime.calls[0].options.headers.Authorization, "Bearer music-key");
  assert.deepEqual(runtime.calls[0].body, {
    custom_mode: 1,
    make_instrumental: 0,
    prompt: "[Verse]\nA quiet room",
    mv: "chirp-fenix",
    title: "Quiet Room",
    tags: "piano, female vocal",
    negative_tags: "heavy drums",
  });
  assert.equal(runtime.calls[1].url, "https://api.4022543.xyz/suno/fetch/task-vocal");
});

test("best music sends instrumental mode with the generic key fallback", async () => {
  const runtime = loadVendor([{ data: [{ task_id: "task-instrumental" }] }, { data: { status: "SUCCESS", data: [{ clip_id: "clip-2", audio_url: "https://cdn.example/score.mp3" }] } }]);
  const model = runtime.exports.vendor.models.find((item: any) => item.modelName === "chirp-fenix");
  const result = await runtime.exports.musicRequest(
    { vocalMode: "instrumental", prompt: "restrained piano and cello score", title: "Debt Pulse", tags: "cinematic score, piano, cello" },
    model,
  );

  assert.equal(runtime.calls[0].options.headers.Authorization, "Bearer test-key");
  assert.equal(runtime.calls[0].body.custom_mode, 0);
  assert.equal(runtime.calls[0].body.make_instrumental, 1);
  assert.equal(runtime.calls[0].body.prompt, "restrained piano and cello score");
  assert.deepEqual(result, { candidates: [{ providerId: "clip-2", data: "https://cdn.example/score.mp3" }] });
});

test("best music rejects unsupported inputs and provider failures without exposing request data", async () => {
  const runtime = loadVendor([{ data: "task-failed" }, { data: { status: "FAILURE", fail_reason: "provider rejected request" } }]);
  const model = runtime.exports.vendor.models.find((item: any) => item.modelName === "chirp-fenix");
  await assert.rejects(
    () => runtime.exports.musicRequest({ vocalMode: "instrumental", prompt: "piano", tags: "piano", referenceList: [{ type: "audio" }] }, model),
    /不支持参考音频/,
  );
  await assert.rejects(
    () => runtime.exports.musicRequest({ vocalMode: "instrumental", prompt: "piano", tags: "piano" }, model),
    /provider rejected request/,
  );
});
