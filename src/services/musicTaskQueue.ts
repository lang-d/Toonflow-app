import u from "@/utils";
import { createUnifiedTask, formatUnifiedTaskEnvelope, type UnifiedTaskEnvelope } from "@/services/taskCoordinator";
import { latestMusicBible } from "@/services/musicDirector";

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

export async function queueMusicCueCompilePrompt(input: { projectId: number; cueId: number; model: string; instruction?: string }) {
  const cue = await assertCue(input.projectId, input.cueId);
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
    payload: input,
    priority: 70,
    model: input.model,
    describe: "Compile music cue prompt",
  });
  return formatUnifiedTaskEnvelope(task, "musicPrompt", input.cueId);
}

export async function queueMusicCueReviewPrompt(input: {
  projectId: number;
  cueId: number;
  model: string;
  prompt: string;
  compiledPromptJson?: unknown;
}) {
  const cue = await assertCue(input.projectId, input.cueId);
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
    model: input.model,
    describe: "Review music cue prompt",
  });
  return formatUnifiedTaskEnvelope(task, "musicPrompt", input.cueId);
}

export async function queueMusicCueGenerate(input: {
  projectId: number;
  cueId: number;
  model: string;
  instruction?: string;
  select?: boolean;
}) {
  const cue = await assertCue(input.projectId, input.cueId);
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
    payload: input,
    priority: 80,
    model: input.model,
    describe: "Generate music cue audio",
  });
  return formatUnifiedTaskEnvelope(task, "musicCueAsset", input.cueId);
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
