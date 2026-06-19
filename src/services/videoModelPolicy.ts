import u from "@/utils";

export interface VideoDurationPolicy {
  vendorId: string;
  modelName: string;
  modelLabel: string;
  resolution?: string;
  maxDuration: number;
  supportedDurations: number[];
  supportedResolutions: string[];
  canValidate: boolean;
}

function splitModelKey(modelKey: string) {
  const [vendorId, modelName = ""] = String(modelKey || "").split(/:(.+)/);
  return { vendorId, modelName };
}

function uniqueSortedNumbers(values: unknown[]) {
  return [...new Set(values.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
}

function uniqueStrings(values: unknown[]) {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function resolutionMatches(candidate: unknown, resolution: string) {
  return String(candidate || "").toLowerCase() === resolution.toLowerCase();
}

export async function getVideoModelPolicy(
  modelKey: string,
  options: { resolution?: string; fallbackMaxDuration?: number } = {},
): Promise<VideoDurationPolicy> {
  const { vendorId, modelName } = splitModelKey(modelKey);
  const fallbackMaxDuration = options.fallbackMaxDuration ?? 15;
  const models = vendorId ? await u.vendor.getModelList(vendorId) : [];
  const model = models.find((item: any) => item?.type === "video" && item.modelName === modelName);
  const maps = Array.isArray(model?.durationResolutionMap) ? model.durationResolutionMap : [];
  const supportedResolutions = uniqueStrings(maps.flatMap((item: any) => item?.resolution || []));

  let candidateMaps = maps;
  if (options.resolution && maps.length) {
    const matched = maps.filter((item: any) => (item?.resolution || []).some((value: unknown) => resolutionMatches(value, options.resolution!)));
    if (matched.length) candidateMaps = matched;
  }

  const supportedDurations = uniqueSortedNumbers(candidateMaps.flatMap((item: any) => item?.duration || []));
  const allDurations = uniqueSortedNumbers(maps.flatMap((item: any) => item?.duration || []));
  const maxDuration = supportedDurations.length
    ? Math.max(...supportedDurations)
    : allDurations.length
      ? Math.max(...allDurations)
      : fallbackMaxDuration;

  return {
    vendorId,
    modelName,
    modelLabel: model?.name || modelName || "default video model",
    resolution: options.resolution,
    maxDuration,
    supportedDurations,
    supportedResolutions,
    canValidate: Boolean(model && maps.length),
  };
}

export async function getProjectDefaultVideoPolicy(
  projectId: number,
  options: { resolution?: string; knex?: any } = {},
) {
  const db = options.knex ?? u.db;
  const project = await db("o_project").where("id", projectId).select("videoModel").first();
  return getVideoModelPolicy(project?.videoModel || "", { resolution: options.resolution, fallbackMaxDuration: 15 });
}

export function assertVideoDurationSupported(policy: VideoDurationPolicy, duration: number) {
  const value = Number(duration);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("视频时长必须是大于 0 的数字");
  }
  if (!policy.canValidate) return;
  if (policy.supportedDurations.length && !policy.supportedDurations.includes(value)) {
    throw new Error(
      `当前模型 ${policy.modelLabel} ${policy.resolution ? `在 ${policy.resolution} ` : ""}不支持 ${value}s，支持时长：${policy.supportedDurations.join(", ")}s`,
    );
  }
}
