import { z } from "zod";
import u from "@/utils";
import { invokeAiObjectWithFallback, parseAiJsonWithSchema } from "@/services/aiJsonObject";
import { parseJsonValue, readMusicSkill } from "@/services/musicDirector";
import {
  ProductionReviewSeverity,
  ProductionReviewTargetType,
  upsertReviewSuggestion,
} from "@/services/productionReview";
import { resolveMusicPromptProfile } from "@/services/musicCueCompiler";

const reviewIssueSchema = z.object({
  issueType: z.string(),
  severity: z.enum(["info", "warning", "blocking"]).default("warning"),
  message: z.string(),
  reason: z.string().optional().default(""),
  proposedAction: z.string().optional().default(""),
});

const reviewSchema = z.object({
  issues: z.array(reviewIssueSchema).default([]),
});

type ReviewIssue = z.infer<typeof reviewIssueSchema>;

function textTooGeneric(text: string) {
  const value = String(text || "").trim();
  return value.length < 500 || value.split(/\s+/).length < 80;
}

async function runAiReview(input: { system: string; payload: unknown }) {
  return invokeAiObjectWithFallback({
    modelKey: "productionAgent",
    label: "Music review",
    schema: reviewSchema,
    system: input.system,
    messages: [{ role: "user", content: JSON.stringify(input.payload, null, 2) }],
    fallbackTextParser: (text) => parseAiJsonWithSchema(text, reviewSchema, "Music review"),
  });
}

async function saveIssues(input: {
  projectId: number;
  scriptId?: number | null;
  targetType: ProductionReviewTargetType;
  targetId: string | number;
  parentId?: number | null;
  version?: number;
  issues: ReviewIssue[];
}) {
  const saved = [];
  for (const issue of input.issues) {
    saved.push(
      await upsertReviewSuggestion({
        projectId: input.projectId,
        scriptId: input.scriptId ?? null,
        targetType: input.targetType,
        targetId: input.targetId,
        parentId: input.parentId ?? null,
        version: input.version,
        issueType: issue.issueType,
        severity: issue.severity as ProductionReviewSeverity,
        message: issue.message,
        reason: issue.reason,
        proposedAction: issue.proposedAction,
      }),
    );
  }
  return saved;
}

export async function reviewMusicBible(input: { projectId: number; bibleId: number }) {
  const bible = await u.db("o_musicBible").where({ projectId: input.projectId, id: input.bibleId }).first();
  if (!bible) throw new Error("Music bible does not exist");
  const skill = await readMusicSkill("music_review.md", "Review music bible, music plan and music prompt quality.");
  const localIssues: ReviewIssue[] = [];
  if (textTooGeneric(bible.content)) {
    localIssues.push({
      issueType: "music_bible_too_thin",
      severity: "warning",
      message: "Music bible appears too thin to guide scoring decisions.",
      reason: "A music bible should define motifs, palette, avoid list and continuity rules with enough specificity.",
      proposedAction: "Regenerate or revise with clearer theme motives, sonic palette, silence strategy and exclusions.",
    });
  }
  const aiReview = await runAiReview({
    system: [
      "Review only the music bible. Do not evaluate generated audio.",
      "Flag generic style-word piles and missing motif/palette/avoid/silence strategy.",
      skill.content,
    ].join("\n\n"),
    payload: {
      targetType: "musicBible",
      bible: {
        id: bible.id,
        version: bible.version,
        title: bible.title,
        content: bible.content,
        styleProfile: parseJsonValue(bible.styleProfileJson, {}),
      },
    },
  });
  const issues = [...localIssues, ...aiReview.issues];
  const saved = await saveIssues({
    projectId: input.projectId,
    targetType: "musicBible",
    targetId: input.bibleId,
    version: bible.version,
    issues,
  });
  return { issues, suggestions: saved };
}

