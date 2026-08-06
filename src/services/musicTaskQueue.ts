import u from "@/utils";
import { createUnifiedTask, formatUnifiedTaskEnvelope, type UnifiedTaskEnvelope } from "@/services/taskCoordinator";
import { latestMusicBible } from "@/services/musicDirector";
import { resolveMusicModelCapabilities } from "@/services/musicModelCapability";
import { resolveMusicPromptProfile } from "@/services/musicCueCompiler";
import { resolveMusicExecutionModel } from "@/services/musicModelSelection";

type QueueResult = UnifiedTaskEnvelope;

async function assertProject(projectId: number) {
  const project = await u.db("o_project").where("id", projectId).first();
  if (!project) throw new Error("Project does not exist");
  return project;
}

async function assertScript(projectId: number, scriptId?: number | null) {
  if (scriptId == null) return null;
  const script = await u.db("o_script").where({ projectId, id: scriptId }).first();
  if (!script) throw new Error("Script does not exist or does not belong to this project");
  return script;
}

async function assertBible(projectId: number, bibleId: number) {
  const bible = await u.db("o_musicBible").where({ projectId, id: bibleId }).first();
  if (!bible) throw new Error("Music bible does not exist");
  return bible;
}

async function assertPlan(projectId: number, planId: number) {
  const plan = await u.db("o_musicPlan").where({ projectId, id: planId }).first();
  if (!plan) throw new Error("Music plan does not exist");
  return plan;
}

async function assertCue(projectId: number, cueId: number) {
  const cue = await u.db("o_musicCue").where({ projectId, id: cueId }).first();
  if (!cue) throw new Error("Music cue does not exist");
  return cue;
}

async function assertModelSpecificMusicPrompt(model: string) {
  await Promise.all([resolveMusicModelCapabilities(model), resolveMusicPromptProfile(model)]);
}

export async function queueMusicBibleGenerate(input: { projectId: number; instruction?: string }) {
  await assertProject(input.projectId);
  const task = await createUnifiedTask({
    projectId: input.projectId,
    taskClass: "Music bible generation",
    taskType: "prompt",
    status: "queued",
    phase: "queued",
    targetType: "musicBible",
    businessType: "music-bible",
    handler: "music-bible-generate",
    payload: input,
    priority: 80,
    describe: "Generate project music bible",
  });
  return formatUnifiedTaskEnvelope(task, "musicBible");
}

export async function queueMusicBibleReview(input: { projectId: number; bibleId: number }) {
  await assertBible(input.projectId, input.bibleId);
  const task = await createUnifiedTask({
    projectId: input.projectId,
    taskClass: "Music bible review",
    taskType: "prompt",
    status: "queued",
    phase: "queued",
    targetType: "musicBible",
    targetId: input.bibleId,
    businessType: "music-bible",
    businessId: input.bibleId,
    handler: "music-bible-review",
    payload: input,
    priority: 70,
    describe: "Review music bible",
  });
  return formatUnifiedTaskEnvelope(task, "musicBible", input.bibleId);
}

export async function queueMusicPlanGenerate(input: {
  projectId: number;
  scriptId?: number | null;
  mode: "concept" | "project" | "episode";
  bibleId?: number;
  instruction?: string;
}) {
  await assertProject(input.projectId);
  await assertScript(input.projectId, input.scriptId);
  if (input.bibleId != null) await assertBible(input.projectId, input.bibleId);
  else if (!(await latestMusicBible(input.projectId))) throw new Error("Music bible is required before generating a music plan");
  const task = await createUnifiedTask({
    projectId: input.projectId,
    scriptId: input.scriptId ?? undefined,
    taskClass: "Music plan generation",
    taskType: "prompt",
    status: "queued",
    phase: "queued",
    targetType: "musicPlan",
    businessType: "music-plan",
    handler: "music-plan-generate",
    payload: input,
    priority: 80,
    describe: "Generate music plan and cue sheet",
  });
  return formatUnifiedTaskEnvelope(task, "musicPlan");
}

export async function queueMusicPlanReview(input: { projectId: number; planId: number }) {
  const plan = await assertPlan(input.projectId, input.planId);
  const task = await createUnifiedTask({
    projectId: input.projectId,
    scriptId: plan.scriptId ?? undefined,
    taskClass: "Music plan review",
    taskType: "prompt",
    status: "queued",
    phase: "queued",
    targetType: "musicPlan",
    targetId: input.planId,
    businessType: "music-plan",
    businessId: input.planId,
    handler: "music-plan-review",
    payload: input,
    priority: 70,
    describe: "Review music plan",
  });
  return formatUnifiedTaskEnvelope(task, "musicPlan", input.planId);
}

