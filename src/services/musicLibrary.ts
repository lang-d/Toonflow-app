import crypto from "node:crypto";
import u from "@/utils";
import { getAudioAssetResponse } from "@/services/audioAssetResponse";
import { resolveMusicModelCapabilities } from "@/services/musicModelCapability";
import { assertMusicProfileGenerationConfig, resolveMusicPromptProfile } from "@/services/musicPromptProfile";

function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export type MusicWorkType =
  | "theme_song"
  | "opening_song"
  | "ending_song"
  | "insert_song"
  | "score_theme"
  | "source_music"
  | "stinger";
export type MusicEditionType =
  | "master"
  | "narrative_variant"
  | "arrangement"
  | "vocal_variant"
  | "instrumental"
  | "short_edit"
  | "custom";
export type MusicCueUsageMode = "reuse" | "new" | "silence";
export type MusicPromptMode = "generic" | "modelSpecific";

const db = (table: string) => (u.db as any)(table);
const now = () => Date.now();
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

async function nextVersion(table: string, where: Record<string, unknown>, executor: any = db) {
  const row = await executor(table).where(where).max("version as version").first();
  return Number(row?.version || 0) + 1;
}

function isUniqueConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(message);
}

async function retryVersionWrite<T>(run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isUniqueConflict(error)) throw error;
    }
  }
  throw lastError;
}

function jsonWithoutLyrics(value: unknown, rejectLyrics: boolean) {
  const config = parseJsonValue<Record<string, unknown>>(value, {});
  if (Object.prototype.hasOwnProperty.call(config, "lyrics") && config.lyrics != null && String(config.lyrics).trim()) {
    if (rejectLyrics) throw new Error("Lyrics content must be stored as a confirmed lyrics version, not in generationConfig");
    delete config.lyrics;
  }
  return config;
}

export function mergeMusicPromptGenerationConfig(input: {
  base?: { promptMode?: string | null; model?: string | null; profileSource?: string | null; generationConfigJson?: unknown } | null;
  promptMode: MusicPromptMode;
  model: string;
  profileSource?: string | null;
  submittedConfig: Record<string, unknown>;
}) {
  const base = input.base;
  const canInherit = Boolean(
    base
    && (base.promptMode || "modelSpecific") === input.promptMode
    && String(base.model || "") === input.model
    && String(base.profileSource || "") === String(input.profileSource || ""),
  );
  if (!canInherit) return input.submittedConfig;
  return {
    ...jsonWithoutLyrics(base?.generationConfigJson, false),
    ...input.submittedConfig,
  };
}

async function assertProject(projectId: number) {
  if (!(await u.db("o_project").where("id", projectId).first("id"))) throw new Error("Project does not exist");
}

async function assertLibraryItem(projectId: number, id: number) {
  const row = await db("o_musicLibraryItem").where({ projectId, id }).first();
  if (!row) throw new Error("Music library item does not exist");
  return row;
}

export async function getMusicLibraryEdition(projectId: number, id: number) {
  const row = await db("o_musicLibraryEdition").where({ projectId, id }).first();
  if (!row) throw new Error("Music library edition does not exist");
  return { ...row, musicSpec: parseJsonValue(row.musicSpecJson, {}) };
}

export async function getMusicLibraryVersion(projectId: number, id: number) {
  const row = await db("o_musicLibraryVersion").where({ projectId, id }).first();
  if (!row) throw new Error("Music library version does not exist");
  return { ...row, generationConfig: parseJsonValue(row.generationConfigJson, {}) };
}

