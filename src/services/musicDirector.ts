import { z } from "zod";
import u from "@/utils";
import { getAudioAssetResponse } from "@/services/audioAssetResponse";
import { invokeAiObjectWithFallback, parseAiJsonWithSchema } from "@/services/aiJsonObject";
import { readConfiguredSkill } from "@/services/skillResolver";
import { getProjectContextPack } from "@/services/projectMaterial";
import { getFullTextAssetContent, latestTextAsset } from "@/services/textAsset";
import { ensureLegacyMusicLibraryMigration } from "@/services/musicLibrary";
import { readScriptContent } from "@/services/scriptWorkspaceText";

export type MusicScopeMode = "concept" | "project" | "episode";

const jsonRecord = z.record(z.string(), z.any());

const musicBibleSchema = z.object({
  title: z.string().default("Project Music Bible"),
  content: z.string(),
  styleProfile: jsonRecord.default({}),
  sourceSummary: jsonRecord.default({}),
});

const musicCueCommonSchema = z.object({
  cueKey: z.string(),
  cueType: z.string(),
  title: z.string().optional(),
  narrativePurpose: z.string().optional(),
  startRef: jsonRecord.default({}),
  endRef: jsonRecord.default({}),
  durationSec: z.number().int().positive().max(900).optional(),
  estimatedDurationSec: z.number().int().positive().max(900).optional(),
  estimatedMinDurationSec: z.number().int().positive().max(900).optional(),
  estimatedMaxDurationSec: z.number().int().positive().max(900).optional(),
  durationConfidence: z.enum(["low", "medium", "high"]).default("medium"),
  promptBrief: z.string().optional(),
  musicSpec: jsonRecord.default({}),
});

export const musicCueSchema = z.intersection(
  musicCueCommonSchema,
  z.discriminatedUnion("usageMode", [
    z.object({
      usageMode: z.literal("reuse"),
      editionId: z.number().int().positive(),
      libraryVersionId: z.number().int().positive().optional(),
    }),
    z.object({
      usageMode: z.literal("new"),
      editionId: z.number().int().positive().optional(),
      libraryVersionId: z.number().int().positive().optional(),
    }),
    z.object({
      usageMode: z.literal("silence"),
      editionId: z.null().optional(),
      libraryVersionId: z.null().optional(),
    }),
  ]),
);

const musicLibraryEditionPlanSchema = z.object({
  editionKey: z.string(),
  editionType: z.enum(["master", "narrative_variant", "arrangement", "vocal_variant", "instrumental", "short_edit", "custom"]),
  title: z.string().optional(),
  narrativePhase: z.string().optional(),
  episodeStart: z.number().int().positive().optional(),
  episodeEnd: z.number().int().positive().optional(),
  vocalMode: z.enum(["instrumental", "vocal", "optional"]).default("instrumental"),
  language: z.string().optional(),
  musicSpec: jsonRecord.default({}),
});

const musicLibraryItemPlanSchema = z.object({
  workKey: z.string(),
  workType: z.enum(["theme_song", "opening_song", "ending_song", "insert_song", "score_theme", "source_music", "stinger"]),
  title: z.string(),
  narrativeRole: z.string().optional(),
  reuseScope: z.enum(["project", "episode", "single_use"]).default("project"),
  relationType: z.enum(["evolves_from", "replaces", "companion"]).optional(),
  relatedWorkKey: z.string().optional(),
  editions: z.array(musicLibraryEditionPlanSchema).default([]),
});

const musicPlanSchema = z.object({
  content: z.string(),
  libraryItems: z.array(musicLibraryItemPlanSchema).default([]),
  cues: z.array(musicCueSchema).default([]),
  recommendedProduction: z.object({ workKey: z.string(), editionKey: z.string(), reason: z.string() }).nullable().optional(),
});

function now() {
  return Date.now();
}

function truncate(value: unknown, max = 8000) {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function chunkText(value: unknown, max = 6000) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += max) chunks.push(text.slice(offset, offset + max));
  return chunks;
}

export function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function readMusicSkill(fileName: string, fallback: string) {
  return readConfiguredSkill(fileName, fallback);
}

async function nextVersion(table: string, where: Record<string, unknown>) {
  const row = await u.db(table).where(where).max("version as version").first();
  return Number(row?.version || 0) + 1;
}

