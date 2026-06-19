import { z } from "zod";

const requiredText = z.string().trim().min(1);
const optionalText = z.string().trim().min(1).optional();

export const storyboardCharacterSchema = z.object({
  assetId: z.number().int().positive().optional(),
  name: requiredText,
  action: requiredText,
  orientation: requiredText,
  spatialPosition: requiredText,
  posture: optionalText,
  expression: optionalText,
  gaze: optionalText,
  handAction: optionalText,
  movement: optionalText,
});

export const storyboardDialogueSchema = z.object({
  speaker: z.string().trim(),
  text: requiredText,
  voiceTone: optionalText,
});

export const storyboardRequiredAssetSchema = z.object({
  assetId: z.number().int().positive(),
  name: requiredText,
  type: z.enum(["role", "scene", "tool", "clip"]),
  order: z.number().int().nonnegative(),
});

export const storyboardTableRowV2Schema = z.object({
  version: z.literal(1),
  index: z.number().int().nonnegative(),
  sceneNo: optionalText,
  groupKey: requiredText,
  groupName: requiredText,
  groupIntent: requiredText,
  beatId: requiredText,
  durationSec: z.number().positive(),
  location: requiredText,
  timeOfDay: requiredText,
  sceneContinuityId: optionalText,
  picture: requiredText,
  shotSize: requiredText,
  cameraMove: requiredText,
  cameraAngle: optionalText,
  transitionFromPrevious: optionalText,
  action: requiredText,
  characters: z.array(storyboardCharacterSchema),
  visibleEmotion: requiredText,
  dialogue: z.array(storyboardDialogueSchema),
  soundEffects: z.array(requiredText),
  requiredAssets: z.array(storyboardRequiredAssetSchema),
});

export const storyboardGroupPlanV2Schema = z.object({
  groupKey: requiredText,
  groupName: requiredText,
  groupIntent: requiredText,
  storyboardIndexes: z.array(z.number().int().nonnegative()).min(1),
});

export type StoryboardTableRowV2 = z.infer<typeof storyboardTableRowV2Schema>;
export type StoryboardGroupPlanV2 = z.infer<typeof storyboardGroupPlanV2Schema>;
export type StoryboardFactStatus = "draft" | "ready" | "legacy";