export async function createMusicLibraryItem(input: {
  projectId: number;
  bibleId?: number | null;
  workKey: string;
  workType: MusicWorkType;
  title?: string;
  narrativeRole?: string;
  reuseScope?: "project" | "episode" | "single_use";
  relatedItemId?: number | null;
  relationType?: "evolves_from" | "replaces" | "companion" | null;
  state?: "planned" | "ready" | "archived";
}) {
  await assertProject(input.projectId);
  if (input.relatedItemId != null) await assertLibraryItem(input.projectId, input.relatedItemId);
  const bible = input.bibleId == null ? null : await u.db("o_musicBible").where({ projectId: input.projectId, id: input.bibleId }).first();
  if (input.bibleId != null && !bible) throw new Error("Music bible does not exist");
  const createdAt = now();
  const [id] = await db("o_musicLibraryItem").insert({
    projectId: input.projectId,
    bibleId: bible?.id ?? null,
    bibleVersion: bible?.version ?? null,
    workKey: input.workKey.trim(),
    workType: input.workType,
    title: input.title?.trim() || input.workKey,
    narrativeRole: input.narrativeRole?.trim() || "",
    reuseScope: input.reuseScope || "project",
    relatedItemId: input.relatedItemId ?? null,
    relationType: input.relationType ?? null,
    state: input.state || "planned",
    createTime: createdAt,
    updateTime: createdAt,
  });
  return db("o_musicLibraryItem").where("id", id).first();
}

export async function saveMusicLibraryEdition(input: {
  projectId: number;
  libraryItemId: number;
  editionId?: number;
  editionKey: string;
  editionType: MusicEditionType;
  parentEditionId?: number | null;
  title?: string;
  narrativePhase?: string;
  episodeStart?: number | null;
  episodeEnd?: number | null;
  vocalMode?: "instrumental" | "vocal" | "optional";
  language?: string;
  musicSpec?: unknown;
  state?: "planned" | "ready" | "archived";
}) {
  await assertLibraryItem(input.projectId, input.libraryItemId);
  if (input.parentEditionId != null) {
    const parent = await getMusicLibraryEdition(input.projectId, input.parentEditionId);
    if (Number(parent.libraryItemId) !== input.libraryItemId) throw new Error("Parent edition must belong to the same music work");
  }
  const values = {
    projectId: input.projectId,
    libraryItemId: input.libraryItemId,
    parentEditionId: input.parentEditionId ?? null,
    editionKey: input.editionKey.trim(),
    editionType: input.editionType,
    title: input.title?.trim() || input.editionKey,
    narrativePhase: input.narrativePhase?.trim() || "",
    episodeStart: input.episodeStart ?? null,
    episodeEnd: input.episodeEnd ?? null,
    vocalMode: input.vocalMode || "instrumental",
    language: input.language?.trim() || "",
    musicSpecJson: JSON.stringify(input.musicSpec || {}),
    state: input.state || "planned",
    updateTime: now(),
  };
  if (input.editionId != null) {
    const current = await getMusicLibraryEdition(input.projectId, input.editionId);
    if (Number(current.libraryItemId) !== input.libraryItemId) throw new Error("Edition does not belong to this music work");
    await db("o_musicLibraryEdition").where("id", input.editionId).update(values);
    return getMusicLibraryEdition(input.projectId, input.editionId);
  }
  const [id] = await db("o_musicLibraryEdition").insert({ ...values, selectedVersionId: null, createTime: now() });
  return getMusicLibraryEdition(input.projectId, Number(id));
}

export async function saveMusicLyricsVersion(input: {
  projectId: number;
  editionId: number;
  title?: string;
  language?: string;
  content: string;
  source?: "ai" | "user" | "legacy";
  basedOnId?: number | null;
}) {
  const edition = await getMusicLibraryEdition(input.projectId, input.editionId);
  if (input.basedOnId != null) {
    const base = await db("o_musicLyricsVersion").where({ projectId: input.projectId, id: input.basedOnId }).first();
    if (!base || Number(base.editionId) !== Number(edition.id)) throw new Error("Base lyrics version does not belong to this edition");
  }
  const content = input.content.trim();
  if (!content) throw new Error("Lyrics content is required");
  return retryVersionWrite<any>(() =>
    (u.db as any).transaction(async (trx: any) => {
      const version = await nextVersion("o_musicLyricsVersion", { editionId: input.editionId }, trx);
      const createdAt = now();
      const [id] = await trx("o_musicLyricsVersion").insert({
        projectId: input.projectId,
        editionId: input.editionId,
        version,
        title: input.title?.trim() || edition.title || "Lyrics",
        language: input.language?.trim() || edition.language || "",
        content,
        source: input.source || "user",
        basedOnId: input.basedOnId ?? null,
        hash: digest(content),
        state: "draft",
        reviewStatus: "unreviewed",
        createTime: createdAt,
        updateTime: createdAt,
      });
      return trx("o_musicLyricsVersion").where("id", id).first();
    }),
  );
}