async function collectMusicContext(input: { projectId: number; scriptId?: number | null; mode: MusicScopeMode }) {
  const project = await u.db("o_project").where("id", input.projectId).first();
  if (!project) throw new Error("Project does not exist");

  const contextPack = await getProjectContextPack(input.projectId).catch(() => null);
  const scripts = input.scriptId
    ? await u.db("o_script").where({ projectId: input.projectId, id: input.scriptId }).select("id", "name", "projectId", "content", "contentTextAssetId")
    : await u.db("o_script").where({ projectId: input.projectId }).select("id", "name", "projectId", "content", "contentTextAssetId").orderBy("id", "asc");
  const storyboards = input.mode === "episode" && input.scriptId
    ? await u
        .db("o_storyboard")
        .where({ projectId: input.projectId, scriptId: input.scriptId })
        .select("id", "scriptId", "trackId", "index", "duration", "location", "timeOfDay", "sceneContinuityId", "track", "videoDesc", "tableRowJson")
        .orderBy("index", "asc")
    : [];
  const directorPlans = await Promise.all(scripts.map(async (script: any) => {
    const asset = await latestTextAsset({ projectId: input.projectId, scriptId: script.id, targetType: "scriptPlan", targetId: "director-plan", state: "complete" });
    if (!asset) return null;
    const content = await getFullTextAssetContent({ id: Number(asset.id), projectId: input.projectId }).then((row) => row.content).catch(() => "");
    return { scriptId: script.id, textAssetId: asset.id, contentChunks: chunkText(content) };
  }));
  await ensureLegacyMusicLibraryMigration(input.projectId);
  const libraryItems = await (u.db as any)("o_musicLibraryItem").where({ projectId: input.projectId }).whereNot("state", "archived").orderBy("id", "asc");
  const editions = libraryItems.length
    ? await (u.db as any)("o_musicLibraryEdition").where({ projectId: input.projectId }).whereIn("libraryItemId", libraryItems.map((item: any) => item.id)).whereNot("state", "archived")
    : [];
  const versions = editions.length
    ? await (u.db as any)("o_musicLibraryVersion").where({ projectId: input.projectId, state: "complete" }).whereIn("editionId", editions.map((item: any) => item.id))
    : [];

  const scriptBrief = await Promise.all(scripts.map(async (script: any) => ({
    id: script.id,
    name: script.name,
    contentChunks: chunkText(await readScriptContent(script)),
  })));
  const storyboardBrief = storyboards.map((row: any) => ({
    id: row.id,
    scriptId: row.scriptId,
    trackId: row.trackId,
    index: row.index,
    duration: row.duration,
    location: row.location,
    timeOfDay: row.timeOfDay,
    sceneContinuityId: row.sceneContinuityId,
    track: truncate(row.track, 500),
    videoDesc: truncate(row.videoDesc, 500),
    row: truncate(row.tableRowJson, 700),
  }));

  return {
    project: { id: project.id, name: project.name, intro: project.intro, type: project.type, artStyle: project.artStyle },
    mode: input.mode,
    contextPack: contextPack ? truncate((contextPack as any).content, 10000) : "",
    scripts: scriptBrief,
    directorPlans: directorPlans.filter(Boolean),
    storyboards: storyboardBrief,
    musicLibrary: libraryItems.map((item: any) => ({
      id: item.id,
      workKey: item.workKey,
      workType: item.workType,
      title: item.title,
      narrativeRole: item.narrativeRole,
      editions: editions
        .filter((edition: any) => Number(edition.libraryItemId) === Number(item.id))
        .map((edition: any) => ({
          id: edition.id,
          editionKey: edition.editionKey,
          editionType: edition.editionType,
          title: edition.title,
          narrativePhase: edition.narrativePhase,
          vocalMode: edition.vocalMode,
          musicSpec: parseJsonValue(edition.musicSpecJson, {}),
          selectedVersionId: edition.selectedVersionId,
          completedVersions: versions.filter((version: any) => Number(version.editionId) === Number(edition.id)).map((version: any) => ({ id: version.id, version: version.version })),
        })),
    })),
  };
}

export async function latestMusicBible(projectId: number) {
  return u.db("o_musicBible").where({ projectId, state: "complete" }).orderBy("version", "desc").first();
}

