import u from "@/utils";

export interface MusicModelCapabilities {
  model: string;
  name: string;
  durationRange: { min?: number; max?: number };
  durationControl?: "exact" | "targetOnly";
  /** Whether this provider accepts durationSec as an actual request parameter. */
  durationParameter: boolean;
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

function capabilityFromModel(model: string, detail: any): MusicModelCapabilities {
  return {
    model,
    name: detail.name || detail.modelName,
    durationRange: {
      min: Number.isFinite(Number(detail.durationRange?.min)) ? Number(detail.durationRange.min) : undefined,
      max: Number.isFinite(Number(detail.durationRange?.max)) ? Number(detail.durationRange.max) : undefined,
    },
    durationControl: detail.durationControl === "targetOnly" ? "targetOnly" : "exact",
    durationParameter: detail.durationParameter === true,
    outputFormats: Array.isArray(detail.outputFormats) ? detail.outputFormats.map(String) : [],
    vocal: detail.vocal,
    lyrics: detail.lyrics,
    referenceAudio: detail.referenceAudio,
    loop: detail.loop,
  };
}

export async function resolveMusicModelCapabilities(model: string): Promise<MusicModelCapabilities> {
  const { vendorId, modelName } = parseMusicModelKey(model);
  const models = await u.vendor.getModelList(vendorId);
  const detail = models.find((item: any) => item.modelName === modelName && item.type === "music");
  if (!detail) throw new Error("Music model does not exist or is no longer available");
  return capabilityFromModel(model, detail);
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
            ...capabilityFromModel(`${vendorId}:${item.modelName}`, item),
            vendorId,
            modelName: String(item.modelName),
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
  capabilities: Pick<MusicModelCapabilities, "durationRange"> & Partial<Pick<MusicModelCapabilities, "durationControl" | "durationParameter">>;
}) {
  const rawTarget = input.effectiveMusicDurationSec ?? input.requestedDurationSec;
  const parsedTarget = Number(rawTarget);
  const effective = Number.isFinite(parsedTarget) && parsedTarget > 0 ? Math.ceil(parsedTarget) : undefined;
  const min = Number(input.capabilities.durationRange.min || 0);
  const max = Number(input.capabilities.durationRange.max || 0);
  const durationControl: "exact" | "targetOnly" = input.capabilities.durationControl === "targetOnly" ? "targetOnly" : "exact";
  const durationParameter = input.capabilities.durationParameter === true;
  if (!effective || !durationParameter) {
    return {
      effectiveMusicDurationSec: effective,
      generationDurationSec: undefined,
      hasSilentTail: false,
      durationControl,
      durationParameter,
      durationRange: { min: min || undefined, max: max || undefined },
    };
  }
  const requested = durationControl === "targetOnly"
    ? Math.max(effective, Math.ceil(Number(input.requestedDurationSec || effective)))
    : Math.max(effective, Math.ceil(Number(input.requestedDurationSec || effective)), min || 0);
  if (max > 0 && requested > max) {
    throw new Error(`Suggested music duration ${effective} seconds exceeds the selected model limit of ${max} seconds`);
  }
  return {
    effectiveMusicDurationSec: effective,
    generationDurationSec: requested,
    hasSilentTail: durationControl === "exact" && requested > effective,
    durationControl,
    durationParameter,
    durationRange: { min: min || undefined, max: max || undefined },
  };
}

export function buildMusicProviderRequest(input: {
  config: Record<string, unknown>;
  prompt: string;
  negativePrompt?: string | null;
  lyrics?: string | null;
  vocalMode?: string | null;
  durationParameter?: boolean;
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
  if (input.durationParameter !== true) {
    delete request.durationSec;
    delete request.duration;
  }
  delete request.lyrics;
  request.prompt = input.prompt;
  request.negativePrompt = input.negativePrompt || "";
  if (input.lyrics) request.lyrics = input.lyrics;
  if (input.vocalMode) request.vocalMode = input.vocalMode;
  return request;
}
