import fs from "node:fs/promises";
import path from "node:path";
import u from "@/utils";
import { readBuiltinDataFile } from "@/services/builtinData";
import { readConfiguredSkill } from "@/services/skillResolver";

export interface MusicModelProfile {
  available: boolean;
  content: string;
  source: string | null;
  modelTechnique: string | null;
  requiredGenerationConfig: string[];
}

export class MusicPromptConfigValidationError extends Error {
  readonly code = "MUSIC_PROMPT_CONFIG_INVALID";

  constructor(readonly missingRequiredConfigKeys: string[]) {
    super(`Music prompt generationConfig is missing required fields: ${missingRequiredConfigKeys.join(", ")}`);
    this.name = "MusicPromptConfigValidationError";
  }
}

function splitModel(model: string) {
  const [vendorId, modelName] = String(model || "").split(/:(.+)/);
  if (!vendorId || !modelName) throw new Error("Music model must be in vendor:modelName format");
  return { vendorId, modelName };
}

export function parseMusicModelProfile(content: string, source: string): MusicModelProfile {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { available: true, content, source, modelTechnique: null, requiredGenerationConfig: [] };
  const metadata = match[1].split(/\r?\n/);
  const modelTechnique = metadata
    .map((line) => line.match(/^\s*modelTechnique\s*:\s*(.+?)\s*$/)?.[1]?.trim())
    .find(Boolean) || null;
  const requiredGenerationConfig = metadata
    .map((line) => line.match(/^\s*requiredGenerationConfig\s*:\s*\[(.*?)\]\s*$/)?.[1] || "")
    .flatMap((value) => value.split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")))
    .filter(Boolean)
    .filter((value, index, items) => items.indexOf(value) === index);
  return {
    available: true,
    content: content.slice(match[0].length),
    source,
    modelTechnique,
    requiredGenerationConfig,
  };
}

export async function readMusicModelProfile(model: string): Promise<MusicModelProfile> {
  const { vendorId, modelName } = splitModel(model);
  const configured = await u.db("o_modelPrompt").where("vendorId", vendorId).where("model", modelName).first();
  if (configured?.path) {
    try {
      const file = path.join(u.getPath(["modelPrompt"]), configured.path);
      return parseMusicModelProfile(await fs.readFile(file, "utf8"), `o_modelPrompt:${configured.path}`);
    } catch {}
    const builtin = await readBuiltinDataFile("modelPrompt", ...String(configured.path).split(/[\\/]+/).filter(Boolean));
    if (builtin) return parseMusicModelProfile(builtin.content, `builtin:${configured.path}`);
  }
  return { available: false, content: "", source: null, modelTechnique: null, requiredGenerationConfig: [] };
}

export async function resolveMusicPromptProfile(model: string) {
  const profile = await readMusicModelProfile(model);
  if (!profile.available) throw new Error("No model-specific music prompt profile is configured for this model");
  return profile;
}

export async function readMusicModelTechnique(profile: MusicModelProfile) {
  if (!profile.modelTechnique) return null;
  return readConfiguredSkill(profile.modelTechnique);
}

function hasGenerationConfigValue(value: unknown) {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  return value != null;
}

export function missingMusicProfileGenerationConfig(profile: Pick<MusicModelProfile, "requiredGenerationConfig">, config: Record<string, unknown>) {
  return profile.requiredGenerationConfig.filter((key) => !hasGenerationConfigValue(config[key]));
}

export function assertMusicProfileGenerationConfig(profile: Pick<MusicModelProfile, "requiredGenerationConfig">, config: Record<string, unknown>) {
  const missing = missingMusicProfileGenerationConfig(profile, config);
  if (missing.length) throw new MusicPromptConfigValidationError(missing);
}