export async function listMusicLyricsVersions(input: { projectId: number; editionId: number }) {
  await getMusicLibraryEdition(input.projectId, input.editionId);
  return db("o_musicLyricsVersion").where(input).orderBy("version", "desc");
}

export async function confirmMusicLyricsVersion(input: { projectId: number; editionId: number; lyricsVersionId: number }) {
  const row = await db("o_musicLyricsVersion").where({ projectId: input.projectId, editionId: input.editionId, id: input.lyricsVersionId }).first();
  if (!row) throw new Error("Lyrics version does not exist");
  if (row.reviewStatus === "blocked") throw new Error("This lyrics version has blocking review issues and cannot be confirmed");
  await (u.db as any).transaction(async (trx: any) => {
    await trx("o_musicLyricsVersion").where({ projectId: input.projectId, editionId: input.editionId, state: "confirmed" }).update({ state: "superseded", updateTime: now() });
    await trx("o_musicLyricsVersion").where("id", input.lyricsVersionId).update({ state: "confirmed", updateTime: now() });
  });
  return db("o_musicLyricsVersion").where("id", input.lyricsVersionId).first();
}

export async function saveMusicPromptVersion(input: {
  projectId: number;
  scriptId?: number | null;
  targetType: "cue" | "edition";
  cueId?: number | null;
  editionId?: number | null;
  lyricsVersionId?: number | null;
  model?: string | null;
  promptMode?: MusicPromptMode;
  profileSource?: string | null;
  prompt: string;
  negativePrompt?: string;
  generationConfig?: unknown;
  source?: "ai" | "user" | "legacy";
  basedOnId?: number | null;
  reviewStatus?: "unreviewed" | "passed" | "warning" | "blocked";
}) {
  const promptMode = input.promptMode || "modelSpecific";
  const model = String(input.model || "").trim();
  if (promptMode === "modelSpecific" && !model) throw new Error("A model-specific prompt requires a model");
  if (promptMode === "generic" && model) throw new Error("A generic prompt cannot be bound to a model");
  const profile = promptMode === "modelSpecific" && input.source !== "legacy"
    ? await resolveMusicPromptProfile(model)
    : null;
  if (profile) await resolveMusicModelCapabilities(model);
  const profileSource = profile?.source ?? input.profileSource ?? null;
  if (promptMode === "modelSpecific" && input.source !== "legacy" && input.profileSource && input.profileSource !== profileSource) {
    throw new Error("profileSource must match the configured model prompt profile");
  }
  if (promptMode === "generic" && input.profileSource) throw new Error("A generic prompt cannot have a model profile source");
  let base: any = null;
  if (input.basedOnId != null) {
    base = await db("o_musicPromptVersion").where({ projectId: input.projectId, id: input.basedOnId }).first();
    if (!base) throw new Error("Base prompt version does not exist");
    if (base.targetType !== input.targetType || Number(base.cueId || 0) !== Number(input.cueId || 0) || Number(base.editionId || 0) !== Number(input.editionId || 0)) {
      throw new Error("Base prompt version does not belong to this prompt target");
    }
  }
  const lyricsVersionId = input.lyricsVersionId === undefined ? base?.lyricsVersionId ?? null : input.lyricsVersionId;
  if (input.targetType === "cue") {
    const cue = await u.db("o_musicCue").where({ projectId: input.projectId, id: input.cueId }).first();
    if (!cue) throw new Error("Music cue does not exist");
    if (input.editionId != null || lyricsVersionId != null) throw new Error("Cue prompt versions cannot reference an edition or lyrics version");
  } else if (input.editionId == null) throw new Error("editionId is required");
  else {
    await getMusicLibraryEdition(input.projectId, input.editionId);
    if (input.cueId != null) throw new Error("Edition prompt versions cannot reference a cue");
    if (lyricsVersionId != null) {
      const lyrics = await db("o_musicLyricsVersion").where({ projectId: input.projectId, editionId: input.editionId, id: lyricsVersionId, state: "confirmed" }).first();
      if (!lyrics) throw new Error("Prompt lyrics version must be confirmed and belong to this edition");
      if (lyrics.reviewStatus === "blocked") throw new Error("Prompt lyrics version has blocking review issues");
    }
  }
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Prompt is required");
  const submittedConfig = jsonWithoutLyrics(input.generationConfig, (input.source || "user") === "user");
  const generationConfig = mergeMusicPromptGenerationConfig({
    base,
    promptMode,
    model,
    profileSource,
    submittedConfig,
  });
  if (profile) assertMusicProfileGenerationConfig(profile, generationConfig);
  return retryVersionWrite<any>(() =>
    (u.db as any).transaction(async (trx: any) => {
      const where = input.targetType === "cue" ? { cueId: input.cueId } : { editionId: input.editionId };
      const version = await nextVersion("o_musicPromptVersion", where, trx);
      const createdAt = now();
      await trx("o_musicPromptVersion")
        .where({ projectId: input.projectId, targetType: input.targetType, state: "active" })
        .modify((qb: any) => input.targetType === "cue" ? qb.where("cueId", input.cueId) : qb.where("editionId", input.editionId))
        .update({ state: "superseded", updateTime: createdAt });
      const hashPayload = { promptMode, model, profileSource, prompt, negativePrompt: input.negativePrompt || "", generationConfig, lyricsVersionId };
      const [id] = await trx("o_musicPromptVersion").insert({
        projectId: input.projectId,
        scriptId: input.scriptId ?? null,
        targetType: input.targetType,
        cueId: input.cueId ?? null,
        editionId: input.editionId ?? null,
        lyricsVersionId,
        version,
        model,
        promptMode,
        profileSource,
        prompt,
        negativePrompt: input.negativePrompt?.trim() || "",
        generationConfigJson: JSON.stringify(generationConfig),
        source: input.source || "user",
        basedOnId: input.basedOnId ?? null,
        hash: digest(JSON.stringify(hashPayload)),
        reviewStatus: input.reviewStatus || "unreviewed",
        state: "active",
        createTime: createdAt,
        updateTime: createdAt,
      });
      const row = await trx("o_musicPromptVersion").where("id", id).first();
      return normalizeMusicPromptVersion(row);
    }),
  );
}

