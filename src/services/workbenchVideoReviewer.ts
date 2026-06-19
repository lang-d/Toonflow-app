import u from "@/utils";
import { inspectVideoPromptEngineering } from "@/services/videoPromptSafetyGuard";
import { upsertReviewSuggestion } from "@/services/productionReview";
import { buildStoryboardVideoFact } from "@/services/storyboardFacts";
import { invokeAiObjectWithFallback, parseAiJsonValue } from "@/services/aiJsonObject";
import { z } from "zod";

function parseJsonArray(value: unknown) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const videoReviewOutputSchema = z.object({
  issues: z.array(
    z.object({
      issueType: z.string(),
      severity: z.enum(["info", "warning", "blocking"]),
      evidence: z.string(),
      reason: z.string(),
      suggestedRevision: z.string().optional(),
    }),
  ),
});

type VideoReviewIssue = z.infer<typeof videoReviewOutputSchema>["issues"][number];

function normalizeSeverity(value: unknown): "info" | "warning" | "blocking" {
  const text = String(value || "").trim().toLowerCase();
  if (["blocking", "block", "blocked", "error", "critical", "high", "严重", "阻断", "阻塞"].includes(text)) return "blocking";
  if (["warning", "warn", "medium", "中", "警告", "提醒"].includes(text)) return "warning";
  return "info";
}

function normalizeIssueType(value: unknown) {
  const text = String(value || "").trim();
  if (
    [
      "prompt_pollution",
      "abstract_emotion",
      "continuity_conflict",
      "bgm_in_prompt",
      "safety_risk",
      "model_mismatch",
    ].includes(text)
  ) {
    return text;
  }
  return "ai_review";
}

