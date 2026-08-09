import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { transform } from "sucrase";
import { VM } from "vm2";
import {
  ZEALMAN_U06_LIGHT2V_MODEL_KEY,
  ZEALMAN_U06_MODEL_KEY,
  ZEALMAN_WORKFLOWS,
  assertZealmanExecutionPrompt,
  buildZealmanExecutionTemplate,
  deriveZealmanQualityParameterDefinitions,
  inspectZealmanWorkflow,
  inspectZealmanAvailability,
  inspectZealmanPendingTask,
  parseZealmanInstanceUrls,
  pollZealmanVideo,
  resolveZealmanQualityBindings,
  submitZealmanVideo,
  listZealmanWorkflowExecutionParameters,
  type WorkflowTemplate,
} from "../src/services/zealmanVideo";

const imageNodes = ["137", "139", "144", "151", "653", "654", "655", "656", "657"];
const videoNodes = ["638", "659", "660"];
const audioNodes = ["143", "661", "662"];

function template(): WorkflowTemplate {
  const input: Record<string, any> = {
    prompt: ["664", 0], model: ["620", 0], width: ["665", 1], height: ["665", 2], length: ["132", 0], clip: ["128", 0], vae: ["119", 0], audio_vae: ["120", 0], ref_image_size: "max",
  };
  imageNodes.forEach((node, index) => { input[`ref_images.ref_image_${index}`] = [node, 0]; });
  videoNodes.forEach((node, index) => { input[`ref_videos.ref_video_${index}`] = [node, 0]; });
  audioNodes.forEach((node, index) => { input[`ref_audios.ref_audio_${index}`] = [node, 0]; });
  return {
    "119": { class_type: "VAELoader", inputs: {} }, "120": { class_type: "VAELoader", inputs: {} },
    "128": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" } },
    "620": { class_type: "UNETLoader", inputs: { unet_name: "minimax/minimax_h3_ref2va_pruned_int8_convrot.safetensors", weight_dtype: "default" } },
    "124": { class_type: "BasicScheduler", inputs: { steps: 8, model: ["620", 0] } },
    "132": { class_type: "PrimitiveFloat", _meta: { title: "Video Duration" }, inputs: { value: 10 } },
    "136": { class_type: "MiniMaxH3ReferenceToVideo", inputs: input },
    "664": { class_type: "CR Prompt Text", inputs: { prompt: "sample prompt" } },
    "665": { class_type: "WJILatentPreset", inputs: { "自定义宽": 1344, "自定义高": 768 } },
    "668": { class_type: "RTXVideoSuperResolution", inputs: { "resize_type.scale": 2, images: ["136", 0] } },
    "647": { class_type: "VRAMCleanup", inputs: { anything: ["668", 0] } },
    ...Object.fromEntries(imageNodes.map((node, index) => [node, { class_type: "LoadImage", inputs: { image: `sample-${index}.jpg` } }])),
    ...Object.fromEntries(videoNodes.map((node, index) => [node, { class_type: "VHS_LoadVideo", inputs: { video: `sample-${index}.mp4` } }])),
    ...Object.fromEntries(audioNodes.map((node, index) => [node, { class_type: "LoadAudioUI", inputs: { audio: `sample-${index}.wav` } }])),
  };
}

const baseInput = (references: any[]) => ({ prompt: "A clean motion graphic based only on @Image1.", duration: 4, aspectRatio: "16:9", resolution: "768P", references });

const qualityDefinitions = () => ({
  baseModel: { options: ["minimax/minimax_h3_ref2va_pruned_int8_convrot.safetensors", "minimax/minimax_h3_ref2va_bf16.safetensors"] },
  textEncoder: { options: ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "qwen3vl_32b_minimax_h3_bf16.safetensors"] },
});

const executionOverrides = {
  baseModel: "minimax/minimax_h3_ref2va_bf16.safetensors",
  textEncoder: "qwen3vl_32b_minimax_h3_bf16.safetensors",
  steps: 12,
  superResolution: true,
};

test("Zealman vendor exposes U06 and Light2v as separate models", () => {
  const code = fs.readFileSync(path.join(process.cwd(), "data/vendor/zealman.ts"), "utf8");
  const exports: Record<string, any> = {};
  new VM({ sandbox: { exports }, timeout: 1_000, eval: false, wasm: false }).run(transform(code, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, ""));
  assert.deepEqual(exports.vendor.models.map((item: any) => item.modelName), ["minimax-h3-u06", "minimax-h3-u06-light2v"]);
  assert.deepEqual(exports.vendor.models[1].mode, [["imageReference:9", "videoReference:3", "audioReference:3"]]);
  assert.equal(exports.vendor.version, "2.3");
  assert.equal(exports.vendor.inputs.find((item: any) => item.key === "instanceUrls")?.type, "textarea");
});

