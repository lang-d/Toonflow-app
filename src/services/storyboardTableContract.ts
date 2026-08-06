import { z } from "zod";

const requiredText = z.string().trim().min(1);
const optionalText = z.string().trim().min(1).optional();

export const sceneContinuityIdRequestSchema = z.string().nullable().optional();

const storyboardCharacterV1Schema = z.object({
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

/** Historical row contract. It remains readable but is never used for new Agent writes. */
export const storyboardTableRowV1Schema = z.object({
  version: z.literal(1),
  index: z.number().int().nonnegative(),
  sceneNo: optionalText,
  groupKey: requiredText,
  groupName: requiredText,
  groupIntent: requiredText,
  beatId: requiredText,
  durationSec: z.number().int().positive(),
  location: requiredText,
  timeOfDay: requiredText,
  sceneContinuityId: optionalText,
  picture: requiredText,
  shotSize: requiredText,
  cameraMove: requiredText,
  cameraAngle: optionalText,
  transitionFromPrevious: optionalText,
  action: requiredText,
  characters: z.array(storyboardCharacterV1Schema),
  visibleEmotion: requiredText,
  dialogue: z.array(storyboardDialogueSchema),
  soundEffects: z.array(requiredText),
  requiredAssets: z.array(storyboardRequiredAssetSchema),
}).strict();

/** Historical V2 contract. It remains readable and editable in its native form. */
export const storyboardTableRowV2Schema = z.object({
  version: z.literal(2),
  index: z.number().int().nonnegative(),
  sceneNo: optionalText,
  groupKey: requiredText,
  beatId: requiredText,
  durationSec: z.number().int().positive(),
  location: requiredText,
  timeOfDay: requiredText,
  sceneContinuityId: optionalText,
  picture: requiredText,
  action: requiredText,
  shotSize: requiredText,
  cameraMove: optionalText,
  cameraAngle: optionalText,
  transitionFromPrevious: optionalText,
  dialogue: z.array(storyboardDialogueSchema),
  soundEffects: z.array(requiredText),
  requiredAssets: z.array(storyboardRequiredAssetSchema),
}).strict();

/**
 * Current Agent write contract. The description is intentionally a single
 * chronological source instead of two competing picture/action narratives.
 */
export const storyboardTableRowV3Schema = z.object({
  version: z.literal(3),
  index: z.number().int().nonnegative(),
  sceneNo: optionalText,
  groupKey: requiredText,
  beatId: requiredText,
  durationSec: z.number().int().positive(),
  location: requiredText,
  timeOfDay: requiredText,
  sceneContinuityId: optionalText,
  shotDescription: requiredText,
  shotSize: requiredText,
  cameraMove: optionalText,
  cameraAngle: optionalText,
  transitionFromPrevious: optionalText,
  dialogue: z.array(storyboardDialogueSchema),
  soundEffects: z.array(requiredText),
  requiredAssets: z.array(storyboardRequiredAssetSchema),
}).strict();

export const storyboardTableRowSchema = z.union([
  storyboardTableRowV3Schema,
  storyboardTableRowV2Schema,
  storyboardTableRowV1Schema,
]);

export const storyboardGroupPlanV2Schema = z.object({
  groupKey: requiredText,
  groupName: requiredText,
  groupIntent: requiredText,
  storyboardIndexes: z.array(z.number().int().nonnegative()).min(1),
});

export type StoryboardTableRowV1 = z.infer<typeof storyboardTableRowV1Schema>;
export type StoryboardTableRowV2 = z.infer<typeof storyboardTableRowV2Schema>;
export type StoryboardTableRowV3 = z.infer<typeof storyboardTableRowV3Schema>;
export type StoryboardTableRow = StoryboardTableRowV1 | StoryboardTableRowV2 | StoryboardTableRowV3;
export type StoryboardGroupPlanV2 = z.infer<typeof storyboardGroupPlanV2Schema>;
export type StoryboardFactStatus = "draft" | "ready" | "legacy";
export const STORYBOARD_FACT_WRITE_VERSION = 3 as const;

export interface StoryboardTableIssue {
  index: number;
  field: string;
  message: string;
  code?: string;
  details?: Record<string, unknown>;
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

export function parseStoryboardTableRow(value: unknown): StoryboardTableRow | null {
  const object = parseStoryboardJsonObject(value);
  if (!object) return null;
  const result = storyboardTableRowSchema.safeParse(object);
  return result.success ? result.data : null;
}

export function isStoryboardTableRowV1(row: StoryboardTableRow): row is StoryboardTableRowV1 {
  return row.version === 1;
}

export function isStoryboardTableRowV3(row: StoryboardTableRow): row is StoryboardTableRowV3 {
  return row.version === 3;
}

export function legacyStoryboardCharacters(row: StoryboardTableRow) {
  return row.version === 1 ? row.characters : [];
}

export function legacyStoryboardVisibleEmotion(row: StoryboardTableRow) {
  return row.version === 1 ? row.visibleEmotion : "";
}

export function legacyStoryboardGroupName(row: StoryboardTableRow) {
  return row.version === 1 ? row.groupName : "";
}

export function legacyStoryboardGroupIntent(row: StoryboardTableRow) {
  return row.version === 1 ? row.groupIntent : "";
}

export function stringifyDialogue(dialogue: StoryboardTableRow["dialogue"]) {
  if (!dialogue.length) return "无台词";
  return dialogue
    .map((item) => {
      const suffix = item.voiceTone ? `（${item.voiceTone}）` : "";
      return `${item.speaker}：${item.text}${suffix}`;
    })
    .join("；");
}

export function stringifySoundEffects(soundEffects: string[]) {
  return soundEffects.join("；");
}

/** Builds a native V2 draft for historical/manual V2 editing only. */
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
    version: 2,
    index,
    sceneNo: optional(pick("sceneNo", undefined)),
    groupKey: text(pick("groupKey", "")),
    beatId: text(pick("beatId", "")),
    durationSec: numberOr(pick("durationSec", has("duration") ? input.duration : 0), 0),
    location: text(pick("location", has("scene") ? input.scene : "")),
    timeOfDay: text(pick("timeOfDay", "")),
    sceneContinuityId: optional(pick("sceneContinuityId", undefined)),
    picture: text(pick("picture", "")),
    action: text(pick("action", "")),
    shotSize: text(pick("shotSize", "")),
    cameraMove: optional(pick("cameraMove", undefined)),
    cameraAngle: optional(pick("cameraAngle", undefined)),
    transitionFromPrevious: optional(pick("transitionFromPrevious", undefined)),
    dialogue,
    soundEffects,
    requiredAssets: Array.isArray(pick("requiredAssets", [])) ? pick("requiredAssets", []) : [],
  };
}

export function buildStoryboardTableRowV2(input: Record<string, any>, fallbackIndex = 0): StoryboardTableRowV2 {
  return storyboardTableRowV2Schema.parse(buildStoryboardDraftRow(input, fallbackIndex));
}

export function buildStoryboardTableRowV3(input: Record<string, any>): StoryboardTableRowV3 {
  return storyboardTableRowV3Schema.parse(input);
}

/** New generation writes are V3-only. Historical V1/V2 rows stay version-native. */
export function validateStoryboardTableRows(rows: unknown[]): StoryboardTableIssue[] {
  const issues: StoryboardTableIssue[] = [];
  const seenIndexes = new Set<number>();
  rows.forEach((row, rowIndex) => {
    const result = storyboardTableRowV3Schema.safeParse(row);
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

export function storyboardRowToDbPatch(
  row: StoryboardTableRow,
  revision = 1,
  group?: { groupName?: string; groupIntent?: string },
) {
  return {
    tableRowJson: JSON.stringify(row),
    factStatus: "ready" as StoryboardFactStatus,
    factVersion: row.version,
    factRevision: revision,
    // Compatibility projections. They are never read as authoritative V2 facts.
    duration: String(row.durationSec),
    scene: row.location,
    location: row.location,
    timeOfDay: row.timeOfDay,
    sceneContinuityId: row.sceneContinuityId || null,
    picture: row.version === 3 ? null : row.picture,
    action: row.version === 3 ? null : row.action,
    shotSize: row.shotSize,
    cameraMove: row.cameraMove || "",
    dialogue: stringifyDialogue(row.dialogue),
    sound: stringifySoundEffects(row.soundEffects),
    visibleEmotion: null,
    groupKey: row.groupKey,
    groupName: group?.groupName || "",
    groupIntent: group?.groupIntent || "",
    beatId: row.beatId,
    videoDesc: "",
  };
}

export function assetIdsFromStoryboardRow(row: StoryboardTableRow) {
  return [...new Set(row.requiredAssets.map((item) => item.assetId))];
}

export function factStatusForStoryboardJson(value: unknown): StoryboardFactStatus {
  if (!parseStoryboardJsonObject(value)) return "legacy";
  return parseStoryboardTableRow(value) ? "ready" : "draft";
}
