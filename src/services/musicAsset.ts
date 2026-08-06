import u from "@/utils";
import { loadCompiledMusicPromptVersion } from "@/services/musicCueCompiler";
import { parseJsonValue } from "@/services/musicDirector";
import { getAudioAssetResponse } from "@/services/audioAssetResponse";
import { inspectGeneratedMusicFile } from "@/services/musicAudioMetadata";
import {
  bindMusicCue,
  createMusicLibraryItem,
  createMusicLibraryVersion,
  ensureLegacyMusicLibraryMigration,
  getMusicLibraryEdition,
  getMusicLibraryVersion,
  saveMusicLibraryEdition,
  selectMusicLibraryVersion,
} from "@/services/musicLibrary";
import {
  buildMusicProviderRequest,
  resolveMusicModelCapabilities,
} from "@/services/musicModelCapability";
import type { MusicOutputCandidate } from "@/utils/ai";
import { musicRequestCheck } from "@/utils/ai";

function now() {
  return Date.now();
}

function normalizeExt(value: unknown) {
  const ext = String(value || "mp3")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return ext || "mp3";
}

export function assertMusicPromptGenerationAllowed(reviewStatus: unknown, acknowledgeWarnings = false) {
  if (reviewStatus === "warning" && acknowledgeWarnings !== true) {
    throw new Error("This prompt has review warnings; acknowledgeWarnings=true is required to generate it");
  }
  if (reviewStatus !== "passed" && reviewStatus !== "warning") {
    throw new Error("The exact prompt version must pass review before generation");
  }
}

async function nextCueAssetVersion(cueId: number) {
  const row = (await u.db("o_musicCueAsset").where({ cueId }).max("version as version").first()) as any;
  return Number(row?.version || 0) + 1;
}

export async function persistAudioAsset(input: {
  projectId: number;
  scriptId?: number | null;
  name: string;
  describe?: string;
  prompt: string;
  savePath: string;
  outputFormat: string;
}, executor?: any) {
  const persist = async (trx: any) => {
    const [parentAssetId] = await trx("o_assets").insert({
      name: input.name,
      describe: input.describe || "",
      type: "audio",
      projectId: input.projectId,
      scriptId: input.scriptId ?? null,
      startTime: now(),
    });
    const [childAssetId] = await trx("o_assets").insert({
      prompt: input.prompt,
      assetsId: parentAssetId,
      type: "audio",
      describe: input.describe || "",
      name: `${input.name}.${input.outputFormat}`,
      projectId: input.projectId,
      scriptId: input.scriptId ?? null,
      startTime: now(),
    });
    const [imageId] = await trx("o_image").insert({ filePath: input.savePath, type: "audio", assetsId: childAssetId, state: "complete" });
    await trx("o_assets").where("id", childAssetId).update({ imageId });
    return { parentAssetId: Number(parentAssetId), childAssetId: Number(childAssetId) };
  };
  return executor ? persist(executor) : u.db.transaction(persist);
}

