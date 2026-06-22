import u from "@/utils";
import { resolveDirectorAsset } from "@/services/directorAsset";
import {
  buildStoryboardDraftRow,
  parseStoryboardTableRow,
  storyboardRowToDbPatch,
  storyboardTableRowV2Schema,
  stringifyDialogue,
  stringifySoundEffects,
} from "@/services/storyboardTableContract";

export type StoryboardReferenceSource = "local" | "storyboard" | "directorAsset";

export interface StoryboardReferenceImage {
  id?: string | number;
  source: StoryboardReferenceSource;
  sourceId?: string | number | null;
  url: string;
  previewUrl?: string;
  label?: string;
  group?: string;
  type?: string;
}

export interface StoryboardEditorInput {
  id: number;
  prompt: string;
  videoDesc: string;
  duration: number;
  associateAssetsIds: number[];
  referenceImages: StoryboardReferenceImage[];
  scene?: string;
  picture?: string;
  action?: string;
  shotSize?: string;
  cameraMove?: string;
  dialogue?: string;
  sound?: string;
  visibleEmotion?: string;
  location?: string;
  timeOfDay?: string;
  sceneContinuityId?: string | null;
  groupKey?: string;
  groupName?: string;
  groupIntent?: string;
  beatId?: string;
  characters?: any[];
  dialogueItems?: any[];
  soundEffects?: string[];
  requiredAssets?: any[];
  tableRowJson?: unknown;
}

export class StoryboardContractError extends Error {
  issues: Array<{ path: string; message: string }>;

  constructor(message: string, issues: Array<{ path: string; message: string }>) {
    super(message);
    this.name = "StoryboardContractError";
    this.issues = issues;
  }
}

