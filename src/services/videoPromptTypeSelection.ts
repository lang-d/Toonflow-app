import u from "@/utils";
import {
  assertVideoPromptTypeForModel,
  getVideoPromptTypeCapabilityForModel,
  VideoPromptTypeCapability,
} from "@/services/videoPromptCompiler";

export type VideoPromptTypeSelections = Record<string, string | null>;

function parseSelections(value: unknown): VideoPromptTypeSelections {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([key, item]) => Boolean(key.trim()) && (typeof item === "string" || item === null)),
    ) as VideoPromptTypeSelections;
  } catch {
    return {};
  }
}

function normalizeSelection(value: unknown) {
  return typeof value === "string" ? value.trim() || null : null;
}

function isCapabilityValue(capability: VideoPromptTypeCapability | null, value: string | null) {
  return value === null || Boolean(capability?.options.some((option) => option.value === value));
}

export async function getProjectVideoPromptTypeSelection(projectId: number, model: string): Promise<string | null> {
  const project = await u.db("o_project").where({ id: projectId }).first();
  if (!project) throw new Error("项目不存在");
  const capability = await getVideoPromptTypeCapabilityForModel(model);
  const selections = parseSelections(project.videoPromptTypeSelections);
  if (Object.prototype.hasOwnProperty.call(selections, model)) {
    const selected = normalizeSelection(selections[model]);
    return isCapabilityValue(capability, selected) ? selected : null;
  }

  const legacyValue = normalizeSelection(project.videoPromptType);
  if (project.videoModel !== model || !legacyValue || !isCapabilityValue(capability, legacyValue)) return null;

  selections[model] = legacyValue;
  await u.db("o_project").where({ id: projectId }).update({ videoPromptTypeSelections: JSON.stringify(selections) });
  return legacyValue;
}

export async function updateProjectVideoPromptTypeSelection(projectId: number, model: string, value: string | null) {
  const project = await u.db("o_project").where({ id: projectId }).first();
  if (!project) throw new Error("项目不存在");
  const requested = normalizeSelection(value);
  await assertVideoPromptTypeForModel(model, requested);
  const selections = parseSelections(project.videoPromptTypeSelections);
  selections[model] = requested;
  await u.db("o_project").where({ id: projectId }).update({ videoPromptTypeSelections: JSON.stringify(selections) });
  return requested;
}