export async function reviewMusicPlan(input: { projectId: number; planId: number }) {
  const plan = await u.db("o_musicPlan").where({ projectId: input.projectId, id: input.planId }).first();
  if (!plan) throw new Error("Music plan does not exist");
  const cues = await u.db("o_musicCue").where({ projectId: input.projectId, planId: input.planId }).orderBy("id", "asc");
  const bible = await u.db("o_musicBible").where({ projectId: input.projectId, id: plan.bibleId }).first();
  const skill = await readMusicSkill("music_review.md", "Review music bible, music plan and music prompt quality.");
  const localIssues: ReviewIssue[] = [];
  if (!cues.length) {
    localIssues.push({
      issueType: "music_plan_missing_cues",
      severity: "blocking",
      message: "Music plan has no cue sheet.",
      reason: "The generation stage needs cue records before prompts or assets can be produced.",
      proposedAction: "Regenerate the plan with a cue sheet.",
    });
  }
  if (cues.length > 0) {
    const storyboardCount = await u
      .db("o_storyboard")
      .where({ projectId: input.projectId })
      .modify((qb: any) => {
        if (plan.scriptId != null) qb.where("scriptId", plan.scriptId);
      })
      .count("id as count")
      .first();
    if (Number(storyboardCount?.count || 0) > 0 && cues.length >= Number(storyboardCount?.count || 0)) {
      localIssues.push({
        issueType: "music_plan_mechanical_shot_split",
        severity: "warning",
        message: "Cue count looks mechanically tied to storyboard count.",
        reason: "Score cues should be divided by musical meaning and dramatic movement, not every storyboard panel.",
        proposedAction: "Merge cue ranges around musical intent, transitions, stingers and ambience roles.",
      });
    }
  }
  const aiReview = await runAiReview({
    system: [
      "Review only the music plan and cue sheet. Do not evaluate generated audio.",
      "Check cue responsibility, serialized production fit, and consistency with the music bible.",
      skill.content,
    ].join("\n\n"),
    payload: {
      targetType: "musicPlan",
      musicBible: bible
        ? {
            id: bible.id,
            version: bible.version,
            content: bible.content,
            styleProfile: parseJsonValue(bible.styleProfileJson, {}),
          }
        : null,
      plan,
      cues: cues.map((cue: any) => ({
        ...cue,
        startRef: parseJsonValue(cue.startRefJson, {}),
        endRef: parseJsonValue(cue.endRefJson, {}),
        musicSpec: parseJsonValue(cue.musicSpecJson, {}),
      })),
    },
  });
  const issues = [...localIssues, ...aiReview.issues];
  const saved = await saveIssues({
    projectId: input.projectId,
    scriptId: plan.scriptId,
    targetType: "musicPlan",
    targetId: input.planId,
    version: plan.version,
    issues,
  });
  return { issues, suggestions: saved };
}

export async function reviewMusicPrompt(input: {
  projectId: number;
  cueId: number;
  model: string;
  prompt: string;
  compiledPromptJson?: unknown;
}) {
  const cue = await u.db("o_musicCue").where({ projectId: input.projectId, id: input.cueId }).first();
  if (!cue) throw new Error("Music cue does not exist");
  const profile = await resolveMusicPromptProfile(input.model);
  const skill = await readMusicSkill("music_review.md", "Review music bible, music plan and music prompt quality.");
  const localIssues: ReviewIssue[] = [];
  if (input.prompt.length > 1800) {
    localIssues.push({
      issueType: "music_prompt_too_long",
      severity: "warning",
      message: "Music prompt is likely too long for a generation model.",
      reason: "Music prompts should contain musical generation requirements rather than full story material.",
      proposedAction: "Reduce to duration, emotion arc, instrumentation, structure, vocal/lyrics and avoid fields.",
    });
  }
  const aiReview = await runAiReview({
    system: [
      "Review only the compiled music prompt against the target model profile. Do not evaluate generated audio.",
      "Check duration, emotional arc, instrumentation, structure, vocal/lyrics mode and avoid/negative prompt.",
      skill.content,
      "# Target Music Model Prompt Profile",
      profile.content,
    ].join("\n\n"),
    payload: {
      targetType: "musicPrompt",
      model: input.model,
      cue: {
        id: cue.id,
        cueKey: cue.cueKey,
        cueType: cue.cueType,
        title: cue.title,
        durationSec: cue.durationSec,
        musicSpec: parseJsonValue(cue.musicSpecJson, {}),
      },
      prompt: input.prompt,
      compiledPromptJson: input.compiledPromptJson ?? {},
    },
  });
  const issues = [...localIssues, ...aiReview.issues];
  const saved = await saveIssues({
    projectId: input.projectId,
    scriptId: cue.scriptId,
    targetType: "musicPrompt",
    targetId: input.cueId,
    version: cue.planVersion,
    issues,
  });
  return { issues, suggestions: saved };
}