export async function getMusicPromptVersion(projectId: number, id: number) {
  const row = await db("o_musicPromptVersion").where({ projectId, id }).first();
  if (!row) throw new Error("Music prompt version does not exist");
  return normalizeMusicPromptVersion(row);
}

export async function listMusicPromptVersions(input: { projectId: number; cueId?: number; editionId?: number }) {
  if (input.cueId == null && input.editionId == null) throw new Error("cueId or editionId is required");
  return db("o_musicPromptVersion")
    .where("projectId", input.projectId)
    .modify((qb: any) => {
      if (input.cueId != null) qb.where("cueId", input.cueId);
      if (input.editionId != null) qb.where("editionId", input.editionId);
    })
    .orderBy("version", "desc")
    .then((rows: any[]) => rows.map(normalizeMusicPromptVersion));
}

function normalizeMusicPromptVersion(row: any) {
  const promptMode: MusicPromptMode = row.promptMode === "generic" ? "generic" : "modelSpecific";
  return {
    ...row,
    promptMode,
    model: promptMode === "generic" ? null : row.model,
    profileSource: row.profileSource ?? null,
    generationConfig: parseJsonValue(row.generationConfigJson, {}),
  };
}

export async function bindMusicCue(input: {
  projectId: number;
  cueId: number;
  usageMode: MusicCueUsageMode;
  editionId?: number | null;
  libraryVersionId?: number | null;
  suggestedUseDurationSec?: number | null;
}) {
  const cue = await u.db("o_musicCue").where({ projectId: input.projectId, id: input.cueId }).first();
  if (!cue) throw new Error("Music cue does not exist");
  if (input.usageMode === "silence" && (input.editionId != null || input.libraryVersionId != null)) throw new Error("Silence cue cannot bind a music version");
  if (input.usageMode !== "silence" && input.editionId == null) throw new Error("Non-silence cue binding requires editionId");
  if (input.editionId != null) await getMusicLibraryEdition(input.projectId, input.editionId);
  if (input.libraryVersionId != null) {
    const version = await getMusicLibraryVersion(input.projectId, input.libraryVersionId);
    if (Number(version.editionId) !== input.editionId) throw new Error("Music version does not belong to the selected edition");
    if (version.state !== "complete") throw new Error("Only a completed music version can be bound to a cue");
  }
  const suggestedUseDurationSec = input.suggestedUseDurationSec ?? cue.estimatedDurationSec ?? cue.durationSec ?? null;
  if (suggestedUseDurationSec != null && (!Number.isInteger(Number(suggestedUseDurationSec)) || Number(suggestedUseDurationSec) <= 0)) {
    throw new Error("suggestedUseDurationSec must be a positive integer");
  }
  const existing = await db("o_musicCueBinding").where("cueId", input.cueId).first();
  const row = {
    projectId: input.projectId,
    scriptId: cue.scriptId ?? null,
    cueId: input.cueId,
    usageMode: input.usageMode,
    editionId: input.usageMode === "silence" ? null : input.editionId ?? null,
    libraryVersionId: input.usageMode === "silence" ? null : input.libraryVersionId ?? null,
    suggestedUseDurationSec,
    state: input.usageMode === "silence" || input.libraryVersionId != null ? "ready" : input.usageMode === "reuse" ? "missing_asset" : "planned",
    updateTime: now(),
  };
  if (existing) await db("o_musicCueBinding").where("id", existing.id).update(row);
  else await db("o_musicCueBinding").insert({ ...row, createTime: now() });
  return db("o_musicCueBinding").where("cueId", input.cueId).first();
}

