import u from "@/utils";
import { ProductionReviewTargetType } from "@/services/productionReview";
import { buildStoryboardVideoFact, StoryboardVideoFact } from "@/services/storyboardFacts";
import { invokeAiObjectWithFallback } from "@/services/aiJsonObject";
import { z } from "zod";

export interface ResolveReviewBatchInput {
  projectId: number;
  scriptId?: number;
  targetType: ProductionReviewTargetType;
  targetId: string | number;
  acceptSuggestionIds?: number[];
  ignoreSuggestionIds?: number[];
  userInstruction?: string;
  actions?: Array<{
    suggestionId: number;
    action: "accept" | "ignore" | "revise";
    instruction?: string;
  }>;
}

type TargetScope = {
  track: any | null;
  trackId: string;
  groupKeys: Set<string>;
  storyboardIds: Set<string>;
};

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

function uniqueNumbers(values: unknown[] = []) {
  return [...new Set(values.map((value) => Number(value)).filter(Number.isFinite))];
}

const videoPromptRevisionSchema = z.object({
  prompt: z.string().min(1),
  changeSummary: z.string(),
  notes: z.array(z.string()).default([]),
});

function normalizeSuggestion(row: any) {
  return {
    ...row,
    targetId: row.targetId != null && /^\d+$/.test(String(row.targetId)) ? Number(row.targetId) : row.targetId,
    proposedPatch: parseJson(row.proposedPatch),
  };
}

async function loadSuggestionsByIds(input: ResolveReviewBatchInput, ids: number[]) {
  if (!ids.length) return [];
  const rows = await u
    .db("o_productionReviewSuggestion")
    .whereIn("id", ids)
    .where({ projectId: input.projectId });
  if (rows.length !== ids.length) {
    throw new Error("部分审校建议不存在，或不属于当前项目");
  }
  return rows.map(normalizeSuggestion);
}

async function getTargetScope(input: ResolveReviewBatchInput): Promise<TargetScope> {
  if (input.targetType !== "videoPrompt") {
    return {
      track: null,
      trackId: String(input.targetId),
      groupKeys: new Set<string>([String(input.targetId)]),
      storyboardIds: new Set<string>(),
    };
  }

  const track = await u
    .db("o_videoTrack")
    .where({ id: Number(input.targetId), projectId: input.projectId })
    .modify((qb: any) => {
      if (input.scriptId != null) qb.where("scriptId", input.scriptId);
    })
    .first();
  if (!track) throw new Error("视频轨道不存在");

  const storyboards = await u
    .db("o_storyboard")
    .where({ trackId: Number(track.id), projectId: input.projectId })
    .modify((qb: any) => {
      if (input.scriptId != null) qb.where("scriptId", input.scriptId);
    })
    .select("id");

  return {
    track,
    trackId: String(track.id),
    groupKeys: new Set([String(track.id), String(track.groupKey || "")].filter(Boolean)),
    storyboardIds: new Set(storyboards.map((row: any) => String(row.id))),
  };
}

function isSuggestionInScope(input: ResolveReviewBatchInput, scope: TargetScope, suggestion: any) {
  const targetId = String(suggestion.targetId);
  if (input.targetType !== "videoPrompt") {
    return suggestion.targetType === input.targetType && targetId === String(input.targetId);
  }
  const patchTrackId = suggestion.proposedPatch?.trackId ?? suggestion.proposedPatch?.targetTrackId;
  if (patchTrackId != null && String(patchTrackId) === scope.trackId) return true;
  if (suggestion.targetType === "videoPrompt") return targetId === scope.trackId;
  if (suggestion.targetType === "storyboardGroup" || suggestion.targetType === "bgmSuggestion") {
    return scope.groupKeys.has(targetId);
  }
  if (suggestion.targetType === "storyboard" || suggestion.targetType === "storyboardImage") {
    return scope.storyboardIds.has(targetId);
  }
  return false;
}

function assertSuggestionsBelongToTarget(input: ResolveReviewBatchInput, scope: TargetScope, suggestions: any[]) {
  const invalid = suggestions.filter((item) => !isSuggestionInScope(input, scope, item));
  if (invalid.length) {
    throw new Error(`部分审校建议不属于当前处理目标: ${invalid.map((item) => item.id).join(",")}`);
  }
}

