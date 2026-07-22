import u from "@/utils";

export interface MusicModelCapabilities {
  model: string;
  name: string;
  durationRange: { min?: number; max?: number };
  durationControl?: "exact" | "targetOnly";
  outputFormats: string[];
  vocal?: "optional" | boolean;
  lyrics?: "optional" | boolean;
  referenceAudio?: "optional" | boolean;
  loop?: "optional" | boolean;
}

export type AvailableMusicModel = MusicModelCapabilities & {
  vendorId: string;
  modelName: string;
};

export function parseMusicModelKey(model: string) {
  const value = String(model || "").trim();
  const [vendorId, modelName] = value.split(/:(.+)/);
  if (!vendorId || !modelName) {
    throw new Error("Music model must use the exact vendor:modelName value from list_available_music_models; display names are not executable");
  }
  return { vendorId, modelName };
}

export async function resolveMusicModelCapabilities(model: string): Promise<MusicModelCapabilities> {
  const { vendorId, modelName } = parseMusicModelKey(model);
  const models = await u.vendor.getModelList(vendorId);
  const detail = models.find((item: any) => item.modelName === modelName && item.type === "music");
  if (!detail) throw new Error("Music model does not exist or is no longer available");
  return {
    model,
    name: detail.name || modelName,
    durationRange: {
      min: Number.isFinite(Number(detail.durationRange?.min)) ? Number(detail.durationRange.min) : undefined,
      max: Number.isFinite(Number(detail.durationRange?.max)) ? Number(detail.durationRange.max) : undefined,
    },
    durationControl: detail.durationControl === "targetOnly" ? "targetOnly" : "exact",
    outputFormats: Array.isArray(detail.outputFormats) ? detail.outputFormats.map(String) : [],
    vocal: detail.vocal,
    lyrics: detail.lyrics,
    referenceAudio: detail.referenceAudio,
    loop: detail.loop,
  };
}

export async function listAvailableMusicModels(): Promise<AvailableMusicModel[]> {
  const vendors = await u.db("o_vendorConfig").where({ enable: 1 }).select("id");
  const groups = await Promise.all(
    vendors.map(async (vendor: any) => {
      const vendorId = String(vendor.id || "");
      try {
        const models = await u.vendor.getModelList(vendorId);
        return models
          .filter((item: any) => item?.type === "music" && item?.modelName)
          .map((item: any): AvailableMusicModel => ({
            model: `${vendorId}:${item.modelName}`,
            vendorId,
            modelName: String(item.modelName),
            name: String(item.name || item.modelName),
            durationRange: {
              min: Number.isFinite(Number(item.durationRange?.min)) ? Number(item.durationRange.min) : undefined,
              max: Number.isFinite(Number(item.durationRange?.max)) ? Number(item.durationRange.max) : undefined,
            },
            durationControl: item.durationControl === "targetOnly" ? "targetOnly" : "exact",
            outputFormats: Array.isArray(item.outputFormats) ? item.outputFormats.map(String) : [],
            vocal: item.vocal,
            lyrics: item.lyrics,
            referenceAudio: item.referenceAudio,
            loop: item.loop,
          }));
      } catch {
        return [] as AvailableMusicModel[];
      }
    }),
  );
  return groups.flat().sort((left, right) => left.model.localeCompare(right.model));
}

export function resolveMusicGenerationDuration(input: {
  effectiveMusicDurationSec?: number | null;
  requestedDurationSec?: number | null;
  capabilities: Pick<MusicModelCapabilities, "durationRange"> & Partial<Pick<MusicModelCapabilities, "durationControl">>;
}) {
  const effective = Math.max(1, Math.ceil(Number(input.effectiveMusicDurationSec || input.requestedDurationSec || 30)));
  const min = Number(input.capabilities.durationRange.min || 0);
  const max = Number(input.capabilities.durationRange.max || 0);
  const durationControl: "exact" | "targetOnly" = input.capabilities.durationControl === "targetOnly" ? "targetOnly" : "exact";
  const requested = durationControl === "targetOnly"
    ? Math.max(effective, Math.ceil(Number(input.requestedDurationSec || effective)))
    : Math.max(effective, Math.ceil(Number(input.requestedDurationSec || effective)), min || 0);
  if (max > 0 && requested > max) {
    throw new Error(`建议用乐时长 ${effective} 秒超过当前音乐模型上限 ${max} 秒，请缩短、使用循环版本或拆分叙事段落。`);
  }
  return {
    effectiveMusicDurationSec: effective,
    generationDurationSec: requested,
    hasSilentTail: durationControl === "exact" && requested > effective,
    durationControl,
    durationRange: { min: min || undefined, max: max || undefined },
  };
}

export function assertMusicVocalCapability(
  capabilities: MusicModelCapabilities,
  input: { vocalMode?: string | null; lyrics?: string | null },
) {
  const wantsVocal = input.vocalMode === "vocal" || Boolean(String(input.lyrics || "").trim());
  if (!wantsVocal) return;
  if (capabilities.vocal === false) throw new Error("当前音乐模型不支持人声，请更换模型或改为纯音乐版本。");
  if (String(input.lyrics || "").trim() && capabilities.lyrics === false) {
    throw new Error("当前音乐模型不支持歌词输入，请更换模型。");
  }
}

export function validateMusicGenerationConfig(
  capabilities: MusicModelCapabilities,
  config: Record<string, unknown>,
  input: { vocalMode?: string | null; lyrics?: string | null },
) {
  assertMusicVocalCapability(capabilities, input);
  const duration = Number(config.durationSec ?? config.duration);
  if (!Number.isInteger(duration) || duration <= 0) throw new Error("Music generation duration must be a positive integer");
  const min = Number(capabilities.durationRange.min || 0);
  const max = Number(capabilities.durationRange.max || 0);
  if (min > 0 && duration < min) throw new Error(`Music generation duration cannot be shorter than ${min} seconds for this model`);
  if (max > 0 && duration > max) throw new Error(`Music generation duration cannot exceed ${max} seconds for this model`);
  const outputFormat = String(config.outputFormat || config.format || capabilities.outputFormats[0] || "mp3").toLowerCase();
  if (capabilities.outputFormats.length && !capabilities.outputFormats.map((item) => item.toLowerCase()).includes(outputFormat)) {
    throw new Error(`Music output format ${outputFormat} is not supported by this model`);
  }
  const references = Array.isArray(config.referenceList) ? config.referenceList : [];
  if (references.length && capabilities.referenceAudio === false) throw new Error("This music model does not support reference audio");
  if (config.loop === true && capabilities.loop === false) throw new Error("This music model does not support loop generation");
  return { durationSec: duration, outputFormat, referenceList: references };
}

export function buildMusicProviderRequest(input: {
  config: Record<string, unknown>;
  prompt: string;
  negativePrompt?: string | null;
  lyrics?: string | null;
  vocalMode?: string | null;
}) {
  const request = { ...input.config } as Record<string, unknown>;
  for (const key of [
    "effectiveMusicDurationSec",
    "generationDurationSec",
    "promptVersionId",
    "lyricsVersionId",
    "promptHash",
    "lyricsHash",
    "generationConfigHash",
  ]) delete request[key];
  delete request.lyrics;
  request.prompt = input.prompt;
  request.negativePrompt = input.negativePrompt || "";
  if (input.lyrics) request.lyrics = input.lyrics;
  if (input.vocalMode) request.vocalMode = input.vocalMode;
  return request;
}