export async function queueMusicCueCompilePrompt(input: { projectId: number; cueId: number; model?: string; instruction?: string }) {
  const cue = await assertCue(input.projectId, input.cueId);
  const model = await resolveMusicExecutionModel(input);
  await assertModelSpecificMusicPrompt(model);
  const task = await createUnifiedTask({
    projectId: input.projectId,
    scriptId: cue.scriptId ?? undefined,
    taskClass: "Music cue prompt compile",
    taskType: "prompt",
    status: "queued",
    phase: "queued",
    targetType: "musicPrompt",
    targetId: input.cueId,
    businessType: "music-prompt",
    businessId: input.cueId,
    handler: "music-cue-compile-prompt",
    payload: { ...input, model, promptMode: "modelSpecific" },
    priority: 70,
    model,
    describe: "Compile music cue prompt",
  });
  return formatUnifiedTaskEnvelope(task, "musicPrompt", input.cueId);
}

export async function queueGenericMusicCuePrompt(input: { projectId: number; cueId: number; instruction?: string }) {
  const cue = await assertCue(input.projectId, input.cueId);
  const task = await createUnifiedTask({
    projectId: input.projectId,
    scriptId: cue.scriptId ?? undefined,
    taskClass: "Generic music cue prompt compile",
    taskType: "prompt",
    status: "queued",
    phase: "queued",
    targetType: "musicPrompt",
    targetId: input.cueId,
    businessType: "music-prompt",
    businessId: input.cueId,
    handler: "music-cue-compile-prompt",
    payload: { ...input, promptMode: "generic" },
    priority: 70,
    describe: "Compile provider-neutral music cue prompt",
  });
  return formatUnifiedTaskEnvelope(task, "musicPrompt", input.cueId);
}

export async function queueMusicCueReviewPrompt(input: {
  projectId: number;
  cueId: number;
  promptVersionId: number;
  expectedPromptMode?: "generic" | "modelSpecific";
}) {
  const cue = await assertCue(input.projectId, input.cueId);
  const prompt = await u.db("o_musicPromptVersion" as any).where({ projectId: input.projectId, id: input.promptVersionId, targetType: "cue", cueId: input.cueId }).first();
  if (!prompt) throw new Error("Music prompt version does not belong to this cue");
  if (input.expectedPromptMode && (prompt.promptMode || "modelSpecific") !== input.expectedPromptMode) throw new Error("Prompt version mode does not match this review request");
  const task = await createUnifiedTask({
    projectId: input.projectId,
    scriptId: cue.scriptId ?? undefined,
    taskClass: "Music cue prompt review",
    taskType: "prompt",
    status: "queued",
    phase: "queued",
    targetType: "musicPrompt",
    targetId: input.cueId,
    businessType: "music-prompt",
    businessId: input.cueId,
    handler: "music-cue-review-prompt",
    payload: input,
    priority: 70,
    model: prompt.model || undefined,
    describe: "Review music cue prompt",
  });
  return formatUnifiedTaskEnvelope(task, "musicPrompt", input.cueId);
}

export async function queueMusicLibraryReviewPrompt(input: {
  projectId: number;
  editionId: number;
  promptVersionId: number;
  expectedPromptMode?: "generic" | "modelSpecific";
}) {
  await assertProject(input.projectId);
  const edition = await u.db("o_musicLibraryEdition").where({ projectId: input.projectId, id: input.editionId }).first();
  if (!edition) throw new Error("Music library edition does not exist");
  const prompt = await u.db("o_musicPromptVersion").where({ projectId: input.projectId, id: input.promptVersionId, targetType: "edition", editionId: input.editionId }).first();
  if (!prompt) throw new Error("Music prompt version does not belong to this edition");
  if (input.expectedPromptMode && (prompt.promptMode || "modelSpecific") !== input.expectedPromptMode) throw new Error("Prompt version mode does not match this review request");
  const task = await createUnifiedTask({
    projectId: input.projectId,
    taskClass: "Music library prompt review",
    taskType: "prompt",
    status: "queued",
    phase: "queued",
    targetType: "musicPrompt",
    targetId: input.promptVersionId,
    businessType: "music-library-prompt",
    businessId: input.editionId,
    handler: "music-cue-review-prompt",
    payload: input,
    priority: 70,
    model: prompt.model || undefined,
    describe: "Review saved project music prompt",
  });
  return formatUnifiedTaskEnvelope(task, "musicPrompt", input.promptVersionId);
}