function normalizePath(value: unknown): string {
  return typeof value === "string" && value.trim() ? u.replaceUrl(value.split(/[?#]/, 1)[0]) : "";
}

function uniqueIds(values: number[]): number[] {
  const seen = new Set<number>();
  return values.filter((value) => {
    const id = Number(value);
    if (!Number.isFinite(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function parseStoryboardReferences(value: unknown): StoryboardReferenceImage[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function serializeStoryboardReferences(values: StoryboardReferenceImage[]): string {
  return JSON.stringify(
    values.map((item, index) => ({
      ...item,
      id: item.id ?? `${item.source}:${item.sourceId ?? index}`,
      sourceId: item.sourceId ?? null,
      url: normalizePath(item.url),
      previewUrl: normalizePath(item.previewUrl || item.url),
      label: item.label || "",
      group: item.group || "",
      type: item.type || "image",
    })),
  );
}

export async function resolveStoryboardReferences(value: unknown): Promise<StoryboardReferenceImage[]> {
  return Promise.all(
    parseStoryboardReferences(value).map(async (item, index) => {
      let originalPath = normalizePath(item.url);
      if (item.source === "directorAsset" && item.sourceId != null) {
        try {
          const row = await resolveDirectorAsset(Number(item.sourceId));
          originalPath = normalizePath(row.filePath);
        } catch {}
      }
      const previewPath = normalizePath(item.previewUrl || originalPath || item.url);
      return {
        ...item,
        id: item.id ?? `${item.source || "local"}:${item.sourceId ?? index}`,
        source: item.source === "storyboard" || item.source === "directorAsset" ? item.source : "local",
        sourceId: item.sourceId ?? null,
        url: originalPath ? await u.oss.getFileUrl(originalPath) : "",
        previewUrl: previewPath ? await u.oss.getSmallImageUrl(previewPath) : "",
        label: item.label || "",
        group: item.group || "",
        type: item.type || "image",
      };
    }),
  );
}

async function validateAssets(trx: any, projectId: number, assetIds: number[]) {
  if (!assetIds.length) return;
  const rows = await trx("o_assets").whereIn("id", assetIds).select("id", "projectId");
  const valid = new Set(rows.filter((row: any) => Number(row.projectId) === projectId).map((row: any) => Number(row.id)));
  const issues = assetIds
    .filter((id) => !valid.has(id))
    .map((id) => ({ path: "associateAssetsIds", message: `资产 ${id} 不属于当前项目或不存在` }));
  if (issues.length) throw new StoryboardContractError("分镜数据校验失败", issues);
}

async function validateReferences(
  trx: any,
  owner: { id: number; projectId: number; scriptId: number },
  references: StoryboardReferenceImage[],
) {
  const issues: Array<{ path: string; message: string }> = [];
  const storyboardIds = references
    .filter((item) => item.source === "storyboard")
    .map((item) => Number(item.sourceId))
    .filter(Number.isFinite);
  const directorAssetIds = references
    .filter((item) => item.source === "directorAsset")
    .map((item) => Number(item.sourceId))
    .filter(Number.isFinite);
  const rows = storyboardIds.length
    ? await trx("o_storyboard").whereIn("id", storyboardIds).select("id", "projectId", "scriptId")
    : [];
  const rowMap = new Map<number, any>(rows.map((row: any) => [Number(row.id), row]));
  const directorRows = directorAssetIds.length
    ? await trx("o_directorAsset").whereIn("id", directorAssetIds).select("id", "projectId")
    : [];
  const directorMap = new Map<number, any>(directorRows.map((row: any) => [Number(row.id), row]));

  references.forEach((item, index) => {
    if (!item.url) issues.push({ path: `referenceImages.${index}.url`, message: "引用图片地址不能为空" });
    if (item.source === "storyboard") {
      const sourceId = Number(item.sourceId);
      const source = rowMap.get(sourceId);
      if (!Number.isFinite(sourceId) || !source) {
        issues.push({ path: `referenceImages.${index}.sourceId`, message: "引用的分镜不存在" });
      } else if (sourceId === owner.id) {
        issues.push({ path: `referenceImages.${index}.sourceId`, message: "分镜不能引用自身" });
      } else if (Number(source.projectId) !== owner.projectId || Number(source.scriptId) !== owner.scriptId) {
        issues.push({ path: `referenceImages.${index}.sourceId`, message: "引用分镜不属于当前项目和剧集" });
      }
    }
    if (item.source === "directorAsset") {
      const sourceId = Number(item.sourceId);
      const source = directorMap.get(sourceId);
      if (!Number.isFinite(sourceId) || !source) {
        issues.push({ path: `referenceImages.${index}.sourceId`, message: "Director asset reference does not exist" });
      } else if (Number(source.projectId) !== owner.projectId) {
        issues.push({ path: `referenceImages.${index}.sourceId`, message: "Director asset does not belong to the project" });
      }
    }
  });
  if (issues.length) throw new StoryboardContractError("分镜数据校验失败", issues);
}

export async function updateTrackDuration(trx: any, trackId: number | null | undefined) {
  if (!trackId) return;
  const rows = await trx("o_storyboard").where("trackId", trackId).select("duration", "tableRowJson");
  const duration = rows.reduce((sum: number, row: any) => {
    const fact = parseStoryboardTableRow(row.tableRowJson);
    return sum + (fact?.durationSec ?? (Number(row.duration) || 0));
  }, 0);
  await trx("o_videoTrack").where("id", trackId).update({ duration });
}

export async function saveStoryboardEditor(input: StoryboardEditorInput) {
  return u.db.transaction(async (trx: any) => {
    const storyboard = await trx("o_storyboard")
      .where("id", input.id)
      .first("id", "projectId", "scriptId", "trackId", "index", "tableRowJson", "factRevision");
    if (!storyboard) {
      throw new StoryboardContractError("分镜数据校验失败", [{ path: "id", message: "分镜不存在" }]);
    }
    const assetIds = uniqueIds(input.associateAssetsIds || []);
    const references = input.referenceImages || [];
    await validateAssets(trx, Number(storyboard.projectId), assetIds);
    await validateReferences(
      trx,
      {
        id: Number(storyboard.id),
        projectId: Number(storyboard.projectId),
        scriptId: Number(storyboard.scriptId),
      },
      references,
    );

    const existingFact = parseStoryboardTableRow(storyboard.tableRowJson);
    const dialogueInput =
      input.dialogueItems !== undefined
        ? input.dialogueItems
        : input.dialogue !== undefined && (!existingFact || input.dialogue !== stringifyDialogue(existingFact.dialogue))
          ? input.dialogue
          : undefined;
    const soundInput =
      input.soundEffects !== undefined
        ? input.soundEffects
        : input.sound !== undefined && (!existingFact || input.sound !== stringifySoundEffects(existingFact.soundEffects))
          ? input.sound
          : undefined;
    const explicitFacts: Record<string, unknown> = {
      ...(input.tableRowJson && typeof input.tableRowJson === "object" ? (input.tableRowJson as Record<string, unknown>) : {}),
      index: Number(storyboard.index ?? 0),
      duration: input.duration,
      scene: input.scene,
      location: input.location,
      timeOfDay: input.timeOfDay,
      sceneContinuityId: input.sceneContinuityId,
      picture: input.picture,
      action: input.action,
      shotSize: input.shotSize,
      cameraMove: input.cameraMove,
      visibleEmotion: input.visibleEmotion,
      groupKey: input.groupKey,
      groupName: input.groupName,
      groupIntent: input.groupIntent,
      beatId: input.beatId,
      characters: input.characters,
      dialogue: dialogueInput,
      soundEffects: soundInput,
      requiredAssets: input.requiredAssets,
    };
    for (const key of Object.keys(explicitFacts)) {
      if (explicitFacts[key] === undefined) delete explicitFacts[key];
    }
    const factObject = buildStoryboardDraftRow(explicitFacts, Number(storyboard.index ?? 0), storyboard.tableRowJson);
    const parsedFact = storyboardTableRowV2Schema.safeParse(factObject);
    const storyboardPatch: Record<string, unknown> = {
      prompt: input.prompt,
      referenceImages: serializeStoryboardReferences(references),
      tableRowJson: JSON.stringify(factObject),
      factStatus: parsedFact.success ? "ready" : "draft",
      factVersion: 1,
      factRevision: Number(storyboard.factRevision || 0) + 1,
    };
    if (parsedFact.success) {
      Object.assign(storyboardPatch, storyboardRowToDbPatch(parsedFact.data, Number(storyboard.factRevision || 0) + 1));
    } else {
      storyboardPatch.duration = String(input.duration);
    }
    await trx("o_storyboard").where("id", input.id).update(storyboardPatch);
    await trx("o_assets2Storyboard").where("storyboardId", input.id).delete();
    if (assetIds.length) {
      await trx("o_assets2Storyboard").insert(assetIds.map((assetId) => ({ storyboardId: input.id, assetId })));
    }
    await updateTrackDuration(trx, storyboard.trackId);
    return {
      id: input.id,
      associateAssetsIds: assetIds,
      scene: input.scene || null,
      picture: input.picture || null,
      action: input.action || null,
      shotSize: input.shotSize || null,
      cameraMove: input.cameraMove || null,
      dialogue: input.dialogue || null,
      sound: input.sound || null,
      visibleEmotion: input.visibleEmotion || null,
      tableRowJson: JSON.stringify(factObject),
      factStatus: parsedFact.success ? "ready" : "draft",
      issues: parsedFact.success ? [] : parsedFact.error.issues,
    };
  });
}

export async function validateNewStoryboardRelations(
  trx: any,
  owner: { id: number; projectId: number; scriptId: number },
  associateAssetsIds: number[],
  referenceImages: StoryboardReferenceImage[],
) {
  const assetIds = uniqueIds(associateAssetsIds || []);
  await validateAssets(trx, owner.projectId, assetIds);
  await validateReferences(trx, owner, referenceImages || []);
  return assetIds;
}
