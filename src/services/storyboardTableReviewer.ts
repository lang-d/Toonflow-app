import u from "@/utils";
import { buildStoryboardGroupPlans } from "@/services/storyboardGroupPlanner";
import { upsertReviewSuggestion } from "@/services/productionReview";
import { getProjectDefaultVideoPolicy } from "@/services/videoModelPolicy";
import { invokeAiObjectWithFallback } from "@/services/aiJsonObject";
import { z } from "zod";
import { parseStoryboardTableRow, storyboardTableRowV3Schema } from "@/services/storyboardTableContract";

const reviewOutputSchema = z.object({
  issues: z.array(
    z.object({
      storyboardId: z.number(),
      issueType: z.string(),
      severity: z.enum(["info", "warning", "blocking"]),
      evidence: z.string(),
      reason: z.string(),
      suggestedRow: storyboardTableRowV3Schema.optional(),
    }),
  ),
});

function normalizeSeverity(value: unknown): "info" | "warning" | "blocking" {
  if (value === "blocking") return "blocking";
  if (value === "warning") return "warning";
  return "info";
}

async function reviewStoryboardRowsWithAi(rows: any[]) {
  const reviewRows = rows
    .map((row) => ({ id: row.id, fact: parseStoryboardTableRow(row.tableRowJson) }))
    .filter((row) => row.fact?.version === 3);
  if (!reviewRows.length) return [];
  const system = `You are Toonflow's storyboard-table reviewer.
Review storyboard rows semantically. Do not use a fixed banned-word list.
Return valid JSON that matches the schema.
Rules:
- Review only ready V3 rows for suggested rewrites. shotDescription is chronological: earliest visible state, trigger, continuous visible change, ending state.
- Do not request picture/action or separate emotion and character-performance fields.
- Check shot boundaries: one continuous causal action should not be split for decorative shot-size rotation, while independent visual subjects, information recipients, causal actions, or substantive time/space changes should not be forced into one shot.
- Check that dialogue, necessary pauses and visible action can plausibly fit durationSec without unsupported speed-up.
- Repeated action across adjacent rows, multiple competing visual centers, continuous generic medium shots and cuts inside an indivisible action are concrete review concerns.
- Do not mark diegetic sound effects as BGM. Footsteps, breathing, fabric rustle, station ambience and action sounds are allowed production facts.
- BGM and non-diegetic music are post-production suggestions only.
- Focus on vague emotion, unsafe expression, continuity drift, and generic wording that harms later image/video generation.
- If proposing a revision, return a complete suggestedRow that preserves the row index and all unaffected structured facts.`;
  const result = await invokeAiObjectWithFallback({
    modelKey: "universalAi",
    system,
    schema: reviewOutputSchema,
    label: "storyboard table review output",
    messages: [
      {
        role: "user",
        content: JSON.stringify(
          reviewRows,
          null,
          2,
        ),
      },
    ],
  });
  return result.issues;
}

export async function reviewStoryboardTable(projectId: number, scriptId: number) {
  const rows = await u.db("o_storyboard").where({ projectId, scriptId }).orderBy("index", "asc");
  const durationPolicy = await getProjectDefaultVideoPolicy(projectId);
  const plans = buildStoryboardGroupPlans(rows, { durationPolicy });
  const suggestions = [];

  for (const plan of plans) {
    for (const warning of plan.warnings) {
      suggestions.push(
        await upsertReviewSuggestion({
          projectId,
          scriptId,
          targetType: "storyboardGroup",
          targetId: plan.groupKey,
          issueType: warning.issueType,
          severity: warning.severity,
          message: warning.message,
          reason: warning.reason || plan.groupIntent,
          proposedAction: "Review group boundary or duration against the project default video model.",
          proposedPatch: {
            op: "review_only",
            groupKey: plan.groupKey,
            storyboardIndexes: plan.storyboardIndexes,
          },
        }),
      );
    }
    suggestions.push(
      await upsertReviewSuggestion({
        projectId,
        scriptId,
        targetType: "bgmSuggestion",
        targetId: plan.groupKey,
        issueType: "bgm_reference",
        severity: "info",
        message: "BGM suggestion generated for this storyboard group.",
        reason: plan.bgmSuggestion.mood,
        proposedAction: "Show as post-production reference only. Do not send BGM to the video model.",
        proposedPatch: {
          op: "review_only",
          musicPlan: plan.bgmSuggestion,
        },
      }),
    );
  }

  for (const issue of await reviewStoryboardRowsWithAi(rows)) {
    const storyboardId = Number(issue?.storyboardId);
    if (!Number.isFinite(storyboardId)) continue;
    const row = rows.find((item: any) => Number(item.id) === storyboardId);
    const suggestedRow = issue.suggestedRow;
    suggestions.push(
      await upsertReviewSuggestion({
        projectId,
        scriptId,
        targetType: "storyboard",
        targetId: storyboardId,
        issueType: String(issue?.issueType || "ai_review"),
        severity: normalizeSeverity(issue?.severity),
        message: String(issue?.evidence || issue?.reason || "AI 审校发现分镜文本可能需要调整").slice(0, 500),
        reason: String(issue?.reason || "").slice(0, 2000),
        proposedAction: suggestedRow ? "用户确认后应用 AI 建议修订" : "请人工审阅后决定是否修改",
        proposedPatch: suggestedRow
          ? {
              op: "update_storyboard",
              previous: row ? { tableRowJson: row.tableRowJson, factStatus: row.factStatus } : {},
              values: {
                tableRowJson: JSON.stringify(suggestedRow),
                factStatus: "ready",
                factVersion: 3,
              },
              source: "ai_review",
            }
          : { op: "review_only", source: "ai_review" },
      }),
    );
  }
  return { groups: plans, suggestions: suggestions.filter(Boolean) };
}