export async function queueMusicCueGenerate(input: {
  projectId: number;
  cueId: number;
  promptVersionId: number;
  model?: string;
  select?: boolean;
  acknowledgeWarnings?: boolean;
}) {
  const cue = await assertCue(input.projectId, input.cueId);
  const prompt = await u.db("o_musicPromptVersion" as any).where({ projectId: input.projectId, id: input.promptVersionId, targetType: "cue", cueId: input.cueId }).first();
  if (!prompt) throw new Error("Music prompt version does not belong to this cue");
  const model = await resolveMusicExecutionModel(input);
  const task = await createUnifiedTask({
    projectId: input.projectId,
    scriptId: cue.scriptId ?? undefined,
    taskClass: "Music cue audio generation",
    taskType: "audio",
    status: "queued",
    phase: "queued",
    targetType: "musicCueAsset",
    targetId: input.cueId,
    businessType: "music-cue-asset",
    businessId: input.cueId,
    handler: "music-cue-generate",
    payload: { ...input, model },
    priority: 80,
    model,
    describe: "Generate music cue audio",
  });
  return formatUnifiedTaskEnvelope(task, "musicCueAsset", input.cueId);
}

export async function queueMusicLyricsGenerate(input: { projectId: number; editionId: number; instruction?: string; basedOnId?: number | null }) {
  await assertProject(input.projectId);
  const edition = await u.db("o_musicLibraryEdition" as any).where({ projectId: input.projectId, id: input.editionId }).first();
  if (!edition) throw new Error("Music library edition does not exist");
  const task = await createUnifiedTask({
    projectId: input.projectId,
    taskClass: "Music lyrics generation",
    taskType: "prompt",
    status: "queued",
    phase: "queued",
    targetType: "musicLyrics",
    targetId: input.editionId,
    businessType: "music-lyrics",
    businessId: input.editionId,
    handler: "music-lyrics-generate",
    payload: input,
    priority: 70,
    describe: "Generate a lyrics draft for user confirmation",
  });
  return formatUnifiedTaskEnvelope(task, "musicLyrics", input.editionId);
}

export async function queueMusicLyricsReview(input: { projectId: number; editionId: number; lyricsVersionId: number }) {
  await assertProject(input.projectId);
  const lyrics = await u.db("o_musicLyricsVersion" as any).where({ projectId: input.projectId, editionId: input.editionId, id: input.lyricsVersionId }).first();
  if (!lyrics) throw new Error("Lyrics version does not exist or does not belong to this edition");
  const task = await createUnifiedTask({
    projectId: input.projectId,
    taskClass: "Music lyrics review",
    taskType: "prompt",
    status: "queued",
    phase: "queued",
    targetType: "musicLyrics",
    targetId: input.lyricsVersionId,
    businessType: "music-lyrics",
    businessId: input.editionId,
    handler: "music-lyrics-review",
    payload: input,
    priority: 70,
    describe: "Review a saved lyrics version",
  });
  return formatUnifiedTaskEnvelope(task, "musicLyrics", input.lyricsVersionId);
}

export async function queueMusicLibraryCompilePrompt(input: {
  projectId: number;
  editionId: number;
  model?: string;
  instruction?: string;
  effectiveMusicDurationSec?: number;
  requestedDurationSec?: number;
  lyricsVersionId?: number | null;
}) {
  await assertProject(input.projectId);
  const model = await resolveMusicExecutionModel(input);
  await assertModelSpecificMusicPrompt(model);
  const edition = await u.db("o_musicLibraryEdition" as any).where({ projectId: input.projectId, id: input.editionId }).first();
  if (!edition) throw new Error("Music library edition does not exist");
  const task = await createUnifiedTask({
    projectId: input.projectId,
    taskClass: "Music library prompt compile",
    taskType: "prompt",
    status: "queued",
    phase: "queued",
    targetType: "musicPrompt",
    targetId: input.editionId,
    businessType: "music-library-prompt",
    businessId: input.editionId,
    handler: "music-library-compile-prompt",
    payload: { ...input, model, promptMode: "modelSpecific" },
    priority: 70,
    model,
    describe: "Compile project music work prompt",
  });
  return formatUnifiedTaskEnvelope(task, "musicPrompt", input.editionId);
}