function pickText(item: any, keys: string[]) {
  for (const key of keys) {
    const value = item?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeReviewIssue(item: unknown): VideoReviewIssue | null {
  if (!item || typeof item !== "object") return null;
  const value = item as any;
  const evidence = pickText(value, ["evidence", "message", "description", "summary", "problem"]);
  const reason = pickText(value, ["reason", "rationale", "why", "explanation", "detail", "details"]);
  const suggestedRevision = pickText(value, ["suggestedRevision", "suggestion", "revision", "rewrite", "proposedRevision"]);
  if (!evidence && !reason && !suggestedRevision) return null;
  return {
    issueType: normalizeIssueType(value.issueType ?? value.type ?? value.category ?? value.kind),
    severity: normalizeSeverity(value.severity ?? value.level ?? value.priority),
    evidence: evidence || reason || "AI 审校发现视频提示词可能需要调整。",
    reason: reason || evidence || "",
    ...(suggestedRevision ? { suggestedRevision } : {}),
  };
}

function normalizeVideoReviewOutput(value: unknown) {
  const rawIssues = Array.isArray(value)
    ? value
    : Array.isArray((value as any)?.issues)
      ? (value as any).issues
      : Array.isArray((value as any)?.suggestions)
        ? (value as any).suggestions
        : Array.isArray((value as any)?.problems)
          ? (value as any).problems
          : Array.isArray((value as any)?.items)
            ? (value as any).items
            : null;
  if (!rawIssues) throw new Error("video prompt review output must be an object with issues[] or a JSON array");
  return {
    issues: rawIssues.map(normalizeReviewIssue).filter((item: VideoReviewIssue | null): item is VideoReviewIssue => Boolean(item)),
  };
}

function parseVideoReviewFallbackText(text: string) {
  return normalizeVideoReviewOutput(parseAiJsonValue(text, "video prompt review output"));
}

function aiReviewErrorMessage(error: unknown) {
  const message = String((error as any)?.message || error || "AI review failed");
  return message.slice(0, 2000);
}

async function buildTrackReviewContext(track: any) {
  const rows = await u
    .db("o_storyboard")
    .where("trackId", track.id)
    .orderBy("index", "asc")
    .select(
      "id",
      "index",
      "tableRowJson",
      "factStatus",
      "filePath",
    );
  const storyboards = rows.map((row: any) => buildStoryboardVideoFact(row));
  return {
    track: {
      id: track.id,
      groupKey: track.groupKey,
      groupName: track.groupName,
      groupIntent: track.groupIntent,
      duration: track.duration,
      prompt: track.prompt || "",
      musicPlan: parseJsonArray(track.musicPlanJson),
      reviewState: track.reviewState,
    },
    storyboards,
  };
}

async function reviewPromptWithAi(track: any) {
  const context = await buildTrackReviewContext(track);
  const system = `You are Toonflow's production video-prompt reviewer.
Review the candidate video prompt against storyboard facts, group facts, model usability, and safety.
Do not use regex-style word deletion. Judge the prompt semantically.
Return valid JSON in this exact shape:
{"issues":[{"issueType":"prompt_pollution|abstract_emotion|continuity_conflict|bgm_in_prompt|safety_risk|model_mismatch|ai_review","severity":"info|warning|blocking","evidence":"short quote or observation","reason":"why it matters","suggestedRevision":"optional complete rewrite draft"}]}
If there are no issues, return {"issues":[]}.

Rules:
- warning/info do not block generation.
- blocking is only for high-risk safety, missing required model inputs, or severe continuity conflict.
- Dialogue, voice description, reference-audio binding and diegetic sound effects are useful video-prompt information; never classify them as prompt pollution by themselves.
- Diegetic sound effects are allowed and often necessary: footsteps, breathing, fabric rustle, station ambience, broadcast voice, door sounds, action sounds.
- BGM, soundtrack, score, OST and non-diegetic music are post-production metadata and must not appear in video generation prompts.
- prompt_pollution is only for image-quality keyword piles, mutually conflicting redundant descriptions, or visual facts invented without support.
- Safety review must explicitly consider minors, coercion, abduction/crime guidance, violence, real-person or sensitive-identity misuse, and expressions likely to be rejected by video providers.
- A safety_risk or blocking item must include suggestedRevision. Do not only say "blocked"; tell the editor how to preserve story intent while softening risky action details, avoiding procedural crime/violence, and keeping the scene generatable.
- If storyboard images are present, do not invent conflicting lighting, palette, character position or facing direction.
- Do not produce final database patches. If a rewrite idea is useful, put it in suggestedRevision as a draft for later batch AI revision.`;
  const result = await invokeAiObjectWithFallback({
    modelKey: "universalAi",
    system,
    schema: videoReviewOutputSchema,
    label: "video prompt review output",
    fallbackTextParser: parseVideoReviewFallbackText,
    messages: [
      {
        role: "user",
        content: JSON.stringify(context, null, 2),
      },
    ],
  });
  return result.issues;
}

export async function reviewVideoTracks(input: { projectId: number; scriptId?: number; trackIds?: number[] }) {
  const tracks = await u
    .db("o_videoTrack")
    .where("projectId", input.projectId)
    .modify((qb: any) => {
      if (input.scriptId != null) qb.where("scriptId", input.scriptId);
      if (input.trackIds?.length) qb.whereIn("id", input.trackIds);
    });
  const suggestions = [];
  for (const track of tracks) {
    const prompt = String(track.prompt || "");
    const engineering = inspectVideoPromptEngineering(prompt);
    if (engineering.issues.length) {
      for (const issue of engineering.issues) {
        suggestions.push(
          await upsertReviewSuggestion({
            projectId: input.projectId,
            scriptId: track.scriptId,
            targetType: "videoPrompt",
            targetId: track.id,
            issueType: issue.issueType,
            severity: issue.severity,
            message: issue.message,
            reason: issue.reason || prompt.slice(0, 300),
            proposedAction: "请先生成或手动填写可用的视频提示词。",
            proposedPatch: { op: "review_only", trackId: track.id },
          }),
        );
      }
    }
    if (prompt.trim()) {
      let aiIssues: VideoReviewIssue[] = [];
      try {
        aiIssues = await reviewPromptWithAi(track);
      } catch (error) {
        suggestions.push(
          await upsertReviewSuggestion({
            projectId: input.projectId,
            scriptId: track.scriptId,
            targetType: "videoPrompt",
            targetId: track.id,
            issueType: "ai_review_unavailable",
            severity: "warning",
            message: "AI 审校暂时不可用，未能解析模型返回的审校结果。",
            reason: aiReviewErrorMessage(error),
            proposedAction: "可稍后重试视频提示词审校，或先人工审阅当前提示词。",
            proposedPatch: { op: "review_only", trackId: track.id, source: "ai_review", retryable: true },
          }),
        );
      }
      for (const issue of aiIssues) {
        const issueType = normalizeIssueType(issue?.issueType);
        const severity = normalizeSeverity(issue?.severity);
        const suggestedRevision =
          typeof issue?.suggestedRevision === "string" && issue.suggestedRevision.trim()
            ? issue.suggestedRevision.trim()
            : "";
        const safetyGuidance =
          issueType === "safety_risk" || severity === "blocking"
            ? "用户接受后，将交给 AI 统一修订：保留剧情意图，弱化高风险动作细节，避免操作性犯罪/暴力描述，并使用更稳妥、可生成的表达。"
            : "";
        suggestions.push(
          await upsertReviewSuggestion({
            projectId: input.projectId,
            scriptId: track.scriptId,
            targetType: "videoPrompt",
            targetId: track.id,
            issueType,
            severity,
            message: String(issue?.evidence || issue?.reason || "AI 审校发现视频提示词可能需要调整。").slice(0, 500),
            reason: String(issue?.reason || "").slice(0, 2000),
            proposedAction: suggestedRevision
              ? "用户接受后，将在批量处理中交给 AI 结合上下文统一修订。"
              : safetyGuidance || "请人工审阅后决定是否纳入批量修订。",
            proposedPatch: { op: "review_only", trackId: track.id, source: "ai_review", suggestedRevision, safetyGuidance },
          }),
        );
      }
    }
    const reviewIssues = parseJsonArray(track.reviewIssuesJson);
    if (reviewIssues.some((issue: any) => issue.severity === "blocking")) {
      suggestions.push(
        await upsertReviewSuggestion({
          projectId: input.projectId,
          scriptId: track.scriptId,
          targetType: "storyboardGroup",
          targetId: track.groupKey || track.id,
          issueType: "group_blocking",
          severity: "blocking",
          message: "分镜组存在阻断级问题，生成视频前需要处理。",
          reason: JSON.stringify(reviewIssues).slice(0, 500),
          proposedAction: "请打开分镜表审校，按用户确认后的建议调整分镜组边界或内容。",
          proposedPatch: { op: "review_only", trackId: track.id },
        }),
      );
    }
    if (!track.musicPlanJson) {
      suggestions.push(
        await upsertReviewSuggestion({
          projectId: input.projectId,
          scriptId: track.scriptId,
          targetType: "bgmSuggestion",
          targetId: track.groupKey || track.id,
          issueType: "bgm_missing",
          severity: "info",
          message: "该分镜组还没有 BGM 后期建议。",
          proposedAction: "可重新生成分镜组摘要，或手动补充 BGM 后期建议。",
          proposedPatch: { op: "review_only", trackId: track.id },
        }),
      );
    }
  }
  return { tracks, suggestions: suggestions.filter(Boolean) };
}
