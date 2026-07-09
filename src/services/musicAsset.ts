import u from "@/utils";
import { compileMusicCuePrompt } from "@/services/musicCueCompiler";
import { parseJsonValue } from "@/services/musicDirector";
import { getAudioAssetResponse } from "@/services/audioAssetResponse";

function now() {
  return Date.now();
}

function normalizeExt(value: unknown) {
  const ext = String(value || "mp3")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return ext || "mp3";
}

async function nextCueAssetVersion(cueId: number) {
  const row = (await u.db("o_musicCueAsset").where({ cueId }).max("version as version").first()) as any;
  return Number(row?.version || 0) + 1;
}

export async function generateMusicCueAsset(input: {
  projectId: number;
  cueId: number;
  model: string;
  instruction?: string;
  select?: boolean;
  taskCenterId?: number;
}) {
  const cue = await u.db("o_musicCue").where({ projectId: input.projectId, id: input.cueId }).first();
  if (!cue) throw new Error("Music cue does not exist");
  const version = await nextCueAssetVersion(input.cueId);
  const createdAt = now();
  const [musicCueAssetId] = await u.db("o_musicCueAsset").insert({
    projectId: input.projectId,
    cueId: input.cueId,
    version,
    prompt: "",
    compiledPromptJson: "{}",
    model: input.model,
    state: "generating",
    selected: 0,
    createTime: createdAt,
    updateTime: createdAt,
  });

  try {
    const compiled = await compileMusicCuePrompt({
      projectId: input.projectId,
      cueId: input.cueId,
      model: input.model,
      instruction: input.instruction,
    });
    await u.db("o_musicCueAsset").where("id", musicCueAssetId).update({
      prompt: compiled.prompt,
      compiledPromptJson: JSON.stringify(compiled),
      updateTime: now(),
    });
    const generationConfig = parseJsonValue<Record<string, any>>(compiled.generationConfig, {});
    const outputFormat = normalizeExt(generationConfig.outputFormat || generationConfig.format || "mp3");
    const savePath = `/${input.projectId}/assets/audio/${u.uuid()}.${outputFormat}`;
    const durationSec = Number(generationConfig.durationSec || generationConfig.duration || cue.durationSec || 0);
    const request = {
      ...generationConfig,
      prompt: compiled.prompt,
      negativePrompt: compiled.negativePrompt || generationConfig.negativePrompt || "",
      durationSec: durationSec > 0 ? durationSec : undefined,
      duration: durationSec > 0 ? durationSec : generationConfig.duration,
      referenceList: generationConfig.referenceList || [],
    };
    const ai = await u.Ai.Music(input.model as `${string}:${string}`).run(request);
    await ai.save(savePath);

    const shouldSelect =
      input.select === true ||
      !(await u.db("o_musicCueAsset").where({ projectId: input.projectId, cueId: input.cueId, selected: 1 }).first());
    const persisted = await u.db.transaction(async (trx: any) => {
      const [parentAssetId] = await trx("o_assets").insert({
        name: cue.title || cue.cueKey || `Music cue ${cue.id}`,
        describe: cue.narrativePurpose || "",
        type: "audio",
        projectId: input.projectId,
        scriptId: cue.scriptId ?? null,
        startTime: now(),
      });
      const [childAssetId] = await trx("o_assets").insert({
        prompt: compiled.prompt,
        assetsId: parentAssetId,
        type: "audio",
        describe: cue.narrativePurpose || "",
        name: `${cue.cueKey || cue.id}-v${version}.${outputFormat}`,
        projectId: input.projectId,
        scriptId: cue.scriptId ?? null,
        startTime: now(),
      });
      const [imageId] = await trx("o_image").insert({
        filePath: savePath,
        type: "audio",
        assetsId: childAssetId,
        state: "complete",
      });
      await trx("o_assets").where("id", childAssetId).update({ imageId });
      if (shouldSelect) {
        await trx("o_musicCueAsset").where({ projectId: input.projectId, cueId: input.cueId }).update({ selected: 0, updateTime: now() });
      }
      await trx("o_musicCueAsset").where("id", musicCueAssetId).update({
        assetsId: parentAssetId,
        childAssetId,
        state: "complete",
        selected: shouldSelect ? 1 : 0,
        updateTime: now(),
      });
      const row = await trx("o_musicCueAsset").where("id", musicCueAssetId).first();
      return {
        musicCueAsset: row,
        parentAssetId,
      };
    });
    return {
      musicCueAsset: persisted.musicCueAsset,
      audioAsset: await getAudioAssetResponse(persisted.parentAssetId),
    };
  } catch (error) {
    await u.db("o_musicCueAsset").where("id", musicCueAssetId).update({
      state: "failed",
      errorReason: u.error(error).message,
      updateTime: now(),
    });
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
  await u.db.transaction(async (trx: any) => {
    await trx("o_musicCueAsset").where({ projectId: input.projectId, cueId: input.cueId }).update({ selected: 0, updateTime: now() });
    await trx("o_musicCueAsset").where("id", input.musicCueAssetId).update({ selected: 1, updateTime: now() });
  });
  return u.db("o_musicCueAsset").where("id", input.musicCueAssetId).first();
}
