import {
  factStatusForStoryboardJson,
  parseStoryboardJsonObject,
  parseStoryboardTableRow,
  legacyStoryboardCharacters,
  legacyStoryboardGroupIntent,
  legacyStoryboardGroupName,
  legacyStoryboardVisibleEmotion,
  StoryboardFactStatus,
  StoryboardTableRow,
  StoryboardTableRowV1,
  stringifyDialogue,
  stringifySoundEffects,
} from "@/services/storyboardTableContract";
import u from "@/utils";

export type StoryboardFactSource = "storyboardTable" | "minimalFallback";

export interface StoryboardVideoFact {
  storyboardId: number;
  displayIndex: number;
  factSource: StoryboardFactSource;
  factStatus: StoryboardFactStatus;
  scene: string;
  location: string;
  timeOfDay: string;
  sceneContinuityId: string;
  factVersion: number | null;
  shotDescription: string;
  picture: string;
  action: string;
  shotSize: string;
  cameraMove: string;
  cameraAngle: string;
  transitionFromPrevious: string;
  duration: string | number | null;
  dialogue: string;
  sound: string;
  visibleEmotion: string;
  /** Historical V1 compatibility only. V2/V3 rows always expose an empty list. */
  characters: StoryboardTableRowV1["characters"];
  requiredAssets: StoryboardTableRow["requiredAssets"];
  groupKey?: string;
  groupName?: string;
  groupIntent?: string;
  beatId?: string;
  shouldGenerateImage?: number;
  associateAssetsIds: number[];
  tableRow?: StoryboardTableRow;
  rawVideoDesc: string;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function objectDialogue(value: unknown) {
  if (!Array.isArray(value)) return "";
  const normalized = value
    .map((item) => ({
      speaker: text(item?.speaker),
      text: text(item?.text),
      voiceTone: text(item?.voiceTone) || undefined,
    }))
    .filter((item) => item.text);
  if (!normalized.length) return "";
  return normalized
    .map((item) => `${item.speaker ? `${item.speaker}：` : ""}${item.text}${item.voiceTone ? `（${item.voiceTone}）` : ""}`)
    .join("；");
}

function objectSound(value: unknown) {
  return Array.isArray(value) ? value.map(text).filter(Boolean).join("、") : "";
}

export function resolveStoryboardFactStatus(row: any): StoryboardFactStatus {
  const derived = factStatusForStoryboardJson(row?.tableRowJson);
  if (derived !== "ready") return derived;
  return row?.factStatus === "draft" ? "draft" : "ready";
}

export function buildStoryboardVideoFact(row: any, associateAssetsIds: number[] = []): StoryboardVideoFact {
  const tableRow = parseStoryboardTableRow(row?.tableRowJson);
  const object = parseStoryboardJsonObject(row?.tableRowJson);
  const factStatus = resolveStoryboardFactStatus(row);
  const displayIndex = row.index == null ? Number(row.id) : Number(row.index) + 1;
  const structured = tableRow || object;

  return {
    storyboardId: Number(row.id),
    displayIndex,
    factSource: factStatus === "ready" && tableRow ? "storyboardTable" : "minimalFallback",
    factStatus,
    scene: text(structured?.location) || (factStatus === "legacy" ? text(row.scene) : ""),
    location: text(structured?.location) || (factStatus === "legacy" ? text(row.location || row.scene) : ""),
    timeOfDay: text(structured?.timeOfDay) || (factStatus === "legacy" ? text(row.timeOfDay) : ""),
    sceneContinuityId: text(structured?.sceneContinuityId) || (factStatus === "legacy" ? text(row.sceneContinuityId) : ""),
    factVersion: tableRow?.version ?? (Number.isFinite(Number(object?.version)) ? Number(object?.version) : null),
    shotDescription: tableRow?.version === 3 ? tableRow.shotDescription : "",
    picture: tableRow?.version === 3 ? "" : text((structured as any)?.picture) || (factStatus === "legacy" ? text(row.picture) : ""),
    action: tableRow?.version === 3 ? "" : text((structured as any)?.action) || (factStatus === "legacy" ? text(row.action) : ""),
    shotSize: text(structured?.shotSize) || (factStatus === "legacy" ? text(row.shotSize) : ""),
    cameraMove: text(structured?.cameraMove) || (factStatus === "legacy" ? text(row.cameraMove) : ""),
    cameraAngle: text(structured?.cameraAngle),
    transitionFromPrevious: text(structured?.transitionFromPrevious),
    duration: structured?.durationSec ?? (factStatus === "legacy" ? row.duration ?? null : null),
    dialogue: tableRow
      ? stringifyDialogue(tableRow.dialogue)
      : objectDialogue(object?.dialogue) || (factStatus === "legacy" ? text(row.dialogue) : ""),
    sound: tableRow
      ? stringifySoundEffects(tableRow.soundEffects)
      : objectSound(object?.soundEffects) || (factStatus === "legacy" ? text(row.sound) : ""),
    visibleEmotion: tableRow
      ? legacyStoryboardVisibleEmotion(tableRow)
      : factStatus === "legacy"
        ? text(row.visibleEmotion)
        : "",
    characters: tableRow ? legacyStoryboardCharacters(tableRow) : [],
    requiredAssets: tableRow?.requiredAssets || [],
    groupKey: text(structured?.groupKey) || (factStatus === "legacy" ? text(row.groupKey) : "") || undefined,
    groupName:
      (tableRow ? legacyStoryboardGroupName(tableRow) : "") || text(row.groupName) || undefined,
    groupIntent:
      (tableRow ? legacyStoryboardGroupIntent(tableRow) : "") || text(row.groupIntent) || undefined,
    beatId: text(structured?.beatId) || (factStatus === "legacy" ? text(row.beatId) : "") || undefined,
    shouldGenerateImage: row.shouldGenerateImage ?? undefined,
    associateAssetsIds,
    tableRow: tableRow || undefined,
    rawVideoDesc: "",
  };
}

export function summarizeFactSources(facts: StoryboardVideoFact[]) {
  return facts.reduce<Record<StoryboardFactSource, number>>(
    (result, item) => {
      result[item.factSource] += 1;
      return result;
    },
    { storyboardTable: 0, minimalFallback: 0 },
  );
}

export function assertStoryboardFactsReady(facts: StoryboardVideoFact[]) {
  if (!facts.length) throw new Error("当前视频轨道没有可用分镜，无法生成视频。");
  const blocked = facts.filter((item) => item.factStatus !== "ready" || !item.tableRow);
  if (!blocked.length) return;
  throw new Error(
    `分镜尚未完成结构化整理，无法生成视频。请先整理分镜：${blocked.map((item) => item.displayIndex).join(", ")}`,
  );
}

export async function assertTrackStoryboardsReady(input: {
  projectId: number;
  scriptId: number;
  trackIds: number[];
}) {
  if (!input.trackIds.length) return;
  const rows = await u
    .db("o_storyboard")
    .where({ projectId: input.projectId, scriptId: input.scriptId })
    .whereIn("trackId", input.trackIds)
    .select("id", "index", "trackId", "tableRowJson", "factStatus");
  const facts = rows.map((row: any) => buildStoryboardVideoFact(row));
  assertStoryboardFactsReady(facts);
}