export async function selectMusicLibraryVersion(input: { projectId: number; editionId: number; libraryVersionId: number }) {
  const edition = await getMusicLibraryEdition(input.projectId, input.editionId);
  const version = await getMusicLibraryVersion(input.projectId, input.libraryVersionId);
  if (Number(version.editionId) !== Number(edition.id) || version.state !== "complete") throw new Error("Only a completed version from this edition can be selected");
  await db("o_musicLibraryEdition").where("id", input.editionId).update({ selectedVersionId: input.libraryVersionId, state: "ready", updateTime: now() });
  await db("o_musicLibraryItem").where("id", edition.libraryItemId).update({ state: "ready", updateTime: now() });
  return getMusicLibraryEdition(input.projectId, input.editionId);
}

export async function ensureLegacyMusicLibraryMigration(projectId: number) {
  const assets = await u.db("o_musicCueAsset").where({ projectId }).orderBy("cueId").orderBy("version");
  for (const asset of assets) {
    let linkedVersion = await db("o_musicLibraryVersion").where({ projectId, legacyCueAssetId: asset.id }).first();
    const canonicalVersion = asset.assetsId == null && asset.childAssetId == null
      ? null
      : await db("o_musicLibraryVersion")
        .where({ projectId, assetsId: asset.assetsId, childAssetId: asset.childAssetId })
        .whereNot("derivationType", "legacy")
        .orderBy("id", "asc")
        .first();

    if (linkedVersion && canonicalVersion && Number(linkedVersion.id) !== Number(canonicalVersion.id)) {
      const duplicateEditionId = Number(linkedVersion.editionId);
      await (u.db as any).transaction(async (trx: any) => {
        await trx("o_musicLibraryVersion").where("id", linkedVersion.id).update({ legacyCueAssetId: null, updateTime: now() });
        if (canonicalVersion.legacyCueAssetId == null) {
          await trx("o_musicLibraryVersion").where("id", canonicalVersion.id).update({ legacyCueAssetId: asset.id, updateTime: now() });
        }
        await trx("o_musicCueBinding").where({ projectId, cueId: asset.cueId, libraryVersionId: linkedVersion.id }).update({
          editionId: canonicalVersion.editionId,
          libraryVersionId: canonicalVersion.id,
          state: canonicalVersion.state === "complete" ? "ready" : "missing_asset",
          updateTime: now(),
        });
        const sourceReference = await trx("o_musicLibraryVersion").where("sourceVersionId", linkedVersion.id).first("id");
        const bindingReference = await trx("o_musicCueBinding").where("libraryVersionId", linkedVersion.id).first("id");
        if (!sourceReference && !bindingReference) await trx("o_musicLibraryVersion").where("id", linkedVersion.id).del();
      });
      if (asset.selected && canonicalVersion.state === "complete") {
        await selectMusicLibraryVersion({ projectId, editionId: Number(canonicalVersion.editionId), libraryVersionId: Number(canonicalVersion.id) });
      }
      const duplicateEdition = await db("o_musicLibraryEdition").where({ projectId, id: duplicateEditionId }).first();
      if (duplicateEdition && !(await db("o_musicLibraryVersion").where("editionId", duplicateEditionId).first("id"))) {
        await db("o_musicLibraryEdition").where("id", duplicateEditionId).del();
        if (!(await db("o_musicLibraryEdition").where("libraryItemId", duplicateEdition.libraryItemId).first("id"))) {
          await db("o_musicLibraryItem").where({ projectId, id: duplicateEdition.libraryItemId, workKey: `legacy-cue-${asset.cueId}` }).del();
        }
      }
      linkedVersion = canonicalVersion;
    }

    if (!linkedVersion && canonicalVersion) {
      if (canonicalVersion.legacyCueAssetId == null) {
        await db("o_musicLibraryVersion").where("id", canonicalVersion.id).update({ legacyCueAssetId: asset.id, updateTime: now() });
      }
      linkedVersion = canonicalVersion;
    }

    if (linkedVersion) {
      const currentBinding = await db("o_musicCueBinding").where({ projectId, cueId: asset.cueId }).first();
      if (asset.selected && linkedVersion.state === "complete") {
        await selectMusicLibraryVersion({ projectId, editionId: Number(linkedVersion.editionId), libraryVersionId: Number(linkedVersion.id) });
      }
      if (asset.selected || !currentBinding) {
        await bindMusicCue({
          projectId,
          cueId: Number(asset.cueId),
          usageMode: "reuse",
          editionId: Number(linkedVersion.editionId),
          libraryVersionId: linkedVersion.state === "complete" ? Number(linkedVersion.id) : null,
        });
      }
      continue;
    }

    const cue = await u.db("o_musicCue").where({ projectId, id: asset.cueId }).first();
    if (!cue) continue;
    const workKey = `legacy-cue-${cue.id}`;
    let item = await db("o_musicLibraryItem").where({ projectId, workKey }).first();
    if (!item) item = await createMusicLibraryItem({ projectId, workKey, workType: "score_theme", title: cue.title || cue.cueKey, narrativeRole: cue.narrativePurpose || "Legacy cue", state: "ready" });
    let edition = await db("o_musicLibraryEdition").where({ libraryItemId: item.id, editionKey: "legacy" }).first();
    if (!edition) edition = await saveMusicLibraryEdition({ projectId, libraryItemId: item.id, editionKey: "legacy", editionType: "master", title: cue.title || cue.cueKey, musicSpec: parseJsonValue(cue.musicSpecJson, {}), state: "ready" });
    let promptVersionId: number | null = null;
    if (asset.prompt) {
      const prompt = await saveMusicPromptVersion({ projectId, scriptId: cue.scriptId, targetType: "cue", cueId: cue.id, model: asset.model || "legacy:unknown", prompt: asset.prompt, generationConfig: parseJsonValue(asset.compiledPromptJson, {}), source: "legacy", reviewStatus: "passed" });
      promptVersionId = Number(prompt.id);
    }
    const generationConfig = parseJsonValue(asset.compiledPromptJson, {});
    const promptHash = promptVersionId == null ? null : (await getMusicPromptVersion(projectId, promptVersionId)).hash;
    await db("o_musicLibraryVersion").insert({
      projectId,
      editionId: edition.id,
      version: asset.version,
      promptVersionId,
      lyricsVersionId: null,
      promptHash,
      lyricsHash: null,
      generationConfigHash: digest(JSON.stringify(generationConfig)),
      assetsId: asset.assetsId,
      childAssetId: asset.childAssetId,
      model: asset.model || "",
      generationConfigJson: JSON.stringify(generationConfig),
      generationDurationSec: cue.durationSec ?? null,
      effectiveMusicDurationSec: cue.durationSec ?? null,
      derivationType: "legacy",
      sourceVersionId: null,
      legacyCueAssetId: asset.id,
      trimStartMs: null,
      trimEndMs: null,
      fadeInMs: null,
      fadeOutMs: null,
      state: asset.state,
      errorReason: asset.errorReason || null,
      createTime: asset.createTime || now(),
      updateTime: asset.updateTime || now(),
    });
    const libraryVersion = await db("o_musicLibraryVersion").where("legacyCueAssetId", asset.id).first();
    if (asset.selected || !(await db("o_musicCueBinding").where("cueId", cue.id).first())) {
      if (asset.state === "complete") await selectMusicLibraryVersion({ projectId, editionId: edition.id, libraryVersionId: libraryVersion.id });
      await bindMusicCue({ projectId, cueId: Number(cue.id), usageMode: "reuse", editionId: edition.id, libraryVersionId: asset.state === "complete" ? libraryVersion.id : null });
    }
  }
}

