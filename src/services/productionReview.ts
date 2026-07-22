import u from "@/utils";

export type ProductionReviewTargetType =
  | "directorPlan"
  | "asset"
  | "deriveAsset"
  | "storyboardTable"
  | "storyboard"
  | "storyboardGroup"
  | "storyboardImage"
  | "videoPrompt"
  | "musicBible"
  | "musicPlan"
  | "musicCue"
  | "musicPrompt"
  | "musicLibraryItem"
  | "musicLibraryVersion"
  | "musicLyrics"
  | "bgmSuggestion"
  | "videoResult";

export type ProductionReviewSeverity = "info" | "warning" | "blocking";
export type ProductionReviewStatus = "open" | "accepted" | "ignored" | "revised" | "resolved";

export interface ProductionReviewSuggestionInput {
  projectId: number;
  scriptId?: number | null;
  targetType: ProductionReviewTargetType;
  targetId: string | number;
  parentId?: number | null;
  version?: number;
  issueType: string;
  severity: ProductionReviewSeverity;
  message: string;
  reason?: string;
  proposedAction?: string;
  proposedPatch?: unknown;
}

export interface StoryboardTableAgentReviewItem {
  scope: "global" | "storyboard" | "director_plan" | "asset";
  storyboardId?: number;
  storyboardIndex?: number;
  issueType: string;
  severity: ProductionReviewSeverity;
  field: string;
  message: string;
  reason: string;
  suggestedAction: string;
  owner: "storyboardTable" | "deriveAssets" | "directorPlan";
}

function now() {
  return Date.now();
}