export async function queueGenericMusicLibraryPrompt(input: {
  projectId: number;
  editionId: number;
  instruction?: string;
  effectiveMusicDurationSec?: number;
  requestedDurationSec?: number;
  lyricsVersionId?: number | null;
}) {
  await assertProject(input.projectId);
  const edition = await u.db("o_musicLibraryEdition" as any).where({ projectId: input.projectId, id: input.editionId }).first();
  if (!edition) throw new Error("Music library edition does not exist");
  const task = await createUnifiedTask({
    projectId: input.projectId,
    taskClass: "Generic music library prompt compile",
    taskType: "prompt",
    status: "queued",
    phase: "queued",
    targetType: "musicPrompt",
    targetId: input.editionId,
    businessType: "music-library-prompt",
    businessId: input.editionId,
    handler: "music-library-compile-prompt",
    payload: { ...input, promptMode: "generic" },
    priority: 70,
    describe: "Compile provider-neutral project music prompt",
  });
  return formatUnifiedTaskEnvelope(task, "musicPrompt", input.editionId);
}

export async function queueMusicLibraryGenerate(input: {
  projectId: number;
  editionId: number;
  promptVersionId: number;
  model?: string;
  lyricsVersionId?: number | null;
  acknowledgeWarnings?: boolean;
}) {
  await assertProject(input.projectId);
  const edition = await u.db("o_musicLibraryEdition" as any).where({ projectId: input.projectId, id: input.editionId }).first();
  if (!edition) throw new Error("Music library edition does not exist");
  const prompt = await u.db("o_musicPromptVersion" as any).where({ projectId: input.projectId, id: input.promptVersionId, targetType: "edition", editionId: input.editionId }).first();
  if (!prompt) throw new Error("Music prompt version does not belong to this edition");
  const model = await resolveMusicExecutionModel(input);
  const task = await createUnifiedTask({
    projectId: input.projectId,
    taskClass: "Music library audio generation",
    taskType: "audio",
    status: "queued",
    phase: "queued",
    targetType: "musicLibraryVersion",
    targetId: input.editionId,
    businessType: "music-library-version",
    businessId: input.editionId,
    handler: "music-library-generate",
    payload: { ...input, model },
    priority: 80,
    model,
    describe: "Generate project music work audio",
  });
  return formatUnifiedTaskEnvelope(task, "musicLibraryVersion", input.editionId);
}

export async function queueMusicLibraryTrim(input: {
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
  await assertProject(input.projectId);
  const source = await u.db("o_musicLibraryVersion" as any).where({ projectId: input.projectId, id: input.sourceLibraryVersionId }).first();
  if (!source) throw new Error("Music library version does not exist");
  const task = await createUnifiedTask({
    projectId: input.projectId,
    taskClass: "Music audio trim",
    taskType: "audio",
    status: "queued",
    phase: "queued",
    targetType: "musicLibraryVersion",
    targetId: input.sourceLibraryVersionId,
    businessType: "music-library-trim",
    businessId: input.sourceLibraryVersionId,
    handler: "music-audio-trim",
    payload: input,
    priority: 60,
    describe: "Create a trimmed derivative music version",
  });
  return formatUnifiedTaskEnvelope(task, "musicLibraryVersion", input.sourceLibraryVersionId);
}

export async function queueProjectContextPackGenerate(input: { projectId: number; instruction?: string; previousContent?: string }) {
  await assertProject(input.projectId);
  const payload = {
    ...input,
    previousContent: input.previousContent ? String(input.previousContent).slice(0, 12000) : undefined,
  };
  const task = await createUnifiedTask({
    projectId: input.projectId,
    taskClass: "Project context pack generation",
    taskType: "prompt",
    status: "queued",
    phase: "queued",
    targetType: "projectContextPack",
    targetId: "project",
    businessType: "project-context-pack",
    businessId: input.projectId,
    handler: "project-context-pack-generate",
    payload,
    priority: 60,
    describe: "Generate project context pack",
  });
  return formatUnifiedTaskEnvelope(task, "projectContextPack", "project");
}