export async function listMusicLibrary(input: { projectId: number; state?: string; workType?: string }) {
  await ensureLegacyMusicLibraryMigration(input.projectId);
  const items = await db("o_musicLibraryItem")
    .where("projectId", input.projectId)
    .modify((qb: any) => {
      if (input.state) qb.where("state", input.state);
      if (input.workType) qb.where("workType", input.workType);
    })
    .orderBy("id", "asc");
  return Promise.all(items.map((item: any) => getMusicLibraryDetail({ projectId: input.projectId, libraryItemId: item.id })));
}

export async function getMusicLibraryDetail(input: { projectId: number; libraryItemId: number }) {
  const item = await assertLibraryItem(input.projectId, input.libraryItemId);
  const editions = await db("o_musicLibraryEdition").where({ projectId: input.projectId, libraryItemId: item.id }).orderBy("id", "asc");
  return {
    ...item,
    editions: await Promise.all(
      editions.map(async (edition: any) => {
        const versions = await db("o_musicLibraryVersion").where({ projectId: input.projectId, editionId: edition.id }).orderBy("version", "desc");
        return {
          ...edition,
          musicSpec: parseJsonValue(edition.musicSpecJson, {}),
          lyricsVersions: await db("o_musicLyricsVersion").where({ projectId: input.projectId, editionId: edition.id }).orderBy("version", "desc"),
          versions: await Promise.all(
            versions.map(async (version: any) => ({
              ...version,
              generationConfig: parseJsonValue(version.generationConfigJson, {}),
              audioAsset: version.assetsId ? await getAudioAssetResponse(Number(version.assetsId)) : null,
            })),
          ),
        };
      }),
    ),
  };
}

