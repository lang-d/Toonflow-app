import u from "@/utils";
import { listMusicCues, parseJsonValue, type MusicScopeMode } from "@/services/musicDirector";
import { getTaskSnapshot, type TaskEvent } from "@/services/taskCoordinator";

export type MusicStageStatus =
  | "idle"
  | "discussing"
  | "bible_generating"
  | "bible_reviewing"
  | "plan_generating"
  | "plan_reviewing"
  | "cue_prompting"
  | "audio_generating"
  | "completed"
  | "failed";

export type MusicStageStateInput = {
  projectId: number;
  scriptId?: number | null;
  mode?: MusicScopeMode;
};

const ACTIVE_STATUSES = new Set(["pending", "queued", "submitting", "processing"]);

export function musicProjectIsolationKey(projectId: number) {
  return `musicProductionAgent:${projectId}:project`;
}

export function musicEpisodeIsolationKey(projectId: number, scriptId: number) {
  return `musicProductionAgent:${projectId}:episode:${scriptId}`;
}

export function resolveMusicIsolationKey(input: MusicStageStateInput) {
  if (input.mode === "episode") {
    if (input.scriptId == null) throw new Error("scriptId is required in episode mode");
    return musicEpisodeIsolationKey(input.projectId, Number(input.scriptId));
  }
  return musicProjectIsolationKey(input.projectId);
}

function normalizeBible(row: any) {
  if (!row) return null;
  return {
    ...row,
    styleProfile: parseJsonValue(row.styleProfileJson, {}),
    sourceSummary: parseJsonValue(row.sourceSummaryJson, {}),
  };
}

function normalizePlan(row: any) {
  if (!row) return null;
  return {
    ...row,
    cueSheet: parseJsonValue(row.cueSheetJson, []),
  };
}

function deriveStageFromTask(task: any): MusicStageStatus | null {
  if (!task || !ACTIVE_STATUSES.has(String(task.status))) return null;
  switch (task.handler) {
    case "music-bible-generate":
      return "bible_generating";
    case "music-bible-review":
      return "bible_reviewing";
    case "music-plan-generate":
      return "plan_generating";
    case "music-plan-review":
      return "plan_reviewing";
    case "music-cue-compile-prompt":
    case "music-cue-review-prompt":
      return "cue_prompting";
    case "music-cue-generate":
      return "audio_generating";
    default:
      return null;
  }
}

async function assertMusicScope(input: Required<Pick<MusicStageStateInput, "projectId">> & MusicStageStateInput) {
  const project = await u.db("o_project").where("id", input.projectId).first("id");
  if (!project) throw new Error("Project does not exist");
  if (input.mode === "episode") {
    if (input.scriptId == null) throw new Error("scriptId is required in episode mode");
    const script = await u.db("o_script").where({ projectId: input.projectId, id: input.scriptId }).first("id");
    if (!script) throw new Error("Script does not exist or does not belong to this project");
  }
}

export async function getMusicStageState(input: MusicStageStateInput) {
  const mode = input.mode || (input.scriptId == null ? "project" : "episode");
  const scoped = { ...input, mode };
  await assertMusicScope(scoped);

  const latestBible = await u
    .db("o_musicBible")
    .where({ projectId: input.projectId, state: "complete" })
    .orderBy("version", "desc")
    .orderBy("id", "desc")
    .first();

  const latestPlan = await u
    .db("o_musicPlan")
    .where({ projectId: input.projectId })
    .modify((qb: any) => {
      if (mode === "episode") qb.where("scriptId", input.scriptId);
      if (mode !== "episode") qb.where("mode", mode).whereNull("scriptId");
    })
    .where("state", "complete")
    .orderBy("version", "desc")
    .orderBy("id", "desc")
    .first();

  const cues = latestPlan
    ? await listMusicCues({ projectId: input.projectId, planId: Number(latestPlan.id) })
    : [];
  const tasks = await getTaskSnapshot({
    projectId: input.projectId,
    ...(mode === "episode" && input.scriptId != null ? { scriptId: Number(input.scriptId) } : {}),
  });
  const musicTasks = tasks.filter((task: TaskEvent) =>
    ["musicBible", "musicPlan", "musicPrompt", "musicCueAsset"].includes(String(task.targetType || "")),
  );

  const activeDbTask = await u
    .db("o_tasks")
    .where({ projectId: input.projectId })
    .modify((qb: any) => {
      if (mode === "episode" && input.scriptId != null) qb.where((b: any) => b.where("scriptId", input.scriptId).orWhere("episode", input.scriptId));
    })
    .whereIn("status", Array.from(ACTIVE_STATUSES))
    .whereIn("handler", [
      "music-bible-generate",
      "music-bible-review",
      "music-plan-generate",
      "music-plan-review",
      "music-cue-compile-prompt",
      "music-cue-review-prompt",
      "music-cue-generate",
    ])
    .orderBy("updateTime", "desc")
    .first();

  const failedTask = await u
    .db("o_tasks")
    .where({ projectId: input.projectId, status: "failed" })
    .modify((qb: any) => {
      if (mode === "episode" && input.scriptId != null) qb.where((b: any) => b.where("scriptId", input.scriptId).orWhere("episode", input.scriptId));
    })
    .whereIn("targetType", ["musicBible", "musicPlan", "musicPrompt", "musicCueAsset"])
    .orderBy("updateTime", "desc")
    .first();

  const activeStage = deriveStageFromTask(activeDbTask);
  const hasCompletedAsset = cues.some((cue: any) => (cue.assets || []).some((asset: any) => asset.state === "complete"));
  const stage: MusicStageStatus =
    activeStage ||
    (failedTask && !latestPlan && !latestBible ? "failed" : null) ||
    (hasCompletedAsset || latestPlan || latestBible ? "completed" : "idle");

  const projectMemoryKey = musicProjectIsolationKey(input.projectId);
  const episodeMemoryKey =
    input.scriptId == null ? null : musicEpisodeIsolationKey(input.projectId, Number(input.scriptId));

  return {
    stage,
    mode,
    projectId: input.projectId,
    scriptId: input.scriptId ?? null,
    isolationKey: resolveMusicIsolationKey(scoped),
    projectMemoryKey,
    episodeMemoryKey,
    latestBible: normalizeBible(latestBible),
    latestPlan: normalizePlan(latestPlan),
    cueCount: cues.length,
    assetCount: cues.reduce((sum: number, cue: any) => sum + Number((cue.assets || []).length), 0),
    activeTasks: musicTasks as TaskEvent[],
    lastFailedTask: failedTask
      ? {
          taskId: failedTask.taskId,
          legacyTaskId: failedTask.id,
          targetType: failedTask.targetType,
          targetId: failedTask.targetId,
          reason: failedTask.reason,
          updateTime: failedTask.updateTime,
        }
      : null,
  };
}
