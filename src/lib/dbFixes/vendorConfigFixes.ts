import fs from "fs";
import path from "path";
import { transform } from "sucrase";
import { VM } from "vm2";
import type { Knex } from "knex";
import rawVendorData from "@/lib/vendor.json";
import getPath from "@/utils/getPath";

const vendorData = rawVendorData as Record<string, string>;
const BEST_MUSIC_UPGRADE_MARKER = "/* toonflow-best-suno-v55 */";
const BEST_MUSIC_DURATION_UPGRADE_MARKER = "/* toonflow-best-suno-v55-duration-parameter */";
const BEST_MUSIC_PROTOCOL_UPGRADE_MARKER = "/* toonflow-best-suno-v55-protocol-v2 */";
const BEST_MUSIC_DISABLED_MARKER = "/* toonflow-best-suno-v55-disabled */";

export function upgradeBestMusicVendorCode(code: string) {
  if (!/\bid\s*:\s*["']best["']/.test(code) || !/exports\.vendor\s*=\s*vendor/.test(code)) {
    return code;
  }

  if (!code.includes(BEST_MUSIC_UPGRADE_MARKER)) return upgradeBestMusicVendorCode(`${code}\n\n${BEST_MUSIC_UPGRADE_MARKER}
if (!vendor.inputs.some((item: any) => item.key === "musicKey")) {
  vendor.inputs.push({ key: "musicKey", label: "音乐 API 密钥", type: "password", required: false, placeholder: "不填则使用 API 密钥" });
}
if (!vendor.models.some((item: any) => item.type === "music" && item.modelName === "chirp-fenix")) {
  vendor.models.push({
    name: "Suno V5.5",
    modelName: "chirp-fenix",
    type: "music",
    durationControl: "targetOnly",
    outputFormats: ["mp3"],
    vocal: "optional",
    lyrics: "optional",
    referenceAudio: false,
    loop: false,
  });
}
const bestMusicChars = (value: any) => Array.from(String(value || "")).length;
const bestMusicKey = () => String(vendor.inputValues.musicKey || vendor.inputValues.apiKey || "").trim().replace(/^Bearer\\s+/i, "");
const bestMusicHeaders = () => {
  const key = bestMusicKey();
  if (!key) throw new Error("请到 api.4022543.xyz 获取音乐 API Key");
  return { Authorization: \`Bearer \${key}\`, "Content-Type": "application/json", Accept: "application/json" };
};
const bestMusicTracks = (payload: any) => {
  const values = [payload?.data?.data, payload?.data?.tracks, payload?.data?.clips, payload?.data, payload?.tracks, payload?.clips, payload];
  const rows = values.find((value) => Array.isArray(value)) || [];
  return rows
    .filter((item: any) => item && typeof item === "object" && item.audio_url)
    .map((item: any) => ({ providerId: String(item.clip_id || item.id || item.audio_id || "") || undefined, data: String(item.audio_url) }));
};
const bestMusicTaskIds = (payload: any): string[] => {
  if (typeof payload === "string") return payload ? [payload] : [];
  if (Array.isArray(payload)) return payload.flatMap(bestMusicTaskIds);
  if (!payload || typeof payload !== "object") return [];
  const id = payload.task_id || payload.taskId;
  if (typeof id === "string" && id) return [id];
  return bestMusicTaskIds(payload.data);
};
const bestMusicStatus = (payload: any) => String(payload?.data?.status || payload?.status || payload?.data?.state || payload?.state || "").toUpperCase();
const bestMusicFailure = (payload: any) => String(payload?.data?.fail_reason || payload?.data?.failReason || payload?.fail_reason || payload?.failReason || payload?.message || "音乐生成失败");
const musicRequest = async (config: any, model: any) => {
  const vocalMode = String(config?.vocalMode || "").trim();
  const lyrics = String(config?.lyrics || "").trim();
  const prompt = String(config?.prompt || "").trim();
  const tags = String(config?.tags || "").trim();
  const title = String(config?.title || "Toonflow Music").trim().slice(0, 200);
  if (vocalMode !== "vocal" && vocalMode !== "instrumental") throw new Error("音乐生成需要明确的 vocalMode：vocal 或 instrumental");
  if (!tags) throw new Error("音乐生成需要模型编译出的 tags");
  if (bestMusicChars(tags) > 120) throw new Error("Suno tags 不能超过 120 个字符");
  if (Array.isArray(config?.referenceList) && config.referenceList.length) throw new Error("当前 Suno 模型不支持参考音频");
  if (config?.loop === true) throw new Error("当前 Suno 模型不支持循环生成");
  if (Number(config?.durationSec || 0) > 480) throw new Error("当前 Suno 模型的目标时长不能超过 480 秒");
  const body: any = {
    custom_mode: vocalMode === "vocal",
    make_instrumental: vocalMode === "instrumental",
    prompt: vocalMode === "vocal" ? lyrics : prompt,
    mv: model.modelName,
    title,
    tags,
    negative_tags: String(config?.negativePrompt || "").trim(),
  };
  if (vocalMode === "vocal") {
    if (!lyrics) throw new Error("人声音乐需要已确认的歌词");
    if (bestMusicChars(lyrics) > 3000) throw new Error("Suno 歌词不能超过 3000 个字符");
  } else {
    if (!prompt) throw new Error("纯音乐需要已编译的音乐描述");
    if (bestMusicChars(prompt) > 200) throw new Error("Suno 纯音乐描述不能超过 200 个字符");
  }
  const submitted = await axios.post(\`\${getBaseUrl()}/suno/submit/music\`, body, { headers: bestMusicHeaders() });
  const immediate = bestMusicTracks(submitted.data);
  if (immediate.length) return { candidates: immediate };
  const taskIds = [...new Set(bestMusicTaskIds(submitted.data))];
  if (!taskIds.length) throw new Error("Suno 音乐提交未返回任务 ID");
  logger("[best music] Suno task submitted");
  const resultGroups = await Promise.all(taskIds.map(async (taskId) => {
    const result = await pollTask(async () => {
      const response = await axios.get(\`\${getBaseUrl()}/suno/fetch/\${encodeURIComponent(taskId)}\`, { headers: bestMusicHeaders() });
      const status = bestMusicStatus(response.data);
      if (["FAILURE", "FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(status)) return { completed: true, error: bestMusicFailure(response.data) };
      const tracks = bestMusicTracks(response.data);
      if (["SUCCESS", "SUCCEEDED", "COMPLETED", "COMPLETE", "DONE"].includes(status)) {
        return tracks.length ? { completed: true, data: tracks } : { completed: true, error: "Suno 任务完成但未返回可下载音频" };
      }
      return { completed: false };
    }, 5000, 3000000);
    if (result.error) throw new Error(result.error);
    return Array.isArray(result.data) ? result.data : [];
  }));
  const candidates = resultGroups.flat();
  if (!candidates.length) throw new Error("Suno 任务未返回可下载音频");
  return { candidates };
};
exports.musicRequest = musicRequest;
`);
if (!code.includes(BEST_MUSIC_DURATION_UPGRADE_MARKER)) return upgradeBestMusicVendorCode(`${code}\n\n${BEST_MUSIC_DURATION_UPGRADE_MARKER}
const bestSunoV55Model = vendor.models.find((item: any) => item && item.type === "music" && item.modelName === "chirp-fenix");
if (bestSunoV55Model) bestSunoV55Model.durationParameter = false;
`);
  if (!code.includes(BEST_MUSIC_PROTOCOL_UPGRADE_MARKER)) return upgradeBestMusicVendorCode(`${code}\n\n${BEST_MUSIC_PROTOCOL_UPGRADE_MARKER}
const bestSunoV55ProtocolModel = vendor.models.find((item: any) => item && item.type === "music" && item.modelName === "chirp-fenix");
if (bestSunoV55ProtocolModel) {
  delete bestSunoV55ProtocolModel.inputLimits;
  delete bestSunoV55ProtocolModel.durationRange;
  bestSunoV55ProtocolModel.durationControl = "targetOnly";
  bestSunoV55ProtocolModel.durationParameter = false;
}
const bestMusicRequestCheck = (config: any, _model: any) => {
  const issues: Array<{ code: string; field?: string; message: string }> = [];
  const vocalMode = String(config?.vocalMode || "").trim();
  const lyrics = String(config?.lyrics || "").trim();
  const prompt = String(config?.prompt || "").trim();
  const tags = String(config?.tags || "").trim();
  const outputFormat = String(config?.outputFormat || config?.format || "mp3").trim().toLowerCase();
  if (vocalMode !== "vocal" && vocalMode !== "instrumental") issues.push({ code: "vocal_mode_required", field: "vocalMode", message: "Best Suno requires vocalMode to be instrumental or vocal." });
  if (!tags) issues.push({ code: "tags_required", field: "tags", message: "Best Suno requires music tags." });
  if (vocalMode === "vocal" && !lyrics) issues.push({ code: "lyrics_required", field: "lyrics", message: "Best Suno vocal generation requires confirmed lyrics." });
  if (vocalMode === "instrumental" && !prompt) issues.push({ code: "instrumental_prompt_required", field: "prompt", message: "Best Suno instrumental generation requires a music prompt." });
  if (Array.isArray(config?.referenceList) && config.referenceList.length) issues.push({ code: "reference_audio_unsupported", field: "referenceList", message: "Best Suno chirp-fenix does not support reference audio in this adapter." });
  if (config?.loop === true) issues.push({ code: "loop_unsupported", field: "loop", message: "Best Suno chirp-fenix does not support loop generation in this adapter." });
  if (outputFormat && outputFormat !== "mp3") issues.push({ code: "output_format_unsupported", field: "outputFormat", message: "Best Suno chirp-fenix returns MP3 audio only." });
  return { issues };
};
const bestMusicRequestV2 = async (config: any, model: any) => {
  const contract = bestMusicRequestCheck(config, model);
  if (contract.issues.length) throw new Error(contract.issues.map((issue: any) => issue.message).join("; "));
  const vocalMode = String(config?.vocalMode || "").trim();
  const body: any = {
    custom_mode: vocalMode === "vocal",
    make_instrumental: vocalMode === "instrumental",
    prompt: vocalMode === "vocal" ? String(config?.lyrics || "").trim() : String(config?.prompt || "").trim(),
    mv: model.modelName,
    title: String(config?.title || "Toonflow Music").trim().slice(0, 200),
    tags: String(config?.tags || "").trim(),
    negative_tags: String(config?.negativePrompt || "").trim(),
  };
  const submitted = await axios.post(\`\${getBaseUrl()}/suno/submit/music\`, body, { headers: bestMusicHeaders() });
  const immediate = bestMusicTracks(submitted.data);
  if (immediate.length) return { candidates: immediate };
  const taskIds = [...new Set(bestMusicTaskIds(submitted.data))];
  if (!taskIds.length) throw new Error("Best Suno response has no task ID");
  const resultGroups = await Promise.all(taskIds.map(async (taskId) => {
    const result = await pollTask(async () => {
      const response = await axios.get(\`\${getBaseUrl()}/suno/fetch/\${encodeURIComponent(taskId)}\`, { headers: bestMusicHeaders() });
      const status = bestMusicStatus(response.data);
      if (["FAILURE", "FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(status)) return { completed: true, error: bestMusicFailure(response.data) };
      const tracks = bestMusicTracks(response.data);
      if (["SUCCESS", "SUCCEEDED", "COMPLETED", "COMPLETE", "DONE"].includes(status)) return tracks.length ? { completed: true, data: tracks } : { completed: true, error: "Best Suno completed without downloadable audio" };
      return { completed: false };
    }, 5000, 3000000);
    if (result.error) throw new Error(result.error);
    return Array.isArray(result.data) ? result.data : [];
  }));
  const candidates = resultGroups.flat();
  if (!candidates.length) throw new Error("Best Suno completed without downloadable audio");
  return { candidates };
};
exports.musicRequestCheck = bestMusicRequestCheck;
exports.musicRequest = bestMusicRequestV2;
`);
  if (!code.includes(BEST_MUSIC_DISABLED_MARKER)) return `${code}\n\n${BEST_MUSIC_DISABLED_MARKER}
vendor.models = vendor.models.filter((item: any) => !(item && item.type === "music" && item.modelName === "chirp-fenix"));
`;
  return code;
}

async function upgradeInstalledBestMusicVendor(knex: Knex) {
  if (!(await knex.schema.hasTable("o_vendorConfig")) || !(await knex("o_vendorConfig").where("id", "best").first())) return;
  const file = getVendorFile("best");
  if (!fs.existsSync(file)) return;
  const code = fs.readFileSync(file, "utf8");
  const upgraded = upgradeBestMusicVendorCode(code);
  if (upgraded !== code) fs.writeFileSync(file, upgraded);
  const upgradedVendor = readVendorFromCode(upgraded);
  const musicModel = upgradedVendor?.models?.find((item: any) => item?.type === "music" && item?.modelName === "chirp-fenix");
  const stored = await knex("o_vendorConfig").where("id", "best").first();
  let storedModels: any[] = [];
  try {
    const parsed = JSON.parse(stored?.models || "[]");
    if (Array.isArray(parsed)) storedModels = parsed;
  } catch {
    storedModels = [];
  }
  const retainedModels = storedModels.filter((item) => !(item?.type === "music" && item?.modelName === "chirp-fenix"));
  const mergedModels = musicModel ? [...retainedModels, musicModel] : retainedModels;
  if (JSON.stringify(storedModels) !== JSON.stringify(mergedModels)) {
    await knex("o_vendorConfig").where("id", "best").update({ models: JSON.stringify(mergedModels) });
  }
}

function getVendorFile(id: string | number) {
  return path.join(getPath("vendor"), `${id}.ts`);
}

function writeVendorCode(id: string | number, tsCode: string) {
  const rootDir = getPath("vendor");
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(getVendorFile(id), tsCode);
}

function getVendorVersion(id: string) {
  const file = getVendorFile(id);
  if (!fs.existsSync(file)) return "0";
  const code = fs.readFileSync(file, "utf8");
  return code.match(/\bversion\s*:\s*["']([^"']+)["']/)?.[1] || "0";
}

function compareVersion(a?: string | number, b?: string | number) {
  const left = String(a ?? "0").split(/[^\d]+/).map((item) => Number(item) || 0);
  const right = String(b ?? "0").split(/[^\d]+/).map((item) => Number(item) || 0);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function readVendorFromCode(tsCode: string) {
  const jsCode = transform(tsCode, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
  const exports: Record<string, any> = {};
  new VM({
    sandbox: {
      exports,
      logger: () => {},
      fetch: async () => {
        throw new Error("fixDB vendor metadata sandbox does not allow fetch");
      },
    },
    timeout: 1000,
    eval: false,
    wasm: false,
  }).run(jsCode);
  return exports.vendor;
}

export async function syncDefaultVendorConfigs(knex: Knex) {
  if (!(await knex.schema.hasTable("o_vendorConfig"))) return;

  for (const [filename, tsCode] of Object.entries(vendorData)) {
    if (!filename.endsWith(".ts") || !tsCode) continue;
    const vendor = readVendorFromCode(tsCode);
    const id = vendor?.id || filename.replace(/\.ts$/, "");
    const currentVersion = getVendorVersion(id);
    const existing = await knex("o_vendorConfig").where("id", id).first();
    const defaultModelList = Array.isArray(vendor?.models) ? vendor.models : [];
    const defaultModels = JSON.stringify(defaultModelList);
    const shouldUpdateCode = compareVersion(vendor?.version, currentVersion) > 0;
    const shouldUpdateModels = defaultModelList.length > 0 && existing?.models !== defaultModels;

    if (!existing) {
      await knex("o_vendorConfig").insert({
        id,
        inputValues: JSON.stringify(vendor?.inputValues ?? {}),
        models: defaultModels,
        enable: id == "toonflow" ? 1 : 0,
      });
      writeVendorCode(id, tsCode);
      continue;
    }

    if (!shouldUpdateCode && !shouldUpdateModels) continue;
    writeVendorCode(id, tsCode);
    if (shouldUpdateModels) {
      await knex("o_vendorConfig").where("id", id).update({ models: defaultModels });
    }
  }
}

export async function materializeVendorCodeFiles(knex: Knex) {
  if (!(await knex.schema.hasTable("o_vendorConfig"))) return;
  const rows = await knex("o_vendorConfig").select("*");
  for (const item of rows) {
    let { id, code } = item;
    const filename = `${id}.ts`;
    const rootDir = getPath("vendor");
    if (!code && fs.existsSync(path.join(rootDir, filename))) continue;
    if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
    if (!fs.existsSync(path.join(rootDir, filename))) {
      code = vendorData[filename] || code;
      code = code ?? "";
      fs.writeFileSync(path.join(rootDir, filename), code);
    }
  }
}

async function ensureDefaultMusicPromptBindings(knex: Knex) {
  if (!(await knex.schema.hasTable("o_modelPrompt"))) return;
  const bindings = [{ vendorId: "t8star", model: "chirp-fenix", fileName: "suno-v55.md", path: "music/suno-v55.md" }];
  for (const binding of bindings) {
    const existing = await knex("o_modelPrompt").where({ vendorId: binding.vendorId, model: binding.model }).first();
    if (!existing) {
      await knex("o_modelPrompt").insert(binding);
    } else if (binding.vendorId === "t8star" && existing.fileName === "t8star-suno-v55.md" && existing.path === "music/t8star-suno-v55.md") {
      await knex("o_modelPrompt").where({ vendorId: binding.vendorId, model: binding.model }).update(binding);
    }
  }
}

export async function insertDefaultVendorIfMissing(knex: Knex, tsCode: string) {
  if (!(await knex.schema.hasTable("o_vendorConfig"))) return;
  const vendor = readVendorFromCode(tsCode);
  if (!vendor?.id) return;
  const data = await knex("o_vendorConfig").where("id", vendor.id).first();
  if (data) return;
  await knex("o_vendorConfig").insert({
    id: vendor.id,
    inputValues: JSON.stringify(vendor.inputValues ?? {}),
    models: JSON.stringify(vendor.models ?? []),
    enable: vendor.id == "toonflow" ? 1 : 0,
  });
  writeVendorCode(vendor.id, tsCode);
}

export async function fixVendorConfigs(knex: Knex) {
  await materializeVendorCodeFiles(knex);
  await upgradeInstalledBestMusicVendor(knex);
  await syncDefaultVendorConfigs(knex);
  await ensureDefaultMusicPromptBindings(knex);
}