async function loadTrackStoryboards(trackId: number, projectId: number, scriptId?: number): Promise<StoryboardVideoFact[]> {
  const query = u
    .db("o_storyboard")
    .where({ trackId, projectId })
    .select(
      "id",
      "index",
      "duration",
      "tableRowJson",
      "factStatus",
      "shouldGenerateImage",
    )
    .orderBy("index", "asc")
    .orderBy("id", "asc");
  if (scriptId != null) query.where("scriptId", scriptId);
  const rows = await query;
  const ids = rows.map((row: any) => Number(row.id));
  const assetRows = ids.length
    ? await u.db("o_assets2Storyboard").whereIn("storyboardId", ids).orderBy("rowid").select("storyboardId", "assetId")
    : [];
  const assetMap = new Map<number, number[]>();
  for (const row of assetRows as any[]) {
    const storyboardId = Number(row.storyboardId);
    if (!assetMap.has(storyboardId)) assetMap.set(storyboardId, []);
    assetMap.get(storyboardId)!.push(Number(row.assetId));
  }
  return rows.map((row: any) => buildStoryboardVideoFact(row, assetMap.get(Number(row.id)) || []));
}

function summarizeSuggestion(item: any) {
  return {
    id: item.id,
    userAction: item.userAction || "accept",
    userInstruction: item.userInstruction || "",
    targetType: item.targetType,
    targetId: item.targetId,
    issueType: item.issueType,
    severity: item.severity,
    message: item.message,
    reason: item.reason,
    proposedAction: item.proposedAction,
    aiDraft: item.proposedPatch?.suggestedRevision || item.proposedPatch?.values?.prompt || "",
    guidance: item.proposedPatch?.safetyGuidance || item.proposedPatch?.guidance || "",
  };
}

function normalizeActions(input: ResolveReviewBatchInput) {
  const actionMap = new Map<number, { suggestionId: number; action: "accept" | "ignore" | "revise"; instruction?: string }>();
  for (const item of input.actions || []) {
    const suggestionId = Number(item?.suggestionId);
    if (!Number.isFinite(suggestionId)) continue;
    if (!["accept", "ignore", "revise"].includes(item.action)) continue;
    actionMap.set(suggestionId, {
      suggestionId,
      action: item.action,
      instruction: String(item.instruction || "").trim(),
    });
  }
  for (const id of uniqueNumbers(input.acceptSuggestionIds)) {
    if (!actionMap.has(id)) actionMap.set(id, { suggestionId: id, action: "accept" });
  }
  for (const id of uniqueNumbers(input.ignoreSuggestionIds)) {
    if (!actionMap.has(id)) actionMap.set(id, { suggestionId: id, action: "ignore" });
  }
  return [...actionMap.values()];
}

function attachActionContext(suggestions: any[], actionMap: Map<number, { action: string; instruction?: string }>) {
  return suggestions.map((item) => ({
    ...item,
    userAction: actionMap.get(Number(item.id))?.action || "accept",
    userInstruction: actionMap.get(Number(item.id))?.instruction || "",
  }));
}

async function resolveVideoPromptBatch(input: ResolveReviewBatchInput, acceptedSuggestions: any[], ignoredSuggestions: any[]) {
  const track = await u
    .db("o_videoTrack")
    .where({ id: Number(input.targetId), projectId: input.projectId })
    .modify((qb: any) => {
      if (input.scriptId != null) qb.where("scriptId", input.scriptId);
    })
    .first();
  if (!track) throw new Error("视频轨道不存在");

  const storyboards = await loadTrackStoryboards(Number(track.id), input.projectId, input.scriptId);
  const openSuggestions = await u
    .db("o_productionReviewSuggestion")
    .where({
      projectId: input.projectId,
      targetType: "videoPrompt",
      targetId: String(track.id),
      status: "open",
    })
    .modify((qb: any) => {
      if (input.scriptId != null) qb.where("scriptId", input.scriptId);
    })
    .orderBy("createTime", "asc");

  const selectedIds = new Set([...acceptedSuggestions, ...ignoredSuggestions].map((item) => Number(item.id)));
  const context = {
    target: {
      type: "videoPrompt",
      trackId: Number(track.id),
      currentPrompt: track.prompt || "",
      groupKey: track.groupKey,
      groupName: track.groupName,
      groupIntent: track.groupIntent,
      musicPlan: parseJson(track.musicPlanJson),
    },
    acceptedSuggestions: acceptedSuggestions.map(summarizeSuggestion),
    ignoredSuggestions: ignoredSuggestions.map(summarizeSuggestion),
    otherOpenSuggestions: openSuggestions
      .filter((item: any) => !selectedIds.has(Number(item.id)))
      .map((item: any) => ({
        id: item.id,
        issueType: item.issueType,
        severity: item.severity,
        message: item.message,
        reason: item.reason,
      })),
    userInstruction: input.userInstruction || "",
    storyboards,
  };

  const system = `你是 Toonflow 生产台的视频提示词修订助手。
用户已经审阅了一批审校建议，现在需要你根据“用户接受的建议”和“用户自己的补充意见”，一次性修订完整视频提示词。

修订规则：
- 只处理 acceptedSuggestions 和 userInstruction，不要处理 ignoredSuggestions，也不要擅自处理未选择的建议。
- acceptedSuggestions 中 userAction=accept 表示用户认可原建议；userAction=revise 表示用户认为这个问题存在，但要优先按该条的 userInstruction 调整。
- 如果全局 userInstruction 与某条建议的 userInstruction 同时存在，逐条 userInstruction 优先级更高。
- 不要只输出局部 patch，必须输出完整视频提示词。
- 不丢失台词、角色音色描述、参考音频绑定、画内音效。
- 画内音效允许保留或补强，例如脚步声、广播声、呼吸声、衣料摩擦声、环境声、动作声。
- BGM、配乐、OST、非画内音乐不能进入视频提示词。
- 不引入新剧情、新时间、新地点、新人物关系。
- 有分镜图、合图或参考图时，不重写与参考图冲突的站位、朝向、光影和色彩。
- 安全风险需要用更稳妥的表达方式处理：保留剧情意图，但弱化高风险动作细节、避免操作性犯罪/暴力描述、避免对未成年人造成不当呈现。
- 图片画质堆叠词、互相冲突的冗余描述、无依据视觉发明，可以重写为更清晰的表达。`;

  const result = await invokeAiObjectWithFallback({
    modelKey: "universalAi",
    system,
    schema: videoPromptRevisionSchema,
    label: "video prompt revision output",
    messages: [{ role: "user", content: JSON.stringify(context, null, 2) }],
  });
  return {
    prompt: result.prompt,
    changeSummary: result.changeSummary,
    notes: result.notes,
  };
}