export async function generateMusicBible(input: { projectId: number; instruction?: string }) {
  const [flow, technique] = await Promise.all([
    readMusicSkill("music_bible_flow.md", "Create a project-level music bible from selected story context."),
    readMusicSkill("music_bible_technique.md", "Define motifs, instrumentation, sonic palette, silence strategy, avoid list and continuity rules."),
  ]);
  const context = await collectMusicContext({ projectId: input.projectId, mode: "concept" });
  const result = await invokeAiObjectWithFallback({
    modelKey: "musicProductionAgent:executionAgent",
    label: "Music bible",
    schema: musicBibleSchema,
    system: [
      "You are the music director for an audiovisual project.",
      "The director plan is only a reference for pacing, scene boundaries and emotional movement; it is not the music authority.",
      "Do not map project genre to music style through fixed stereotypes. Infer the music design from the story, theme, relationships and production intent.",
      flow.content,
      technique.content,
    ].join("\n\n"),
    messages: [
      {
        role: "user",
        content: JSON.stringify({ instruction: input.instruction || "", selectedContext: context }, null, 2),
      },
    ],
    fallbackTextParser: (text) => parseAiJsonWithSchema(text, musicBibleSchema, "Music bible"),
  });
  const version = await nextVersion("o_musicBible", { projectId: input.projectId });
  const [id] = await u.db("o_musicBible").insert({
    projectId: input.projectId,
    version,
    title: result.title,
    content: result.content,
    styleProfileJson: JSON.stringify(result.styleProfile || {}),
    sourceSummaryJson: JSON.stringify(result.sourceSummary || {}),
    state: "complete",
    createTime: now(),
    updateTime: now(),
  });
  const saved = await u.db("o_musicBible").where("id", id).first();
  if (!saved) throw new Error("Music bible was generated but could not be loaded");
  return saved;
}

