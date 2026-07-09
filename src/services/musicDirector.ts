import { z } from "zod";
import u from "@/utils";
import { invokeAiObjectWithFallback, parseAiJsonWithSchema } from "@/services/aiJsonObject";
import { readConfiguredSkill } from "@/services/skillResolver";
import { getProjectContextPack } from "@/services/projectMaterial";

export type MusicScopeMode = "concept" | "project" | "episode";

const jsonRecord = z.record(z.string(), z.any());

const musicBibleSchema = z.object({
  title: z.string().default("Project Music Bible"),
  content: z.string(),
  styleProfile: jsonRecord.default({}),
  sourceSummary: jsonRecord.default({}),
});

const musicCueSchema = z.object({
  cueKey: z.string(),
  cueType: z.string(),
  title: z.string().optional(),
  narrativePurpose: z.string().optional(),
  startRef: jsonRecord.default({}),
  endRef: jsonRecord.default({}),
  durationSec: z.number().int().positive().max(900).optional(),
  promptBrief: z.string().optional(),
  musicSpec: jsonRecord.default({}),
});

const musicPlanSchema = z.object({
  content: z.string(),
  cues: z.array(musicCueSchema).default([]),
});

function now() {
  return Date.now();
}

function truncate(value: unknown, max = 8000) {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
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
    ? await u.db("o_script").where({ projectId: input.projectId, id: input.scriptId }).select("id", "name", "content")
    : await u.db("o_script").where({ projectId: input.projectId }).select("id", "name", "content").orderBy("id", "asc").limit(8);
  const storyboards = await u
    .db("o_storyboard")
    .where({ projectId: input.projectId })
    .modify((qb: any) => {
      if (input.scriptId) qb.where("scriptId", input.scriptId);
    })
    .select("id", "scriptId", "trackId", "index", "duration", "location", "timeOfDay", "sceneContinuityId", "track", "videoDesc", "tableRowJson")
    .orderBy("scriptId", "asc")
    .orderBy("index", "asc")
    .limit(80);
  const videoTracks = await u
    .db("o_videoTrack")
    .where({ projectId: input.projectId })
    .modify((qb: any) => {
      if (input.scriptId) qb.where("scriptId", input.scriptId);
    })
    .select("*")
    .limit(40)
    .catch(() => []);

  const scriptBrief = scripts.map((script: any) => ({
    id: script.id,
    name: script.name,
    content: truncate(script.content, input.scriptId ? 12000 : 3000),
  }));
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
  const trackBrief = videoTracks.map((row: any) => ({
    id: row.id,
    scriptId: row.scriptId,
    name: row.name,
    groupKey: row.groupKey,
    groupName: row.groupName,
    groupIntent: row.groupIntent,
    duration: row.duration,
    state: row.state,
  }));

  return {
    project: { id: project.id, name: project.name, intro: project.intro, type: project.type, artStyle: project.artStyle },
    mode: input.mode,
    contextPack: contextPack ? truncate((contextPack as any).content, 10000) : "",
    scripts: scriptBrief,
    storyboards: storyboardBrief,
    videoTracks: trackBrief,
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
    modelKey: "productionAgent",
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
    modelKey: "productionAgent",
    label: "Music plan",
    schema: musicPlanSchema,
    system: [
      "You are the scoring director creating an actionable music plan and cue sheet.",
      "Support concept, project and episode modes. Episode mode must work for rolling serialized production.",
      "Cues are split by musical purpose, dramatic beat and scene transition, not by every storyboard panel.",
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
      state: "complete",
      createTime: createdAt,
      updateTime: createdAt,
    });
    for (let index = 0; index < result.cues.length; index++) {
      const cue = result.cues[index];
      await trx("o_musicCue").insert({
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
        durationSec: cue.durationSec ?? null,
        promptBrief: cue.promptBrief || "",
        musicSpecJson: JSON.stringify(cue.musicSpec || {}),
        state: "ready",
        createTime: createdAt,
        updateTime: createdAt,
      });
    }
    return {
      plan: await trx("o_musicPlan").where("id", planId).first(),
      cues: await trx("o_musicCue").where("planId", planId).orderBy("id", "asc"),
    };
  });
}

export async function listMusicCues(input: { projectId: number; scriptId?: number | null; planId?: number }) {
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
  const assetsByCue = new Map<number, any[]>();
  for (const asset of assets) {
    const list = assetsByCue.get(Number(asset.cueId)) || [];
    list.push(asset);
    assetsByCue.set(Number(asset.cueId), list);
  }
  return cues.map((cue: any) => ({
    ...cue,
    startRef: parseJsonValue(cue.startRefJson, {}),
    endRef: parseJsonValue(cue.endRefJson, {}),
    musicSpec: parseJsonValue(cue.musicSpecJson, {}),
    assets: assetsByCue.get(Number(cue.id)) || [],
  }));
}