export interface StoryboardTableIssue {
  index: number;
  field: string;
  message: string;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function optional(value: unknown) {
  return text(value) || undefined;
}

function numberOr(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseStoryboardJsonObject(value: unknown): Record<string, any> | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseStoryboardTableRow(value: unknown): StoryboardTableRowV2 | null {
  const object = parseStoryboardJsonObject(value);
  if (!object) return null;
  const result = storyboardTableRowV2Schema.safeParse(object);
  return result.success ? result.data : null;
}

export function stringifyDialogue(dialogue: StoryboardTableRowV2["dialogue"]) {
  if (!dialogue.length) return "无台词";
  return dialogue
    .map((item) => {
      const suffix = item.voiceTone ? `（${item.voiceTone}）` : "";
      return `${item.speaker}：${item.text}${suffix}`;
    })
    .join("；");
}

export function stringifySoundEffects(soundEffects: string[]) {
  return soundEffects.join("、");
}

/**
 * Builds a canonical object only from explicitly supplied structured fields.
 * It never derives facts from videoDesc, Markdown, XML, prompts, or other prose.
 */
export function buildStoryboardDraftRow(
  input: Record<string, any>,
  fallbackIndex = 0,
  existingValue?: unknown,
): Record<string, any> {
  const existing = parseStoryboardJsonObject(existingValue ?? input.tableRowJson) || {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
  const pick = (key: string, fallback: unknown) => (has(key) ? input[key] : (existing[key] ?? fallback));
  const index = numberOr(pick("index", fallbackIndex), fallbackIndex);

  const dialogueValue = pick("dialogue", []);
  const dialogue = Array.isArray(dialogueValue)
    ? dialogueValue
    : text(dialogueValue) && text(dialogueValue) !== "无台词"
      ? [{ speaker: "", text: text(dialogueValue) }]
      : [];
  const soundValue = pick("soundEffects", has("sound") ? input.sound : []);
  const soundEffects = Array.isArray(soundValue) ? soundValue : text(soundValue) ? [text(soundValue)] : [];

  return {
    version: 1,
    index,
    sceneNo: optional(pick("sceneNo", undefined)),
    groupKey: text(pick("groupKey", "")),
    groupName: text(pick("groupName", "")),
    groupIntent: text(pick("groupIntent", "")),
    beatId: text(pick("beatId", "")),
    durationSec: numberOr(pick("durationSec", has("duration") ? input.duration : 0), 0),
    location: text(pick("location", has("scene") ? input.scene : "")),
    timeOfDay: text(pick("timeOfDay", "")),
    sceneContinuityId: optional(pick("sceneContinuityId", undefined)),
    picture: text(pick("picture", "")),
    shotSize: text(pick("shotSize", "")),
    cameraMove: text(pick("cameraMove", "")),
    cameraAngle: optional(pick("cameraAngle", undefined)),
    transitionFromPrevious: optional(pick("transitionFromPrevious", undefined)),
    action: text(pick("action", "")),
    characters: Array.isArray(pick("characters", [])) ? pick("characters", []) : [],
    visibleEmotion: text(pick("visibleEmotion", "")),
    dialogue,
    soundEffects,
    requiredAssets: Array.isArray(pick("requiredAssets", [])) ? pick("requiredAssets", []) : [],
  };
}

export function buildStoryboardTableRowV2(input: Record<string, any>, fallbackIndex = 0): StoryboardTableRowV2 {
  return storyboardTableRowV2Schema.parse(buildStoryboardDraftRow(input, fallbackIndex));
}

export function validateStoryboardTableRows(rows: unknown[]): StoryboardTableIssue[] {
  const issues: StoryboardTableIssue[] = [];
  const seenIndexes = new Set<number>();
  rows.forEach((row, rowIndex) => {
    const result = storyboardTableRowV2Schema.safeParse(row);
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({
          index: rowIndex,
          field: issue.path.join(".") || "row",
          message: issue.message,
        });
      }
      return;
    }
    if (seenIndexes.has(result.data.index)) {
      issues.push({ index: rowIndex, field: "index", message: "duplicate index" });
    }
    seenIndexes.add(result.data.index);
  });
  return issues;
}

export function storyboardRowToDbPatch(row: StoryboardTableRowV2, revision = 1) {
  return {
    tableRowJson: JSON.stringify(row),
    factStatus: "ready" as StoryboardFactStatus,
    factVersion: row.version,
    factRevision: revision,
    // Compatibility projections. They are never read as authoritative facts.
    duration: String(row.durationSec),
    scene: row.location,
    location: row.location,
    timeOfDay: row.timeOfDay,
    sceneContinuityId: row.sceneContinuityId || null,
    picture: row.picture,
    action: row.action,
    shotSize: row.shotSize,
    cameraMove: row.cameraMove,
    dialogue: stringifyDialogue(row.dialogue),
    sound: stringifySoundEffects(row.soundEffects),
    visibleEmotion: row.visibleEmotion,
    groupKey: row.groupKey,
    groupName: row.groupName,
    groupIntent: row.groupIntent,
    beatId: row.beatId,
    videoDesc: "",
  };
}

export function assetIdsFromStoryboardRow(row: StoryboardTableRowV2) {
  return [...new Set(row.requiredAssets.map((item) => item.assetId))];
}

export function factStatusForStoryboardJson(value: unknown): StoryboardFactStatus {
  if (!parseStoryboardJsonObject(value)) return "legacy";
  return parseStoryboardTableRow(value) ? "ready" : "draft";
}