export async function generateMusicPlan(input: {
  projectId: number;
  scriptId?: number | null;
  mode: MusicScopeMode;
  bibleId?: number;
  instruction?: string;
}) {
  const bible = input.bibleId ? await u.db("o_musicBible").where({ projectId: input.projectId, id: input.bibleId }).first() : await latestMusicBible(input.projectId);
  if (!bible) throw new Error("Music bible is required before generating a music plan");
  const [technique] = await Promise.all([
    readMusicSkill("music_plan_technique.md", "Plan cues by musical semantics, not mechanically per storyboard shot."),
  ]);
  const context = await collectMusicContext({ projectId: input.projectId, scriptId: input.scriptId, mode: input.mode });
  const result = await invokeAiObjectWithFallback({
    modelKey: "musicProductionAgent:executionAgent",
    label: "Music plan",
    schema: musicPlanSchema,
    system: [
      "You are the scoring director creating an actionable music plan and cue sheet.",
      "Mode contract: concept returns recommendations only; project returns libraryItems and no episode cues; episode returns semantic cues and never creates project libraryItems in the AI response.",
      "Episode cues are split by sustained narrative and musical meaning, never by camera cuts or storyboard rows. One cue may cover many shots and scenes.",
      "Every episode cue chooses usageMode reuse, new, or silence. Reuse existing library editions whenever they satisfy the narrative function.",
      "A reuse cue must copy one exact editionId from selectedContext.musicLibrary. Include libraryVersionId only when choosing one exact completedVersions id. Never output reuse without a real editionId, and never infer ids from titles.",
      "All durations are pre-edit estimates. Use semantic script/director anchors, not final timecodes.",
      technique.content,
    ].join("\n\n"),
    messages: [
      {
        role: "user",
        content: JSON.stringify(
          {
            instruction: input.instruction || "",
            mode: input.mode,
            musicBible: {
              id: bible.id,
              version: bible.version,
              title: bible.title,
              content: bible.content,
              styleProfile: parseJsonValue(bible.styleProfileJson, {}),
            },
            selectedContext: context,
          },
          null,
          2,
        ),
      },
    ],
    fallbackTextParser: (text) => parseAiJsonWithSchema(text, musicPlanSchema, "Music plan"),
  });
  if (input.mode === "episode" && input.scriptId == null) throw new Error("scriptId is required in episode mode");
  if (input.mode !== "episode" && result.cues.length) throw new Error(`${input.mode} music plan must not create episode cues`);
  if (input.mode === "episode" && result.libraryItems.length) throw new Error("Episode music plan must reuse the project library or mark cues as new; it must not create project works directly");
  for (const cue of result.cues) {
    const estimated = cue.estimatedDurationSec ?? cue.durationSec;
    const minimum = cue.estimatedMinDurationSec ?? estimated;
    const maximum = cue.estimatedMaxDurationSec ?? estimated;
    if (estimated != null && (minimum == null || maximum == null || minimum > estimated || estimated > maximum)) {
      throw new Error(`Cue ${cue.cueKey} has an invalid estimated duration range`);
    }
  }
  const version = await nextVersion("o_musicPlan", {
    projectId: input.projectId,
    scriptId: input.scriptId ?? null,
    mode: input.mode,
  });
  const createdAt = now();
  return u.db.transaction(async (trx: any) => {
    const [planId] = await trx("o_musicPlan").insert({
      projectId: input.projectId,
      scriptId: input.scriptId ?? null,
      mode: input.mode,
      bibleId: bible.id,
      bibleVersion: bible.version,
      version,
      content: result.content,
      cueSheetJson: JSON.stringify(result.cues),
      libraryPlanJson: JSON.stringify(result.libraryItems),
      recommendedProductionJson: null,
      state: "complete",
      createTime: createdAt,
      updateTime: createdAt,
    });
    const plannedItems: any[] = [];
    const materializationWarnings: string[] = [];
    if (input.mode === "project") {
      const workIdByKey = new Map<string, number>();
      for (const item of result.libraryItems) {
        let savedItem = await trx("o_musicLibraryItem").where({ projectId: input.projectId, workKey: item.workKey }).first();
        if (!savedItem) {
          const [itemId] = await trx("o_musicLibraryItem").insert({
            projectId: input.projectId,
            bibleId: bible.id,
            bibleVersion: bible.version,
            workKey: item.workKey,
            workType: item.workType,
            title: item.title,
            narrativeRole: item.narrativeRole || "",
            reuseScope: item.reuseScope,
            relatedItemId: null,
            relationType: item.relationType || null,
            state: "planned",
            createTime: createdAt,
            updateTime: createdAt,
          });
          savedItem = await trx("o_musicLibraryItem").where("id", itemId).first();
        } else {
          const existingEditions = await trx("o_musicLibraryEdition").where("libraryItemId", savedItem.id).select("id");
          const hasVersions = existingEditions.length
            ? Boolean(await trx("o_musicLibraryVersion").whereIn("editionId", existingEditions.map((row: any) => row.id)).first("id"))
            : false;
          if (savedItem.state === "planned" && !hasVersions) {
            await trx("o_musicLibraryItem").where("id", savedItem.id).update({
              bibleId: bible.id,
              bibleVersion: bible.version,
              workType: item.workType,
              title: item.title,
              narrativeRole: item.narrativeRole || "",
              reuseScope: item.reuseScope,
              updateTime: createdAt,
            });
            savedItem = await trx("o_musicLibraryItem").where("id", savedItem.id).first();
          } else {
            materializationWarnings.push(`Music work ${item.workKey} already has produced or protected material and was not overwritten`);
          }
        }
        workIdByKey.set(item.workKey, Number(savedItem.id));
        plannedItems.push(savedItem);
        for (const edition of item.editions) {
          const exists = await trx("o_musicLibraryEdition").where({ libraryItemId: savedItem.id, editionKey: edition.editionKey }).first();
          if (exists) {
            const hasVersion = Boolean(await trx("o_musicLibraryVersion").where("editionId", exists.id).first("id"));
            if (exists.state === "planned" && !hasVersion) {
              await trx("o_musicLibraryEdition").where("id", exists.id).update({
                editionType: edition.editionType,
                title: edition.title || edition.editionKey,
                narrativePhase: edition.narrativePhase || "",
                episodeStart: edition.episodeStart ?? null,
                episodeEnd: edition.episodeEnd ?? null,
                vocalMode: edition.vocalMode,
                language: edition.language || "",
                musicSpecJson: JSON.stringify(edition.musicSpec || {}),
                updateTime: createdAt,
              });
            } else {
              materializationWarnings.push(`Music edition ${item.workKey}/${edition.editionKey} already has produced or protected material and was not overwritten`);
            }
            continue;
          }
          await trx("o_musicLibraryEdition").insert({
            projectId: input.projectId,
            libraryItemId: savedItem.id,
            parentEditionId: null,
            editionKey: edition.editionKey,
            editionType: edition.editionType,
            title: edition.title || edition.editionKey,
            narrativePhase: edition.narrativePhase || "",
            episodeStart: edition.episodeStart ?? null,
            episodeEnd: edition.episodeEnd ?? null,
            vocalMode: edition.vocalMode,
            language: edition.language || "",
            musicSpecJson: JSON.stringify(edition.musicSpec || {}),
            selectedVersionId: null,
            state: "planned",
            createTime: createdAt,
            updateTime: createdAt,
          });
        }
      }
      for (const item of result.libraryItems) {
        if (!item.relatedWorkKey) continue;
        const itemId = workIdByKey.get(item.workKey);
        const relatedItemId = workIdByKey.get(item.relatedWorkKey) || Number((await trx("o_musicLibraryItem").where({ projectId: input.projectId, workKey: item.relatedWorkKey }).first())?.id || 0);
        if (itemId && relatedItemId) await trx("o_musicLibraryItem").where("id", itemId).update({ relatedItemId, relationType: item.relationType || "evolves_from", updateTime: createdAt });
      }
    }
    for (let index = 0; index < result.cues.length; index++) {
      const cue = result.cues[index];
      const estimated = cue.estimatedDurationSec ?? cue.durationSec ?? undefined;
      const [cueId] = await trx("o_musicCue").insert({
        projectId: input.projectId,
        scriptId: input.scriptId ?? null,
        planId,
        planVersion: version,
        cueKey: cue.cueKey || `cue-${index + 1}`,
        cueType: cue.cueType || "bgm",
        title: cue.title || "",
        narrativePurpose: cue.narrativePurpose || "",
        startRefJson: JSON.stringify(cue.startRef || {}),
        endRefJson: JSON.stringify(cue.endRef || {}),
        durationSec: estimated ?? null,
        durationMode: "estimated",
        estimatedDurationSec: estimated ?? null,
        estimatedMinDurationSec: cue.estimatedMinDurationSec ?? estimated ?? null,
        estimatedMaxDurationSec: cue.estimatedMaxDurationSec ?? estimated ?? null,
        durationConfidence: cue.durationConfidence,
        promptBrief: cue.promptBrief || "",
        musicSpecJson: JSON.stringify(cue.musicSpec || {}),
        state: "ready",
        createTime: createdAt,
        updateTime: createdAt,
      });
      let editionId = cue.editionId ?? null;
      let libraryVersionId = cue.libraryVersionId ?? null;
      if (cue.usageMode === "new" && editionId == null) {
        const workKey = `cue-${cueId}`;
        const [itemId] = await trx("o_musicLibraryItem").insert({
          projectId: input.projectId,
          bibleId: bible.id,
          bibleVersion: bible.version,
          workKey,
          workType: "score_theme",
          title: cue.title || cue.cueKey,
          narrativeRole: cue.narrativePurpose || "",
          reuseScope: "project",
          relatedItemId: null,
          relationType: null,
          state: "planned",
          createTime: createdAt,
          updateTime: createdAt,
        });
        const [newEditionId] = await trx("o_musicLibraryEdition").insert({
          projectId: input.projectId,
          libraryItemId: itemId,
          parentEditionId: null,
          editionKey: "master",
          editionType: "master",
          title: cue.title || cue.cueKey,
          narrativePhase: "episode cue",
          episodeStart: null,
          episodeEnd: null,
          vocalMode: "instrumental",
          language: "",
          musicSpecJson: JSON.stringify(cue.musicSpec || {}),
          selectedVersionId: null,
          state: "planned",
          createTime: createdAt,
          updateTime: createdAt,
        });
        editionId = Number(newEditionId);
      }
      if (editionId != null) {
        const edition = await trx("o_musicLibraryEdition").where({ projectId: input.projectId, id: editionId }).first();
        if (!edition) throw new Error(`Cue ${cue.cueKey} references a music edition that does not belong to this project`);
      }
      if (libraryVersionId != null) {
        const libraryVersion = await trx("o_musicLibraryVersion").where({ projectId: input.projectId, id: libraryVersionId, editionId, state: "complete" }).first();
        if (!libraryVersion) throw new Error(`Cue ${cue.cueKey} references an unavailable music version`);
      }
      await trx("o_musicCueBinding").insert({
        projectId: input.projectId,
        scriptId: input.scriptId ?? null,
        cueId,
        usageMode: cue.usageMode,
        editionId: cue.usageMode === "silence" ? null : editionId,
        libraryVersionId: cue.usageMode === "silence" ? null : libraryVersionId,
        suggestedUseDurationSec: estimated ?? null,
        state: cue.usageMode === "silence" || libraryVersionId != null ? "ready" : cue.usageMode === "reuse" ? "missing_asset" : "planned",
        createTime: createdAt,
        updateTime: createdAt,
      });
    }
    const recommendedProduction = result.recommendedProduction
      ? await (async () => {
          const item = await trx("o_musicLibraryItem").where({ projectId: input.projectId, workKey: result.recommendedProduction!.workKey }).first();
          if (!item) return null;
          const edition = await trx("o_musicLibraryEdition").where({ projectId: input.projectId, libraryItemId: item.id, editionKey: result.recommendedProduction!.editionKey }).first();
          if (!edition) return null;
          return { ...result.recommendedProduction!, libraryItemId: Number(item.id), editionId: Number(edition.id) };
        })()
      : null;
    await trx("o_musicPlan").where("id", planId).update({ recommendedProductionJson: JSON.stringify(recommendedProduction) });
    return {
      plan: await trx("o_musicPlan").where("id", planId).first(),
      cues: await trx("o_musicCue").where("planId", planId).orderBy("id", "asc"),
      libraryItems: plannedItems,
      materializationWarnings,
      recommendedProduction,
    };
  });
}