async function generateIntoLibrary(input: {
  projectId: number;
  editionId: number;
  promptVersionId: number;
  model: string;
  lyricsVersionId?: number | null;
  scriptId?: number | null;
  name: string;
  describe?: string;
  acknowledgeWarnings?: boolean;
}) {
  const edition = await getMusicLibraryEdition(input.projectId, input.editionId);
  const promptVersion = await loadCompiledMusicPromptVersion(input.projectId, input.promptVersionId);
  assertMusicPromptGenerationAllowed(promptVersion.reviewStatus, input.acknowledgeWarnings);
  if (promptVersion.targetType === "edition" && Number(promptVersion.editionId) !== input.editionId) throw new Error("Prompt version does not belong to this edition");
  if (input.lyricsVersionId != null && Number(promptVersion.lyricsVersionId || 0) !== Number(input.lyricsVersionId)) {
    throw new Error("Generation lyrics version must match the reviewed prompt version");
  }
  const lyricsVersionId = promptVersion.lyricsVersionId == null ? null : Number(promptVersion.lyricsVersionId);
  const lyrics = lyricsVersionId == null
    ? null
    : await (u.db as any)("o_musicLyricsVersion").where({ projectId: input.projectId, editionId: input.editionId, id: lyricsVersionId, state: "confirmed" }).first();
  if (lyricsVersionId != null && !lyrics) throw new Error("The prompt's confirmed lyrics version no longer exists");
  if (lyrics?.reviewStatus === "blocked") throw new Error("The prompt's lyrics version has blocking review issues");
  if (edition.vocalMode === "vocal" && !lyrics) throw new Error("A confirmed lyrics version is required for vocal music");
  const capabilities = await resolveMusicModelCapabilities(input.model);
  const generationConfig = parseJsonValue<Record<string, any>>(promptVersion.generationConfigJson, {});
  const configuredDuration = Number(generationConfig.durationSec ?? generationConfig.duration);
  const durationSec = capabilities.durationParameter && Number.isInteger(configuredDuration) && configuredDuration > 0
    ? configuredDuration
    : undefined;
  const effectiveMusicDurationSec = Number(generationConfig.effectiveMusicDurationSec || durationSec || 0);
  const outputFormat = normalizeExt(generationConfig.outputFormat || generationConfig.format || capabilities.outputFormats[0] || "mp3");
  const request = buildMusicProviderRequest({
    config: { ...generationConfig, ...(durationSec == null ? {} : { durationSec }), outputFormat },
    prompt: promptVersion.prompt,
    negativePrompt: promptVersion.negativePrompt,
    lyrics: lyrics?.content,
    vocalMode: edition.vocalMode,
    durationParameter: capabilities.durationParameter,
  });
  const contract = await musicRequestCheck(input.model as `${string}:${string}`, request);
  if (contract.issues.length) throw new Error(contract.issues.map((issue) => issue.message).join("; "));
  const createCandidateVersion = () => createMusicLibraryVersion({
    projectId: input.projectId,
    editionId: input.editionId,
    promptVersionId: input.promptVersionId,
    lyricsVersionId,
    model: input.model,
    generationConfig,
    generationDurationSec: durationSec ?? null,
    effectiveMusicDurationSec: effectiveMusicDurationSec || null,
  });
  // Retain a failed version if the provider request itself cannot yield any candidate.
  const firstLibraryVersion = await createCandidateVersion();
  try {
    const ai = await u.Ai.Music(input.model as `${string}:${string}`).run(request as any);
    const candidates = ai.getCandidates();
    const versions: any[] = [];
    const audioAssets: any[] = [];
    const failedCandidates: Array<{ providerId?: string; error: string }> = [];
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index] as MusicOutputCandidate;
      const libraryVersion = index === 0 ? firstLibraryVersion : await createCandidateVersion();
      if (!candidate.data) {
        const message = candidate.error || "Music provider candidate did not return audio data";
        await (u.db as any)("o_musicLibraryVersion").where("id", libraryVersion.id).update({ state: "failed", errorReason: message, updateTime: now() });
        failedCandidates.push({ providerId: candidate.providerId, error: message });
        continue;
      }
      let pendingSavePath = "";
      let mediaPersisted = false;
      try {
        const savePath = `/${input.projectId}/assets/audio/${u.uuid()}.${outputFormat}`;
        pendingSavePath = savePath;
        await ai.saveCandidate(savePath, candidate);
        const localFilePath = await u.oss.getLocalFilePath(savePath);
        const inspected = await inspectGeneratedMusicFile({
          filePath: localFilePath,
          model: input.model,
          maxDurationSec: capabilities.durationRange.max,
        });
        const persisted = await persistAudioAsset({
          projectId: input.projectId,
          scriptId: input.scriptId,
          name: `${input.name}-v${libraryVersion.version}`,
          describe: input.describe,
          prompt: promptVersion.prompt,
          savePath,
          outputFormat,
        });
        mediaPersisted = true;
        await (u.db as any)("o_musicLibraryVersion").where("id", libraryVersion.id).update({
          assetsId: persisted.parentAssetId,
          childAssetId: persisted.childAssetId,
          generationDurationSec: inspected.durationSec,
          state: "complete",
          updateTime: now(),
        });
        versions.push(await getMusicLibraryVersion(input.projectId, Number(libraryVersion.id)));
        audioAssets.push(await getAudioAssetResponse(persisted.parentAssetId));
      } catch (error) {
        if (pendingSavePath && !mediaPersisted && await u.oss.fileExists(pendingSavePath)) {
          await u.oss.deleteFile(pendingSavePath).catch(() => {});
        }
        const message = u.error(error).message;
        await (u.db as any)("o_musicLibraryVersion").where("id", libraryVersion.id).update({ state: "failed", errorReason: message, updateTime: now() });
        failedCandidates.push({ providerId: candidate.providerId, error: message });
      }
    }
    if (!versions.length) throw new Error(failedCandidates.map((candidate) => candidate.error).join("; ") || "Music provider did not return a usable audio candidate");
    return {
      libraryVersion: versions[0],
      audioAsset: audioAssets[0],
      libraryVersions: versions,
      audioAssets,
      failedCandidates,
      promptVersion,
    };
  } catch (error) {
    await (u.db as any)("o_musicLibraryVersion").where("id", firstLibraryVersion.id).whereNot("state", "complete").update({ state: "failed", errorReason: u.error(error).message, updateTime: now() });
    throw error;
  }
}