export async function resolveReviewBatch(input: ResolveReviewBatchInput) {
  const actions = normalizeActions(input);
  const actionIdMap = new Map(actions.map((item) => [item.suggestionId, item]));
  const acceptIds = actions.filter((item) => item.action === "accept" || item.action === "revise").map((item) => item.suggestionId);
  const ignoreIds = actions.filter((item) => item.action === "ignore").map((item) => item.suggestionId);
  const overlap = acceptIds.filter((id) => ignoreIds.includes(id));
  if (overlap.length) throw new Error(`同一条建议不能同时接受和忽略: ${overlap.join(",")}`);

  const scope = await getTargetScope(input);
  const acceptedSuggestions = attachActionContext(await loadSuggestionsByIds(input, acceptIds), actionIdMap);
  const ignoredSuggestions = attachActionContext(await loadSuggestionsByIds(input, ignoreIds), actionIdMap);
  assertSuggestionsBelongToTarget(input, scope, [...acceptedSuggestions, ...ignoredSuggestions]);

  const shouldRevise = acceptIds.length > 0 || Boolean(input.userInstruction?.trim());
  if (shouldRevise && input.targetType !== "videoPrompt") {
    throw new Error("当前批量 AI 统一修订暂时只支持 videoPrompt 目标");
  }

  const revision = shouldRevise ? await resolveVideoPromptBatch(input, acceptedSuggestions, ignoredSuggestions) : null;

  await u.db.transaction(async (trx: any) => {
    if (ignoreIds.length) {
      await trx("o_productionReviewSuggestion").whereIn("id", ignoreIds).update({ status: "ignored", updateTime: now() });
    }
    const actionFeedback = actions.filter((item) => item.action === "revise" && item.instruction);
    if (input.userInstruction?.trim() || actionFeedback.length) {
      const feedbackTargets = actionFeedback.length
        ? actionFeedback
        : (acceptIds.length ? acceptIds : [0]).map((suggestionId) => ({
            suggestionId,
            instruction: input.userInstruction!.trim(),
          }));
      await trx("o_productionReviewFeedback").insert(
        feedbackTargets.map((item) => ({
          suggestionId: item.suggestionId,
          projectId: input.projectId,
          scriptId: input.scriptId ?? null,
          comment: item.instruction,
          mode: "resolve",
          createTime: now(),
        })),
      );
    }
    if (revision && input.targetType === "videoPrompt") {
      await trx("o_videoTrack").where({ id: Number(input.targetId), projectId: input.projectId }).update({
        prompt: revision.prompt,
        state: "已完成",
        reason: "",
      });
      if (acceptIds.length) {
        await trx("o_productionReviewSuggestion").whereIn("id", acceptIds).update({ status: "accepted", updateTime: now() });
      }
    }
  });

  return {
    targetType: input.targetType,
    targetId: input.targetId,
    acceptedSuggestionIds: acceptIds,
    ignoredSuggestionIds: ignoreIds,
    revised: Boolean(revision),
    revision,
  };
}