export async function listMusicCues(input: { projectId: number; scriptId?: number | null; planId?: number }) {
  await ensureLegacyMusicLibraryMigration(input.projectId);
  const cues = await u
    .db("o_musicCue")
    .where({ projectId: input.projectId })
    .modify((qb: any) => {
      if (input.scriptId != null) qb.where("scriptId", input.scriptId);
      if (input.planId != null) qb.where("planId", input.planId);
    })
    .orderBy("planId", "desc")
    .orderBy("id", "asc");
  if (!cues.length) return [];
  const assets = await u.db("o_musicCueAsset").whereIn(
    "cueId",
    cues.map((cue: any) => cue.id),
  );
  const assetsWithAudio = await Promise.all(
    assets.map(async (asset: any) => ({
      ...asset,
      audioAsset: asset.assetsId ? await getAudioAssetResponse(Number(asset.assetsId)) : null,
    })),
  );
  const assetsByCue = new Map<number, any[]>();
  for (const asset of assetsWithAudio) {
    const list = assetsByCue.get(Number(asset.cueId)) || [];
    // A cue candidate points at an audio parent asset. Return the same
    // playable-media shape as music-library versions so consumers do not
    // mistake a completed candidate for one without audio.
    list.push(asset);
    assetsByCue.set(Number(asset.cueId), list);
  }
  const bindings = await (u.db as any)("o_musicCueBinding").whereIn("cueId", cues.map((cue: any) => cue.id));
  const bindingByCue = new Map<number, any>(bindings.map((binding: any) => [Number(binding.cueId), binding]));
  const editionIds = bindings.map((binding: any) => Number(binding.editionId)).filter((id: number) => id > 0);
  const versionIds = bindings.map((binding: any) => Number(binding.libraryVersionId)).filter((id: number) => id > 0);
  const editions = editionIds.length ? await (u.db as any)("o_musicLibraryEdition").whereIn("id", editionIds) : [];
  const versions = versionIds.length ? await (u.db as any)("o_musicLibraryVersion").whereIn("id", versionIds) : [];
  const editionById = new Map(editions.map((edition: any) => [Number(edition.id), { ...edition, musicSpec: parseJsonValue(edition.musicSpecJson, {}) }]));
  const versionById = new Map(versions.map((version: any) => [Number(version.id), { ...version, generationConfig: parseJsonValue(version.generationConfigJson, {}) }]));
  const latestPrompts = await (u.db as any)("o_musicPromptVersion").where({ projectId: input.projectId, targetType: "cue", state: "active" }).whereIn("cueId", cues.map((cue: any) => cue.id)).orderBy("version", "desc");
  const promptByCue = new Map<number, any>();
  for (const prompt of latestPrompts) if (!promptByCue.has(Number(prompt.cueId))) promptByCue.set(Number(prompt.cueId), { ...prompt, generationConfig: parseJsonValue(prompt.generationConfigJson, {}) });
  return cues.map((cue: any) => ({
    ...cue,
    startRef: parseJsonValue(cue.startRefJson, {}),
    endRef: parseJsonValue(cue.endRefJson, {}),
    musicSpec: parseJsonValue(cue.musicSpecJson, {}),
    assets: assetsByCue.get(Number(cue.id)) || [],
    binding: bindingByCue.get(Number(cue.id)) || null,
    usageMode: bindingByCue.get(Number(cue.id))?.usageMode || "new",
    edition: editionById.get(Number(bindingByCue.get(Number(cue.id))?.editionId)) || null,
    libraryVersion: versionById.get(Number(bindingByCue.get(Number(cue.id))?.libraryVersionId)) || null,
    latestPromptVersion: promptByCue.get(Number(cue.id)) || null,
    needsGeneration: bindingByCue.get(Number(cue.id))?.usageMode === "new" && !bindingByCue.get(Number(cue.id))?.libraryVersionId,
  }));
}