export async function generateMusicLibraryAsset(input: {
  projectId: number;
  editionId: number;
  promptVersionId: number;
  model: string;
  lyricsVersionId?: number | null;
  acknowledgeWarnings?: boolean;
}) {
  const edition = await getMusicLibraryEdition(input.projectId, input.editionId);
  const item = await (u.db as any)("o_musicLibraryItem").where({ projectId: input.projectId, id: edition.libraryItemId }).first();
  if (!item) throw new Error("Music library item does not exist");
  const prompt = await loadCompiledMusicPromptVersion(input.projectId, input.promptVersionId);
  if (prompt.targetType !== "edition" || Number(prompt.editionId) !== input.editionId) throw new Error("Edition generation requires a prompt version compiled for this edition");
  return generateIntoLibrary({
    projectId: input.projectId,
    editionId: input.editionId,
    promptVersionId: input.promptVersionId,
    model: input.model,
    lyricsVersionId: input.lyricsVersionId,
    acknowledgeWarnings: input.acknowledgeWarnings,
    name: item.title || item.workKey,
    describe: item.narrativeRole || "",
  });
}

export async function generateMusicCueAsset(input: {
  projectId: number;
  cueId: number;
  model: string;
  select?: boolean;
  taskCenterId?: number;
  promptVersionId: number;
  acknowledgeWarnings?: boolean;
}) {
  const cue = await u.db("o_musicCue").where({ projectId: input.projectId, id: input.cueId }).first();
  if (!cue) throw new Error("Music cue does not exist");
  const binding = await (u.db as any)("o_musicCueBinding").where("cueId", input.cueId).first();
  if (binding?.usageMode === "silence" || cue.cueType === "silence") throw new Error("Silence cue cannot generate audio");
  try {
    const promptVersionId = Number(input.promptVersionId);
    const promptVersion = await loadCompiledMusicPromptVersion(input.projectId, promptVersionId);
    if (promptVersion.targetType !== "cue" || Number(promptVersion.cueId) !== input.cueId) throw new Error("Prompt version does not belong to this cue");
    let editionId = Number(binding?.editionId || 0);
    if (!editionId) {
      const workKey = `cue-${cue.id}`;
      const item = await (u.db as any)("o_musicLibraryItem").where({ projectId: input.projectId, workKey }).first()
        || await createMusicLibraryItem({ projectId: input.projectId, workKey, workType: "score_theme", title: cue.title || cue.cueKey || `Music cue ${cue.id}`, narrativeRole: cue.narrativePurpose || "", reuseScope: "project", state: "planned" });
      const edition = await (u.db as any)("o_musicLibraryEdition").where({ libraryItemId: item.id, editionKey: "master" }).first()
        || await saveMusicLibraryEdition({ projectId: input.projectId, libraryItemId: Number(item.id), editionKey: "master", editionType: "master", title: cue.title || cue.cueKey || "Master", musicSpec: parseJsonValue(cue.musicSpecJson, {}), state: "planned" });
      editionId = Number(edition.id);
    }
    const generated = await generateIntoLibrary({
      projectId: input.projectId,
      editionId,
      promptVersionId,
      model: input.model,
      scriptId: cue.scriptId,
      name: cue.title || cue.cueKey || `Music cue ${cue.id}`,
      describe: cue.narrativePurpose || "",
      acknowledgeWarnings: input.acknowledgeWarnings,
    });
    if (!binding || Number(binding.editionId || 0) !== editionId) {
      await bindMusicCue({ projectId: input.projectId, cueId: input.cueId, usageMode: "new", editionId, libraryVersionId: null });
    }
    const shouldSelect = input.select === true;
    const musicCueAssets: any[] = [];
    for (const [index, libraryVersion] of generated.libraryVersions.entries()) {
      const version = await nextCueAssetVersion(input.cueId);
      const selected = shouldSelect && index === 0;
      const [musicCueAssetId] = await u.db("o_musicCueAsset").insert({
        projectId: input.projectId,
        cueId: input.cueId,
        version,
        assetsId: libraryVersion.assetsId,
        childAssetId: libraryVersion.childAssetId,
        prompt: promptVersion.prompt,
        compiledPromptJson: JSON.stringify({ prompt: promptVersion.prompt, negativePrompt: promptVersion.negativePrompt, generationConfig: promptVersion.generationConfig, promptVersionId }),
        model: input.model,
        state: "complete",
        selected: selected ? 1 : 0,
        createTime: now(),
        updateTime: now(),
      });
      await (u.db as any)("o_musicLibraryVersion").where("id", libraryVersion.id).update({ legacyCueAssetId: musicCueAssetId, updateTime: now() });
      musicCueAssets.push(await u.db("o_musicCueAsset").where("id", musicCueAssetId).first());
    }
    const musicCueAsset = musicCueAssets[0];
    if (shouldSelect) await u.db("o_musicCueAsset").where({ projectId: input.projectId, cueId: input.cueId }).whereNot("id", musicCueAsset.id).update({ selected: 0, updateTime: now() });
    if (shouldSelect) {
      await selectMusicLibraryVersion({ projectId: input.projectId, editionId, libraryVersionId: Number(generated.libraryVersions[0].id) });
      await bindMusicCue({ projectId: input.projectId, cueId: input.cueId, usageMode: "new", editionId, libraryVersionId: Number(generated.libraryVersions[0].id) });
    }
    return {
      musicCueAsset,
      libraryVersion: generated.libraryVersion,
      audioAsset: generated.audioAsset,
      musicCueAssets,
      libraryVersions: generated.libraryVersions,
      audioAssets: generated.audioAssets,
      failedCandidates: generated.failedCandidates,
      promptVersionId,
    };
  } catch (error) {
    throw error;
  }
}