export async function createMusicLibraryVersion(input: {
  projectId: number;
  editionId: number;
  promptVersionId?: number | null;
  lyricsVersionId?: number | null;
  model?: string;
  generationConfig?: unknown;
  generationDurationSec?: number | null;
  effectiveMusicDurationSec?: number | null;
  derivationType?: "generated" | "trimmed" | "legacy";
  sourceVersionId?: number | null;
  trimStartMs?: number | null;
  trimEndMs?: number | null;
  fadeInMs?: number | null;
  fadeOutMs?: number | null;
  state?: "generating" | "complete" | "failed";
}) {
  const targetEdition = await getMusicLibraryEdition(input.projectId, input.editionId);
  const source = input.sourceVersionId == null ? null : await getMusicLibraryVersion(input.projectId, input.sourceVersionId);
  const isTrimmedDerivative = input.derivationType === "trimmed" && source != null;
  const prompt = input.promptVersionId == null ? null : await getMusicPromptVersion(input.projectId, input.promptVersionId);
  if (prompt && prompt.targetType === "edition" && Number(prompt.editionId) !== input.editionId && !(isTrimmedDerivative && Number(source.promptVersionId || 0) === Number(prompt.id))) {
    throw new Error("Music prompt version does not belong to this edition");
  }
  const lyrics = input.lyricsVersionId == null
    ? null
    : await db("o_musicLyricsVersion").where({ projectId: input.projectId, id: input.lyricsVersionId }).first();
  if (input.lyricsVersionId != null && (!lyrics || (Number(lyrics.editionId) !== input.editionId && !(isTrimmedDerivative && Number(source.lyricsVersionId || 0) === Number(input.lyricsVersionId))))) {
    throw new Error("Music lyrics version does not belong to this edition or source derivative");
  }
  if (source) {
    const sourceEdition = await getMusicLibraryEdition(input.projectId, Number(source.editionId));
    if (Number(sourceEdition.libraryItemId) !== Number(targetEdition.libraryItemId)) {
      throw new Error("Derived music versions must remain in the same music work");
    }
  }
  const generationConfig = jsonWithoutLyrics(input.generationConfig, false);
  return retryVersionWrite<any>(() =>
    (u.db as any).transaction(async (trx: any) => {
      const version = await nextVersion("o_musicLibraryVersion", { editionId: input.editionId }, trx);
      const createdAt = now();
      const [id] = await trx("o_musicLibraryVersion").insert({
        projectId: input.projectId,
        editionId: input.editionId,
        version,
        promptVersionId: input.promptVersionId ?? null,
        lyricsVersionId: input.lyricsVersionId ?? null,
        promptHash: prompt?.hash ?? null,
        lyricsHash: lyrics?.hash ?? null,
        generationConfigHash: digest(JSON.stringify(generationConfig)),
        assetsId: null,
        childAssetId: null,
        model: input.model || "",
        generationConfigJson: JSON.stringify(generationConfig),
        generationDurationSec: input.generationDurationSec ?? null,
        effectiveMusicDurationSec: input.effectiveMusicDurationSec ?? null,
        derivationType: input.derivationType || "generated",
        sourceVersionId: input.sourceVersionId ?? null,
        legacyCueAssetId: null,
        trimStartMs: input.trimStartMs ?? null,
        trimEndMs: input.trimEndMs ?? null,
        fadeInMs: input.fadeInMs ?? null,
        fadeOutMs: input.fadeOutMs ?? null,
        state: input.state || "generating",
        errorReason: null,
        createTime: createdAt,
        updateTime: createdAt,
      });
      const row = await trx("o_musicLibraryVersion").where("id", id).first();
      return { ...row, generationConfig: parseJsonValue(row.generationConfigJson, {}) };
    }),
  );
}
