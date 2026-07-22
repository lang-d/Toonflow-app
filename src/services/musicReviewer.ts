import { z } from "zod";
import u from "@/utils";
import { invokeAiObjectWithFallback, parseAiJsonWithSchema } from "@/services/aiJsonObject";
import { parseJsonValue, readMusicSkill } from "@/services/musicDirector";
import {
  ProductionReviewSeverity,
  ProductionReviewTargetType,
  upsertReviewSuggestion,
} from "@/services/productionReview";
import { readMusicModelTechnique, resolveMusicPromptProfile } from "@/services/musicPromptProfile";
import { getMusicLibraryEdition, getMusicPromptVersion } from "@/services/musicLibrary";

export const musicReviewIssueSchema = z.object({
  issueType: z.string().min(1),
  severity: z.enum(["info", "warning", "blocking"]).default("warning"),
  message: z.string().min(1),
  reason: z.string().optional().default(""),
  proposedAction: z.string().optional().default(""),
}).superRefine((issue, context) => {
  if (issue.severity !== "blocking") return;
  if (!issue.reason.trim()) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Blocking review issues require a reason" });
  }
  if (!issue.proposedAction.trim()) {
    context.addIssue({ code: "custom", path: ["proposedAction"], message: "Blocking review issues require a proposed action" });
  }
});

const reviewSchema = z.object({
  issues: z.array(musicReviewIssueSchema).default([]),
});

type ReviewIssue = z.infer<typeof musicReviewIssueSchema>;

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
  const libraryPlan = parseJsonValue<any[]>(plan.libraryPlanJson, []);
  if (plan.mode === "episode" && !cues.length) {
    localIssues.push({
      issueType: "music_plan_missing_cues",
      severity: "blocking",
      message: "Music plan has no cue sheet.",
      reason: "The generation stage needs cue records before prompts or assets can be produced.",
      proposedAction: "Regenerate the plan with a cue sheet.",
    });
  }
  if (plan.mode !== "episode" && cues.length > 0) {
    localIssues.push({
      issueType: "music_plan_scope_leak",
      severity: "blocking",
      message: "Project or concept planning unexpectedly created episode cue records.",
      reason: "Project planning defines reusable works and editions; episode planning defines semantic usage segments.",
      proposedAction: "Regenerate in the correct mode and keep cue creation in episode scope.",
    });
  }
  if (plan.mode === "project" && libraryPlan.length === 0) {
    localIssues.push({
      issueType: "music_library_plan_missing",
      severity: "blocking",
      message: "Project music planning did not produce a reusable music library plan.",
      reason: "The project stage must define works and planned narrative editions before episode reuse decisions can be made.",
      proposedAction: "Add a restrained set of reusable works and only the narrative editions justified by the series arc.",
    });
  }
  if (plan.mode === "project" && libraryPlan.reduce((sum, item) => sum + Number(item?.editions?.length || 0), 0) > 20) {
    localIssues.push({
      issueType: "music_library_overplanned",
      severity: "warning",
      message: "The project plan contains an unusually large number of planned editions.",
      reason: "Planning too many speculative arrangements creates work without proven episode demand.",
      proposedAction: "Keep only editions tied to clear narrative phases and generate audio on demand.",
    });
  }
  if (plan.mode === "episode" && cues.length > 0) {
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
      libraryPlan,
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
  promptVersionId: number;
  cueId?: number;
  editionId?: number;
}) {
  const promptVersion = await getMusicPromptVersion(input.projectId, input.promptVersionId);
  const cue = promptVersion.targetType === "cue"
    ? await u.db("o_musicCue").where({ projectId: input.projectId, id: promptVersion.cueId }).first()
    : null;
  const edition = promptVersion.targetType === "edition"
    ? await getMusicLibraryEdition(input.projectId, Number(promptVersion.editionId))
    : null;
  if (!cue && !edition) throw new Error("Music prompt target does not exist");
  if (input.cueId != null && Number(promptVersion.cueId) !== input.cueId) throw new Error("Prompt version does not belong to this cue");
  if (input.editionId != null && Number(promptVersion.editionId) !== input.editionId) throw new Error("Prompt version does not belong to this edition");
  const isModelSpecific = promptVersion.promptMode === "modelSpecific";
  const profile = isModelSpecific ? await resolveMusicPromptProfile(String(promptVersion.model)) : null;
  const modelTechnique = profile ? await readMusicModelTechnique(profile) : null;
  const skill = await readMusicSkill("music_review.md", "Review music bible, music plan and music prompt quality.");
  const localIssues: ReviewIssue[] = [];
  if (promptVersion.prompt.length > 1800) {
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
      isModelSpecific
        ? "Review only the compiled music prompt against its target model profile. Do not evaluate generated audio."
        : "Review only the provider-neutral music prompt for musical completeness and later model adaptation. Do not evaluate generated audio.",
      "Check duration, emotional arc, instrumentation, structure, vocal/lyrics mode and avoid/negative prompt.",
      skill.content,
      ...(profile ? ["# Target Music Model Prompt Profile", profile.content] : []),
      ...(modelTechnique ? ["# Target Music Model Prompt Technique", modelTechnique.content] : []),
    ].join("\n\n"),
    payload: {
      targetType: "musicPrompt",
      promptMode: promptVersion.promptMode,
      model: promptVersion.model,
      cue: cue ? {
        id: cue.id,
        cueKey: cue.cueKey,
        cueType: cue.cueType,
        title: cue.title,
        durationSec: cue.durationSec,
        musicSpec: parseJsonValue(cue.musicSpecJson, {}),
      } : null,
      edition: edition ? {
        id: edition.id,
        editionType: edition.editionType,
        vocalMode: edition.vocalMode,
        narrativePhase: edition.narrativePhase,
        musicSpec: edition.musicSpec,
      } : null,
      prompt: promptVersion.prompt,
      negativePrompt: promptVersion.negativePrompt,
      generationConfig: promptVersion.generationConfig,
    },
  });
  const issues = [...localIssues, ...aiReview.issues];
  const saved = await saveIssues({
    projectId: input.projectId,
    scriptId: cue?.scriptId ?? null,
    targetType: "musicPrompt",
    targetId: Number(promptVersion.id),
    parentId: null,
    version: promptVersion.version,
    issues,
  });
  const reviewStatus = issues.some((issue) => issue.severity === "blocking")
    ? "blocked"
    : issues.length
      ? "warning"
      : "passed";
  await (u.db as any)("o_musicPromptVersion").where("id", promptVersion.id).update({ reviewStatus, updateTime: Date.now() });
  return { promptVersionId: Number(promptVersion.id), reviewStatus, issues, suggestions: saved };
}

