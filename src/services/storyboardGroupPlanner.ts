import { buildTrackBgmSuggestion, TrackBgmSuggestion } from "@/services/musicSuggestion";
import { getProjectDefaultVideoPolicy, VideoDurationPolicy } from "@/services/videoModelPolicy";
import { parseStoryboardTableRow } from "@/services/storyboardTableContract";

export interface StoryboardGroupPlan {
  groupKey: string;
  groupName: string;
  storyboardIndexes: number[];
  scene: string;
  event: string;
  totalDuration: number;
  pacing: string;
  groupIntent: string;
  boundaryReason: string;
  warnings: Array<{
    issueType: string;
    severity: "info" | "warning" | "blocking";
    message: string;
    reason?: string;
  }>;
  bgmSuggestion: TrackBgmSuggestion;
}

export interface StoryboardGroupMeta {
  groupKey: string;
  groupName: string;
  groupIntent: string;
  beatId?: string;
}

function safeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function compactKey(value: string) {
  return value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export function fallbackGroupKey(index: number) {
  return `G${String(index + 1).padStart(2, "0")}`;
}

export function deriveStoryboardGroupMeta(item: any, index: number): StoryboardGroupMeta {
  const fact = parseStoryboardTableRow(item.tableRowJson);
  const rawKey = safeText(fact?.groupKey) || safeText(item.groupKey) || safeText(item.track);
  const groupKey = compactKey(rawKey) || fallbackGroupKey(index);
  const groupName = safeText(fact?.groupName) || safeText(item.groupName) || safeText(item.track) || groupKey;
  const groupIntent =
    safeText(fact?.groupIntent) || safeText(item.groupIntent) || safeText(item.action) || safeText(item.picture) || groupName;
  return {
    groupKey,
    groupName,
    groupIntent,
    beatId: safeText(fact?.beatId) || safeText(item.beatId) || undefined,
  };
}

export function buildStoryboardGroupPlans(
  rows: any[],
  options: { durationPolicy?: VideoDurationPolicy } = {},
): StoryboardGroupPlan[] {
  const buckets = new Map<string, any[]>();
  rows.forEach((row, index) => {
    const meta = deriveStoryboardGroupMeta(row, index);
    const fact = parseStoryboardTableRow(row.tableRowJson);
    row.groupKey = row.groupKey || meta.groupKey;
    row.groupName = row.groupName || meta.groupName;
    row.groupIntent = row.groupIntent || meta.groupIntent;
    row.duration = fact?.durationSec ?? row.duration;
    row.location = fact?.location ?? row.location;
    row.scene = fact?.location ?? row.scene;
    if (!buckets.has(meta.groupKey)) buckets.set(meta.groupKey, []);
    buckets.get(meta.groupKey)?.push(row);
  });

  return [...buckets.entries()].map(([groupKey, groupRows]) => {
    const first = groupRows[0] || {};
    const totalDuration = groupRows.reduce((sum, row) => sum + (Number(row.duration) || 0), 0);
    const warnings: StoryboardGroupPlan["warnings"] = [];
    const scenes = new Set(groupRows.map((row) => safeText(row.location) || safeText(row.scene) || safeText(row.track)).filter(Boolean));
    const durationPolicy = options.durationPolicy;

    if (scenes.size > 1) {
      warnings.push({
        issueType: "group_cross_scene",
        severity: "blocking",
        message: "Storyboard group may cross scene boundaries.",
        reason: [...scenes].join(" / "),
      });
    }

    if (durationPolicy && totalDuration > durationPolicy.maxDuration) {
      warnings.push({
        issueType: "group_duration_exceeds_model",
        severity: durationPolicy.canValidate ? "blocking" : "warning",
        message: "Storyboard group duration exceeds the default video model capacity.",
        reason: `duration=${totalDuration}s, model=${durationPolicy.modelLabel}, max=${durationPolicy.maxDuration}s, resolution=${durationPolicy.resolution || "default"}`,
      });
    }

    if (groupRows.length > 6) {
      warnings.push({
        issueType: "group_pacing_dragging",
        severity: "warning",
        message: "Storyboard group contains many shots and may feel slow for short drama pacing.",
        reason: `shots=${groupRows.length}`,
      });
    }

    const groupIntent = safeText(first.groupIntent) || safeText(first.action) || safeText(first.picture);
    return {
      groupKey,
      groupName: safeText(first.groupName) || groupKey,
      storyboardIndexes: groupRows.map((row) => Number(row.index ?? row.id)).filter(Number.isFinite),
      scene: safeText(first.location) || safeText(first.scene) || safeText(first.track) || "",
      event: groupIntent,
      totalDuration,
      pacing: totalDuration <= 6 ? "fast" : totalDuration <= 12 ? "medium" : "slow",
      groupIntent,
      boundaryReason: "Generated from storyboard table groupKey. New scene/time/event should use a new group.",
      warnings,
      bgmSuggestion: buildTrackBgmSuggestion({
        groupKey,
        scene: safeText(first.track),
        event: groupIntent,
        groupIntent,
        totalDuration,
      }),
    };
  });
}

export async function syncVideoTracksForStoryboards(
  trx: any,
  params: { projectId: number; scriptId: number; storyboards: any[]; durationPolicy?: VideoDurationPolicy },
) {
  const durationPolicy = params.durationPolicy ?? (await getProjectDefaultVideoPolicy(params.projectId, { knex: trx }));
  const plans = buildStoryboardGroupPlans(params.storyboards, { durationPolicy });
  for (const plan of plans) {
    const storyboardIds = params.storyboards.filter((row) => row.groupKey === plan.groupKey).map((row) => Number(row.id));
    const duration = plan.totalDuration;
    const existing = await trx("o_videoTrack")
      .where({ projectId: params.projectId, scriptId: params.scriptId, groupKey: plan.groupKey })
      .modify((query: any) => {
        query.where("archived", 0);
      })
      .first();
    let trackId = Number(existing?.id);
    if (existing) {
      await trx("o_videoTrack")
        .where("id", trackId)
        .update({
          duration,
          groupName: plan.groupName,
          groupIntent: plan.groupIntent,
          groupPlanJson: JSON.stringify(plan),
          musicPlanJson: JSON.stringify(plan.bgmSuggestion),
          reviewState: plan.warnings.some((item) => item.severity === "blocking")
            ? "blocked"
            : plan.warnings.length
              ? "hasIssues"
              : "pending",
          reviewIssuesJson: JSON.stringify(plan.warnings),
        });
    } else {
      const [insertedId] = await trx("o_videoTrack").insert({
        scriptId: params.scriptId,
        projectId: params.projectId,
        duration,
        groupKey: plan.groupKey,
        groupName: plan.groupName,
        groupIntent: plan.groupIntent,
        groupPlanJson: JSON.stringify(plan),
        musicPlanJson: JSON.stringify(plan.bgmSuggestion),
        reviewState: plan.warnings.some((item) => item.severity === "blocking")
          ? "blocked"
          : plan.warnings.length
            ? "hasIssues"
            : "pending",
        reviewIssuesJson: JSON.stringify(plan.warnings),
        archived: 0,
      });
      trackId = Number(insertedId);
    }
    await trx("o_storyboard").whereIn("id", storyboardIds).update({
      trackId,
      groupKey: plan.groupKey,
      groupName: plan.groupName,
      groupIntent: plan.groupIntent,
    });
  }
  return plans;
}