function parseJson(value: unknown) {
  if (!value || typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeJson(value: unknown) {
  return value == null ? null : JSON.stringify(value);
}

function normalizeSuggestion(row: any) {
  return {
    ...row,
    targetId: row.targetId != null && /^\d+$/.test(String(row.targetId)) ? Number(row.targetId) : row.targetId,
    proposedPatch: parseJson(row.proposedPatch),
  };
}

export async function listReviewSuggestions(filter: {
  projectId: number;
  scriptId?: number;
  targetType?: string;
  targetId?: string | number;
  status?: string;
}) {
  const rows = await u
    .db("o_productionReviewSuggestion")
    .where("projectId", filter.projectId)
    .modify((qb: any) => {
      if (filter.scriptId != null) qb.where("scriptId", filter.scriptId);
      if (filter.targetType) qb.where("targetType", filter.targetType);
      if (filter.targetId != null) qb.where("targetId", String(filter.targetId));
      if (filter.status) qb.where("status", filter.status);
    })
    .orderBy("createTime", "desc");
  return rows.map(normalizeSuggestion);
}

export async function getReviewSuggestion(id: number) {
  const row = await u.db("o_productionReviewSuggestion").where("id", id).first();
  return row ? normalizeSuggestion(row) : null;
}

export async function upsertReviewSuggestion(input: ProductionReviewSuggestionInput) {
  const existing = await u
    .db("o_productionReviewSuggestion")
    .where({
      projectId: input.projectId,
      targetType: input.targetType,
      targetId: String(input.targetId),
      issueType: input.issueType,
      status: "open",
    })
    .modify((qb: any) => {
      if (input.scriptId == null) qb.whereNull("scriptId");
      else qb.where("scriptId", input.scriptId);
    })
    .first();
  const row = {
    projectId: input.projectId,
    scriptId: input.scriptId ?? null,
    targetType: input.targetType,
    targetId: String(input.targetId),
    parentId: input.parentId ?? null,
    version: input.version ?? Number(existing?.version ?? 1),
    issueType: input.issueType,
    severity: input.severity,
    message: input.message,
    reason: input.reason ?? "",
    proposedAction: input.proposedAction ?? "",
    proposedPatch: serializeJson(input.proposedPatch),
    status: "open",
    updateTime: now(),
  };
  if (existing) {
    await u.db("o_productionReviewSuggestion").where("id", existing.id).update(row);
    return getReviewSuggestion(Number(existing.id));
  }
  const [id] = await u.db("o_productionReviewSuggestion").insert({ ...row, createTime: now() });
  return getReviewSuggestion(Number(id));
}

/**
 * Replaces the current independent storyboard-table audit report. The audit is
 * advisory: it never applies a patch to storyboard facts.
 */
export async function replaceStoryboardTableAgentReviewSuggestions(input: {
  projectId: number;
  scriptId: number;
  items: StoryboardTableAgentReviewItem[];
}) {
  const timestamp = now();
  return u.db.transaction(async (trx: any) => {
    await trx("o_productionReviewSuggestion")
      .where({
        projectId: input.projectId,
        scriptId: input.scriptId,
        status: "open",
      })
      .whereIn("targetType", ["storyboard", "storyboardTable"])
      .where("issueType", "like", "storyboard_table_agent:%")
      .update({ status: "resolved", updateTime: timestamp });

    const suggestionIds: number[] = [];
    for (const item of input.items) {
      const targetType = item.scope === "storyboard" ? "storyboard" : "storyboardTable";
      const targetId = item.scope === "storyboard" ? String(item.storyboardId) : String(input.scriptId);
      const [id] = await trx("o_productionReviewSuggestion").insert({
        projectId: input.projectId,
        scriptId: input.scriptId,
        targetType,
        targetId,
        parentId: null,
        version: 1,
        issueType: `storyboard_table_agent:${item.issueType}`,
        severity: item.severity,
        message: item.message,
        reason: item.reason,
        proposedAction: item.suggestedAction,
        proposedPatch: serializeJson({
          source: "supervisionStoryboardTable",
          scope: item.scope,
          storyboardIndex: item.storyboardIndex,
          field: item.field,
          owner: item.owner,
          advisory: true,
        }),
        status: "open",
        createTime: timestamp,
        updateTime: timestamp,
      });
      suggestionIds.push(Number(id));
    }
    return { suggestionIds, count: suggestionIds.length, reviewedAt: timestamp };
  });
}

export async function acceptReviewSuggestion(id: number) {
  return u.db.transaction(async (trx: any) => {
    const row = await trx("o_productionReviewSuggestion").where("id", id).first();
    if (!row) throw new Error("Review suggestion does not exist");
    const suggestion = normalizeSuggestion(row);
    await trx("o_productionReviewSuggestion").where("id", id).update({
      status: "accepted",
      updateTime: now(),
    });
    return {
      ...suggestion,
      status: "accepted",
      applyResult: {
        applied: false,
        reason: "Accepted suggestions are now applied through /production/review/resolveBatch so AI can revise the full target in one pass.",
      },
    };
  });
}

export async function ignoreReviewSuggestion(id: number) {
  await u.db("o_productionReviewSuggestion").where("id", id).update({ status: "ignored", updateTime: now() });
  return getReviewSuggestion(id);
}

export async function createReviewFeedback(input: {
  suggestionId: number;
  comment: string;
  mode: "note" | "recalculate";
}) {
  const suggestion = await getReviewSuggestion(input.suggestionId);
  if (!suggestion) throw new Error("Review suggestion does not exist");
  const [id] = await u.db("o_productionReviewFeedback").insert({
    suggestionId: input.suggestionId,
    projectId: suggestion.projectId,
    scriptId: suggestion.scriptId ?? null,
    comment: input.comment,
    mode: input.mode,
    createTime: now(),
  });
  if (input.mode === "recalculate") {
    await u.db("o_productionReviewSuggestion").where("id", input.suggestionId).update({
      status: "revised",
      updateTime: now(),
    });
    return { id, suggestion: { ...suggestion, status: "revised" } };
  }
  return { id, suggestion };
}

export async function rollbackReviewSuggestion(id: number) {
  const suggestion = await getReviewSuggestion(id);
  if (!suggestion) throw new Error("Review suggestion does not exist");
  const patch = suggestion.proposedPatch || {};
  const previous = patch.previous;
  if (!previous) {
    await u.db("o_productionReviewSuggestion").where("id", id).update({ status: "resolved", updateTime: now() });
    return { rolledBack: false, reason: "No previous snapshot on this suggestion" };
  }
  await u.db.transaction(async (trx: any) => {
    if (patch.op === "update_video_track") {
      await trx("o_videoTrack").where("id", Number(suggestion.targetId)).update(previous);
    } else if (patch.op === "update_storyboard") {
      await trx("o_storyboard").where("id", Number(suggestion.targetId)).update(previous);
    }
    await trx("o_productionReviewSuggestion").where("id", id).update({ status: "resolved", updateTime: now() });
  });
  return { rolledBack: true };
}