test("temporary execution graph keeps only selected references", () => {
  const input = baseInput([{ type: "image", filePath: "one" }, { type: "image", filePath: "two" }, { type: "video", filePath: "motion" }, { type: "audio", filePath: "voice" }]);
  const built = buildZealmanExecutionTemplate(template(), ZEALMAN_U06_MODEL_KEY, input, { one: "one.png", two: "two.png", motion: "motion.mp4", voice: "voice.wav" });
  const h3 = built.workflowTemplate["136"].inputs!;
  assert.deepEqual(h3["ref_images.ref_image_0"], ["137", 0]);
  assert.deepEqual(h3["ref_images.ref_image_1"], ["139", 0]);
  assert.equal(h3["ref_images.ref_image_2"], undefined);
  assert.deepEqual(h3["ref_videos.ref_video_0"], ["638", 0]);
  assert.equal(h3["ref_videos.ref_video_1"], undefined);
  assert.deepEqual(h3["ref_audios.ref_audio_0"], ["143", 0]);
  assert.equal(h3["ref_audios.ref_audio_1"], undefined);
  assert.equal(built.workflowTemplate["137"].inputs!.image, "one.png");
  assert.equal(built.workflowTemplate["139"].inputs!.image, "two.png");
  assert.equal(built.workflowTemplate["664"].inputs!.prompt, input.prompt);
  assert.equal(built.workflowTemplate["132"].inputs!.value, 4);
  assert.equal(built.workflowTemplate["620"].inputs!.unet_name, "minimax/minimax_h3_ref2va_pruned_int8_convrot.safetensors");
  assert.equal(built.workflowTemplate["128"].inputs!.clip_name, "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors");
  assert.equal(built.workflowTemplate["620"].inputs!.weight_dtype, "default");
  assertZealmanExecutionPrompt(built.workflowTemplate, built.contract);
});

test("all media slots remain available when all 9/3/3 references are selected", () => {
  const references = [
    ...Array.from({ length: 9 }, (_, index) => ({ type: "image" as const, filePath: `i-${index}` })),
    ...Array.from({ length: 3 }, (_, index) => ({ type: "video" as const, filePath: `v-${index}` })),
    ...Array.from({ length: 3 }, (_, index) => ({ type: "audio" as const, filePath: `a-${index}` })),
  ];
  const uploaded = Object.fromEntries(references.map((item) => [item.filePath, `${item.filePath}.upload`]));
  const built = buildZealmanExecutionTemplate(template(), ZEALMAN_U06_LIGHT2V_MODEL_KEY, baseInput(references), uploaded);
  const h3Fields = Object.keys(built.workflowTemplate["136"].inputs!).filter((key) => key.startsWith("ref_"));
  assert.equal(h3Fields.length, 16); // 9 images + 3 videos + 3 audios + ref_image_size
});

test("workflow inspection accepts sample defaults but fingerprints the execution structure", () => {
  const first = inspectZealmanWorkflow(template(), ZEALMAN_U06_MODEL_KEY);
  const changed = template();
  changed["139"].inputs!.image = "different-sample.jpg";
  const second = inspectZealmanWorkflow(changed, ZEALMAN_U06_MODEL_KEY);
  assert.equal(first.workflowHash, second.workflowHash);
});

test("workflow compatibility ignores the four configured quality values", () => {
  const changed = template();
  changed["620"].inputs!.unet_name = "minimax/minimax_h3_ref2va_pruned_fp8_scaled.safetensors";
  changed["128"].inputs!.clip_name = "qwen3vl_32b_minimax_h3_int8_convrot.safetensors";
  changed["124"].inputs!.steps = 20;
  changed["668"].inputs!["resize_type.scale"] = 3;
  const first = inspectZealmanWorkflow(template(), ZEALMAN_U06_MODEL_KEY);
  const second = inspectZealmanWorkflow(changed, ZEALMAN_U06_MODEL_KEY);
  assert.equal(first.workflowHash, second.workflowHash);
});

test("only the four main-chain quality parameters are configurable", () => {
  const parameters = listZealmanWorkflowExecutionParameters(template(), ZEALMAN_U06_MODEL_KEY, qualityDefinitions());
  assert.deepEqual(parameters.map((item) => item.key), ["baseModel", "textEncoder", "steps", "superResolution"]);
  assert.equal(parameters.find((item) => item.key === "baseModel")?.label, "底模");
  assert.equal(parameters.find((item) => item.key === "baseModel")?.ui, "select");
  assert.equal(parameters.find((item) => item.key === "steps")?.ui, "number");
  assert.equal(parameters.find((item) => item.key === "superResolution")?.ui, "toggle");
});