export async function reviewMusicLyrics(input: { projectId: number; editionId: number; lyricsVersionId: number }) {
  const edition = await getMusicLibraryEdition(input.projectId, input.editionId);
  const lyrics = await (u.db as any)("o_musicLyricsVersion").where({
    projectId: input.projectId,
    editionId: input.editionId,
    id: input.lyricsVersionId,
  }).first();
  if (!lyrics) throw new Error("Lyrics version does not exist or does not belong to this edition");
  const skill = await readMusicSkill("music_review.md", "Review music bible, music plan, lyrics and music prompt quality.");
  const technique = await readMusicSkill("music_lyrics_technique.md", "Write singable lyrics with controlled story detail and a clear point of view.");
  const localIssues: ReviewIssue[] = [];
  if (!String(lyrics.content || "").trim()) {
    localIssues.push({
      issueType: "music_lyrics_empty",
      severity: "blocking",
      message: "Lyrics content is empty.",
      reason: "A vocal generation cannot use an empty lyrics version.",
      proposedAction: "Create or edit a complete lyrics draft before confirmation.",
    });
  }
  const aiReview = await runAiReview({
    system: [
      "Review only the saved lyrics version. Do not rewrite it and do not evaluate generated audio.",
      "Check point of view, singability, structure, repetition, language consistency and excessive plot exposition.",
      technique.content,
      skill.content,
    ].join("\n\n"),
    payload: {
      targetType: "musicLyrics",
      edition: {
        id: edition.id,
        title: edition.title,
        editionType: edition.editionType,
        vocalMode: edition.vocalMode,
        language: edition.language,
        narrativePhase: edition.narrativePhase,
      },
      lyrics: { id: lyrics.id, version: lyrics.version, title: lyrics.title, language: lyrics.language, content: lyrics.content },
    },
  });
  const issues = [...localIssues, ...aiReview.issues];
  const saved = await saveIssues({
    projectId: input.projectId,
    targetType: "musicLyrics",
    targetId: Number(lyrics.id),
    parentId: null,
    version: lyrics.version,
    issues,
  });
  const reviewStatus = issues.some((issue) => issue.severity === "blocking")
    ? "blocked"
    : issues.length
      ? "warning"
      : "passed";
  await (u.db as any)("o_musicLyricsVersion").where("id", lyrics.id).update({ reviewStatus, updateTime: Date.now() });
  return { lyricsVersionId: Number(lyrics.id), reviewStatus, issues, suggestions: saved };
}
