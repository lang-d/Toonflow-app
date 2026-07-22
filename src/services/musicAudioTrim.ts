import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import u from "@/utils";
import { persistAudioAsset } from "@/services/musicAsset";
import { probeAudioDurationMs } from "@/services/musicAudioMetadata";
import {
  createMusicLibraryVersion,
  getMusicLibraryEdition,
  getMusicLibraryVersion,
  saveMusicLibraryEdition,
} from "@/services/musicLibrary";
import { isSafeMediaFilePath, resolveMediaFilePath } from "@/services/storagePaths";

const runFile = promisify(execFile);
const localRequire = createRequire(typeof __filename === "string" ? __filename : path.resolve(process.cwd(), "package.json"));

function unpackedExecutablePath(value: unknown) {
  const resolved = String(value || "").replace(/([\\/])app\.asar([\\/])/i, "$1app.asar.unpacked$2");
  if (!resolved || !fsSync.existsSync(resolved)) throw new Error("Audio trim runtime is unavailable: packaged executable is missing");
  return resolved;
}

function ffmpegPath() {
  const ffmpeg = unpackedExecutablePath(localRequire("ffmpeg-static"));
  return ffmpeg;
}

export { probeAudioDurationMs } from "@/services/musicAudioMetadata";

export async function trimMusicLibraryVersion(input: {
  projectId: number;
  sourceLibraryVersionId: number;
  startMs: number;
  endMs: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  title: string;
  bindCueId?: number | null;
  select?: boolean;
}) {
  const source = await getMusicLibraryVersion(input.projectId, input.sourceLibraryVersionId);
  if (source.state !== "complete" || !source.childAssetId) throw new Error("Only a completed music version can be trimmed");
  const sourceAsset = await u.db("o_assets").where({ projectId: input.projectId, id: source.childAssetId, type: "audio" }).first();
  const media = sourceAsset?.imageId ? await u.db("o_image").where({ id: sourceAsset.imageId, assetsId: sourceAsset.id, state: "complete" }).first() : null;
  if (!media?.filePath) throw new Error("Source audio file does not exist");
  const sourcePath = await u.oss.getLocalFilePath(media.filePath);
  const sourceDurationMs = await probeAudioDurationMs(sourcePath);
  const startMs = Math.floor(Number(input.startMs));
  const endMs = Math.floor(Number(input.endMs));
  const fadeInMs = Math.floor(Number(input.fadeInMs || 0));
  const fadeOutMs = Math.floor(Number(input.fadeOutMs || 0));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) throw new Error("Invalid audio trim range");
  if (!Number.isFinite(fadeInMs) || !Number.isFinite(fadeOutMs) || fadeInMs < 0 || fadeOutMs < 0) throw new Error("Fade durations must be non-negative integers");
  if (endMs > sourceDurationMs + 50) throw new Error(`Trim end ${endMs}ms exceeds source duration ${sourceDurationMs}ms`);
  const outputDurationMs = endMs - startMs;
  if (fadeInMs + fadeOutMs > outputDurationMs) throw new Error("Fade durations exceed the trimmed audio duration");
  if (!String(input.title || "").trim()) throw new Error("A title is required for the trimmed music edition");
  const bindCue = input.bindCueId == null ? null : await u.db("o_musicCue").where({ projectId: input.projectId, id: input.bindCueId }).first();
  if (input.bindCueId != null && !bindCue) throw new Error("The cue selected for binding does not belong to this project");
  const sourceEdition = await getMusicLibraryEdition(input.projectId, Number(source.editionId));
  const editionKey = `short-${Date.now()}-${u.uuid().slice(0, 8)}`;
  const edition = await saveMusicLibraryEdition({
    projectId: input.projectId,
    libraryItemId: Number(sourceEdition.libraryItemId),
    parentEditionId: Number(sourceEdition.id),
    editionKey,
    editionType: "short_edit",
    title: input.title,
    narrativePhase: sourceEdition.narrativePhase,
    vocalMode: sourceEdition.vocalMode,
    language: sourceEdition.language,
    musicSpec: sourceEdition.musicSpec,
    state: "planned",
  });
  const derived = await createMusicLibraryVersion({
    projectId: input.projectId,
    editionId: Number(edition.id),
    promptVersionId: source.promptVersionId,
    lyricsVersionId: source.lyricsVersionId,
    model: source.model,
    generationConfig: source.generationConfig,
    generationDurationSec: Math.ceil(outputDurationMs / 1000),
    effectiveMusicDurationSec: Math.ceil(outputDurationMs / 1000),
    derivationType: "trimmed",
    sourceVersionId: Number(source.id),
    trimStartMs: startMs,
    trimEndMs: endMs,
    fadeInMs,
    fadeOutMs,
  });
  const relativePath = `/${input.projectId}/assets/audio/${u.uuid()}.wav`;
  const outputPath = resolveMediaFilePath(relativePath);
  if (!isSafeMediaFilePath(outputPath)) throw new Error("Invalid derived audio output path");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const durationSec = outputDurationMs / 1000;
  const filters: string[] = [];
  if (fadeInMs > 0) filters.push(`afade=t=in:st=0:d=${fadeInMs / 1000}`);
  if (fadeOutMs > 0) filters.push(`afade=t=out:st=${Math.max(0, (outputDurationMs - fadeOutMs) / 1000)}:d=${fadeOutMs / 1000}`);
  const args = ["-hide_banner", "-loglevel", "error", "-ss", String(startMs / 1000), "-i", sourcePath, "-t", String(durationSec)];
  if (filters.length) args.push("-af", filters.join(","));
  args.push("-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-y", outputPath);
  try {
    await runFile(ffmpegPath(), args, { maxBuffer: 4 * 1024 * 1024 });
    const actualDurationMs = await probeAudioDurationMs(outputPath);
    if (Math.abs(actualDurationMs - outputDurationMs) > 50) throw new Error(`Trimmed audio duration mismatch: expected ${outputDurationMs}ms, got ${actualDurationMs}ms`);
    const finalized = await (u.db as any).transaction(async (trx: any) => {
      const persisted = await persistAudioAsset({
        projectId: input.projectId,
        scriptId: bindCue?.scriptId ?? null,
        name: `${input.title}-v${derived.version}`,
        describe: `Derived from music library version ${source.id}, ${startMs}-${endMs}ms`,
        prompt: "",
        savePath: relativePath,
        outputFormat: "wav",
      }, trx);
      const completedAt = Date.now();
      await trx("o_musicLibraryVersion").where({ projectId: input.projectId, id: derived.id, state: "generating" }).update({
        assetsId: persisted.parentAssetId,
        childAssetId: persisted.childAssetId,
        state: "complete",
        updateTime: completedAt,
      });
      if (input.select === true) {
        await trx("o_musicLibraryEdition").where({ projectId: input.projectId, id: edition.id }).update({ selectedVersionId: derived.id, state: "ready", updateTime: completedAt });
        await trx("o_musicLibraryItem").where({ projectId: input.projectId, id: sourceEdition.libraryItemId }).update({ state: "ready", updateTime: completedAt });
      }
      let bindingId: number | null = null;
      if (bindCue) {
        const binding = await trx("o_musicCueBinding").where({ projectId: input.projectId, cueId: bindCue.id }).first();
        const values = {
          projectId: input.projectId,
          scriptId: bindCue.scriptId ?? null,
          cueId: bindCue.id,
          usageMode: "reuse",
          editionId: edition.id,
          libraryVersionId: derived.id,
          suggestedUseDurationSec: Math.ceil(outputDurationMs / 1000),
          state: "ready",
          updateTime: completedAt,
        };
        if (binding) {
          await trx("o_musicCueBinding").where("id", binding.id).update(values);
          bindingId = Number(binding.id);
        } else {
          const [id] = await trx("o_musicCueBinding").insert({ ...values, createTime: completedAt });
          bindingId = Number(id);
        }
      }
      return { ...persisted, bindingId };
    });
    return {
      libraryItemId: Number(sourceEdition.libraryItemId),
      editionId: Number(edition.id),
      libraryVersionId: Number(derived.id),
      assetsId: finalized.parentAssetId,
      childAssetId: finalized.childAssetId,
      durationMs: actualDurationMs,
      bindingId: finalized.bindingId,
    };
  } catch (error) {
    await fs.unlink(outputPath).catch(() => undefined);
    await (u.db as any)("o_musicLibraryVersion").where("id", derived.id).update({ state: "failed", errorReason: u.error(error).message, updateTime: Date.now() });
    throw error;
  }
}