test("model selections are discovered from the selected instance model scan", () => {
  const definitions = deriveZealmanQualityParameterDefinitions(template(), {
    downloaded: [
      "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
      "minimax_h3_ref2va_bf16.safetensors",
      "minimax_h3_fl2va_bf16.safetensors",
      "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      "qwen3vl_32b_minimax_h3_bf16.safetensors",
      "qwen3vl_8b_bf16.safetensors",
    ],
  });
  assert.deepEqual(definitions.baseModel?.options, [
    "minimax/minimax_h3_ref2va_bf16.safetensors",
    "minimax/minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  ]);
  assert.deepEqual(definitions.textEncoder?.options, [
    "qwen3vl_32b_minimax_h3_bf16.safetensors",
    "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  ]);
});

test("RIFE is never exposed as a substitute for the optional RTX super-resolution node", () => {
  const light2v = template();
  delete light2v["668"];
  light2v["147"] = { class_type: "RIFEInterpolation", inputs: { scale: 2, images: ["136", 0] } };
  assert.throws(() => resolveZealmanQualityBindings(light2v), /final RTX video super-resolution node/);
});

test("disabling RTX super-resolution follows the quick-panel bypass contract", () => {
  const built = buildZealmanExecutionTemplate(
    template(),
    ZEALMAN_U06_LIGHT2V_MODEL_KEY,
    baseInput([{ type: "image", filePath: "one" }]),
    { one: "one.png" },
    { superResolution: false },
    qualityDefinitions(),
  );
  assert.equal(built.workflowTemplate["668"], undefined);
  assert.deepEqual(built.workflowTemplate["647"].inputs!.anything, ["136", 0]);
  assertZealmanExecutionPrompt(built.workflowTemplate, built.contract);
});

test("execution overrides require a currently discovered quality parameter", () => {
  assert.throws(
    () => buildZealmanExecutionTemplate(template(), ZEALMAN_U06_MODEL_KEY, baseInput([{ type: "image", filePath: "one" }]), { one: "one.png" }, { baseModel: "x" }, qualityDefinitions()),
    /does not offer selected/,
  );
});

test("submission sends workflow_template and rejects a rewritten response graph", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-zealman-"));
  const image = path.join(dir, "first.png");
  fs.writeFileSync(image, "image");
  const calls: Array<{ url: string; body?: any }> = [];
  const source = template();
  const configured = structuredClone(source);
  delete configured["668"];
  configured["647"].inputs!.anything = ["136", 0];
  const client = {
    get: async (url: string) => {
      calls.push({ url });
      if (url.endsWith("/api/models/scan")) return { data: { downloaded: ["minimax_h3_ref2va_pruned_int8_convrot.safetensors", "minimax_h3_ref2va_bf16.safetensors", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "qwen3vl_32b_minimax_h3_bf16.safetensors"] } };
      if (url.includes("/api/workflow/config/")) return { data: { workflow_template: configured } };
      if (url.endsWith(".json")) return { data: source };
      throw new Error(`Unexpected Zealman GET ${url}`);
    },
    post: async (url: string, body: any) => {
      calls.push({ url, body });
      if (url.endsWith("/upload/file")) return { data: { name: "uploads/first.png" } };
      return { data: { prompt_id: "prompt-42", prompt: body.workflow_template } };
    },
  };
  try {
    const submitted = await submitZealmanVideo("https://node.example:8443", ZEALMAN_U06_MODEL_KEY, baseInput([{ type: "image", filePath: image }]), client, executionOverrides);
    assert.equal(submitted.promptId, "prompt-42");
    const generate = calls.find((call) => call.url.endsWith("/generate"))!;
    assert.ok(generate.body.workflow_template);
    assert.equal(generate.body.workflow_id, undefined);
    assert.equal(generate.body.workflow_template["136"].inputs["ref_images.ref_image_1"], undefined);
    assert.equal(generate.body.workflow_template["137"].inputs.image, "uploads/first.png");
    assert.equal(generate.body.workflow_template["620"].inputs.unet_name, executionOverrides.baseModel);
    assert.equal(generate.body.workflow_template["128"].inputs.clip_name, executionOverrides.textEncoder);
    assert.equal(generate.body.workflow_template["124"].inputs.steps, executionOverrides.steps);
    assert.ok(generate.body.workflow_template["668"]);
    const rewritten = structuredClone(generate.body.workflow_template);
    rewritten["136"].inputs["ref_images.ref_image_1"] = ["139", 0];
    assert.throws(() => assertZealmanExecutionPrompt(rewritten, buildZealmanExecutionTemplate(source, ZEALMAN_U06_MODEL_KEY, baseInput([{ type: "image", filePath: image }]), { [image]: "uploads/first.png" }, executionOverrides, qualityDefinitions()).contract), /retained unused reference/);
    delete rewritten["136"].inputs["ref_images.ref_image_1"];
    rewritten["620"].inputs.unet_name = "minimax/minimax_h3_ref2va_pruned_int8_convrot.safetensors";
    assert.throws(() => assertZealmanExecutionPrompt(rewritten, buildZealmanExecutionTemplate(source, ZEALMAN_U06_MODEL_KEY, baseInput([{ type: "image", filePath: image }]), { [image]: "uploads/first.png" }, executionOverrides, qualityDefinitions()).contract), /configured execution parameter/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("instance URL parsing de-duplicates normalized addresses", () => {
  assert.deepEqual(parseZealmanInstanceUrls("https://one.example:8443/\nhttps://one.example:8443\nhttps://two.example:8443/"), ["https://one.example:8443", "https://two.example:8443"]);
  assert.equal(ZEALMAN_WORKFLOWS[ZEALMAN_U06_LIGHT2V_MODEL_KEY].workflowId.includes("light2v"), true);
});

test("poll returns every downloadable MP4 even when Zealman labels SaveVideo output as image", async () => {
  const response = {
    success: true,
    pending: false,
    results: [
      { type: "image", url: "/output/comfyui_00041_.png", raw: { filename: "comfyui_00041_.png" } },
      { type: "image", url: "/output/comfyui_00041_.mp4", raw: { filename: "comfyui_00041_.mp4" } },
      { type: "image", url: "/output/comfyui_00041_-audio.mp4", raw: { filename: "comfyui_00041_-audio.mp4" } },
    ],
  };
  const client = {
    get: async () => ({
      data: response,
    }),
  };
  const result = await pollZealmanVideo("https://node.example:8443", "prompt-43", { audio: true }, client);
  assert.equal(result.state, "success");
  if (result.state !== "success") throw new Error("Expected success");
  assert.deepEqual(result.urls, [
    "https://node.example:8443/output/comfyui_00041_.mp4",
    "https://node.example:8443/output/comfyui_00041_-audio.mp4",
  ]);
});

test("poll accepts a muxed MP4 whose filename has no audio suffix", async () => {
  const result = await pollZealmanVideo("https://node.example:8443", "prompt-44", { audio: true }, {
    get: async () => ({ data: { success: true, pending: false, results: [
      { type: "image", url: "/output/comfyui_00044_.mp4", raw: { filename: "comfyui_00044_.mp4" } },
    ] } }),
  });
  assert.equal(result.state, "success");
  if (result.state !== "success") throw new Error("Expected success");
  assert.deepEqual(result.urls, ["https://node.example:8443/output/comfyui_00044_.mp4"]);
});

test("pending-task probe distinguishes an idle ComfyUI with lost history from an active task", async () => {
  const idle = await inspectZealmanPendingTask("https://node.example:8443", "prompt-lost", {
    get: async (url: string) => url.includes("queue-status")
      ? { data: { busy: false, running_count: 0, pending_count: 0 } }
      : { data: {} },
  });
  assert.deepEqual(idle, {
    queueIdle: true,
    historyHasPrompt: false,
    rawOutput: JSON.stringify({ zealmanPendingProbe: { promptId: "prompt-lost", queue: { busy: false, running_count: 0, pending_count: 0 }, historyHasPrompt: false } }),
  });

  const active = await inspectZealmanPendingTask("https://node.example:8443", "prompt-live", {
    get: async (url: string) => url.includes("queue-status")
      ? { data: { busy: true, running_count: 1, pending_count: 0 } }
      : { data: { "prompt-live": { outputs: {} } } },
  });
  assert.equal(active.queueIdle, false);
  assert.equal(active.historyHasPrompt, true);
});

test("pending-task probe propagates transport errors instead of declaring a lost task", async () => {
  await assert.rejects(
    inspectZealmanPendingTask("https://node.example:8443", "prompt-live", {
      get: async () => { throw new Error("network unavailable"); },
    }),
    /network unavailable/,
  );
});

test("availability requires explicit unavailability or both probes to be unreachable", async () => {
  const oneProbeAlive = await inspectZealmanAvailability("https://node.example:8443", {
    get: async (url: string) => {
      if (url.endsWith("/api/health")) throw new Error("health timeout");
      return { data: { running: true, status: "running" } };
    },
  });
  assert.equal(oneProbeAlive.unavailable, false);

  const explicitlyStopped = await inspectZealmanAvailability("https://node.example:8443", {
    get: async (url: string) => url.endsWith("/api/health")
      ? { data: { status: "ok" } }
      : { data: { running: false, status: "stopped" } },
  });
  assert.equal(explicitlyStopped.unavailable, true);

  const bothUnreachable = await inspectZealmanAvailability("https://node.example:8443", {
    get: async () => { throw new Error("instance powered off"); },
  });
  assert.equal(bothUnreachable.unavailable, true);
  assert.equal(bothUnreachable.healthReachable, false);
  assert.equal(bothUnreachable.comfyReachable, false);
});