export async function selectMusicCueAsset(input: { projectId: number; cueId: number; musicCueAssetId: number }) {
  const asset = await u
    .db("o_musicCueAsset")
    .where({ projectId: input.projectId, cueId: input.cueId, id: input.musicCueAssetId })
    .first();
  if (!asset) throw new Error("Music cue asset does not exist");
  if (asset.state !== "complete") throw new Error("Only completed music cue assets can be selected");
  await ensureLegacyMusicLibraryMigration(input.projectId);
  const libraryVersion = await (u.db as any)("o_musicLibraryVersion").where({ projectId: input.projectId, legacyCueAssetId: input.musicCueAssetId, state: "complete" }).first();
  if (!libraryVersion) throw new Error("Music cue asset is not linked to a completed music library version");
  await u.db.transaction(async (trx: any) => {
    await trx("o_musicCueAsset").where({ projectId: input.projectId, cueId: input.cueId }).update({ selected: 0, updateTime: now() });
    await trx("o_musicCueAsset").where("id", input.musicCueAssetId).update({ selected: 1, updateTime: now() });
  });
  await selectMusicLibraryVersion({ projectId: input.projectId, editionId: Number(libraryVersion.editionId), libraryVersionId: Number(libraryVersion.id) });
  const binding = await (u.db as any)("o_musicCueBinding").where({ projectId: input.projectId, cueId: input.cueId }).first();
  await bindMusicCue({
    projectId: input.projectId,
    cueId: input.cueId,
    usageMode: binding?.usageMode === "reuse" ? "reuse" : "new",
    editionId: Number(libraryVersion.editionId),
    libraryVersionId: Number(libraryVersion.id),
  });
  return u.db("o_musicCueAsset").where("id", input.musicCueAssetId).first();
}
