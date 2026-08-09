import { z } from "zod";
import u from "@/utils";
import { invokeAiObjectWithFallback, parseAiJsonWithSchema } from "@/services/aiJsonObject";
import { parseJsonValue, readMusicSkill } from "@/services/musicDirector";
import { getMusicLibraryEdition, getMusicPromptVersion, saveMusicPromptVersion } from "@/services/musicLibrary";
import { resolveMusicGenerationDuration, resolveMusicModelCapabilities } from "@/services/musicModelCapability";
export { readMusicModelProfile, resolveMusicPromptProfile } from "@/services/musicPromptProfile";
import { missingMusicProfileGenerationConfig, readMusicModelTechnique, resolveMusicPromptProfile, type MusicModelProfile } from "@/services/musicPromptProfile";

const compiledPromptSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string().optional().default(""),
  generationConfig: z.record(z.string(), z.any()).default({}),
  promptNotes: z.string().optional().default(""),
});

type CompiledPrompt = z.infer<typeof compiledPromptSchema>;

function createCompiledPromptSchema(profile: MusicModelProfile | null): z.ZodType<CompiledPrompt> {
  if (!profile?.requiredGenerationConfig.length) return compiledPromptSchema;
  return compiledPromptSchema.superRefine((value, context) => {
    for (const key of missingMusicProfileGenerationConfig(profile, value.generationConfig)) {
      context.addIssue({
        code: "custom",
        path: ["generationConfig", key],
        message: `generationConfig.${key} is required by the selected model profile`,
      });
    }
  });
}

function resolveSuggestedDuration(value: unknown) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? Math.ceil(duration) : undefined;
}

function musicTimingContext(duration: {
  effectiveMusicDurationSec?: number;
  generationDurationSec?: number;
  durationParameter?: boolean;
}) {
  return {
    suggestedDurationSec: duration.effectiveMusicDurationSec ?? null,
    providerDurationSec: duration.generationDurationSec ?? null,
    providerAcceptsDurationParameter: duration.durationParameter === true,
    note: "Suggested duration is musical-design input. Incorporate it naturally into the Prompt when useful; do not promise an exact generated runtime.",
  };
}

export async function compileMusicCuePrompt(input: {
  projectId: number;
  cueId: number;
  model?: string;
  promptMode?: "generic" | "modelSpecific";
  instruction?: string;
}) {
  const cue = await u.db("o_musicCue").where({ projectId: input.projectId, id: input.cueId }).first();
  if (!cue) throw new Error("Music cue does not exist");
  const plan = await u.db("o_musicPlan").where({ projectId: input.projectId, id: cue.planId }).first();
  if (!plan) throw new Error("Music plan does not exist");
  const bible = await u.db("o_musicBible").where({ projectId: input.projectId, id: plan.bibleId }).first();
  if (!bible) throw new Error("Music bible does not exist");
  const binding = await (u.db as any)("o_musicCueBinding").where("cueId", cue.id).first();
  if (binding?.usageMode === "silence" || cue.cueType === "silence") throw new Error("Silence cue does not compile or generate music");

  const promptMode = input.promptMode || "modelSpecific";
  if (promptMode === "modelSpecific" && !input.model) throw new Error("A model-specific prompt requires a model");
  const [profile, compilerSkill, capabilities] = await Promise.all([
    promptMode === "modelSpecific" ? resolveMusicPromptProfile(String(input.model)) : Promise.resolve(null),
    readMusicSkill("music_prompt_compiler_technique.md", "Compile cue design into a target music model prompt."),
    promptMode === "modelSpecific" ? resolveMusicModelCapabilities(String(input.model)) : Promise.resolve(null),
  ]);
  const modelTechnique = profile ? await readMusicModelTechnique(profile) : null;
  const promptSchema = createCompiledPromptSchema(profile);
  const duration = capabilities
    ? resolveMusicGenerationDuration({ effectiveMusicDurationSec: cue.estimatedDurationSec || cue.durationSec, capabilities })
    : {
        effectiveMusicDurationSec: resolveSuggestedDuration(cue.estimatedDurationSec || cue.durationSec),
        generationDurationSec: undefined,
        hasSilentTail: false,
        durationParameter: false,
      };
  const result = await invokeAiObjectWithFallback({
    modelKey: "musicProductionAgent:executionAgent",
    label: "Music cue prompt",
    schema: promptSchema,
    system: [
      promptMode === "modelSpecific"
        ? "You are compiling a scoring cue into a music generation model prompt. Follow the target model prompt profile."
        : "You are compiling a scoring cue into a provider-neutral music prompt that can later be adapted to a model.",
      "Do not paste full story material. Keep only the musical generation information needed by the model.",
      compilerSkill.content,
      ...(profile ? ["# Target Music Model Prompt Profile", profile.content] : []),
      ...(modelTechnique ? ["# Target Music Model Prompt Technique", modelTechnique.content] : []),
    ].join("\n\n"),
    messages: [
      {
        role: "user",
        content: JSON.stringify(
          {
            instruction: input.instruction || "",
            promptMode,
            model: input.model || null,
            musicBible: {
              id: bible.id,
              version: bible.version,
              title: bible.title,
              content: bible.content,
              styleProfile: parseJsonValue(bible.styleProfileJson, {}),
            },
            plan: { id: plan.id, version: plan.version, mode: plan.mode, content: plan.content },
            cue: {
              id: cue.id,
              cueKey: cue.cueKey,
              cueType: cue.cueType,
              title: cue.title,
              narrativePurpose: cue.narrativePurpose,
              durationSec: cue.durationSec,
              timing: musicTimingContext(duration),
              promptBrief: cue.promptBrief,
              startRef: parseJsonValue(cue.startRefJson, {}),
              endRef: parseJsonValue(cue.endRefJson, {}),
              musicSpec: parseJsonValue(cue.musicSpecJson, {}),
            },
          },
          null,
          2,
        ),
      },
    ],
    fallbackTextParser: (text) => parseAiJsonWithSchema(text, promptSchema, "Music cue prompt"),
  });
  const generationConfig = {
    ...(result.generationConfig || {}),
    ...(duration.generationDurationSec == null ? {} : { durationSec: duration.generationDurationSec }),
    ...(duration.effectiveMusicDurationSec == null ? {} : { effectiveMusicDurationSec: duration.effectiveMusicDurationSec }),
  };
  const promptVersion = await saveMusicPromptVersion({
    projectId: input.projectId,
    scriptId: cue.scriptId,
    targetType: "cue",
    cueId: cue.id,
    model: input.model ?? null,
    promptMode,
    profileSource: profile?.source ?? null,
    prompt: result.prompt,
    negativePrompt: result.negativePrompt,
    generationConfig,
    source: "ai",
  });
  return {
    ...result,
    generationConfig,
    promptVersionId: Number(promptVersion.id),
    promptHash: promptVersion.hash,
    promptMode,
    model: input.model ?? null,
    modelCapabilities: capabilities,
    profileSource: profile?.source ?? null,
    modelTechniqueSource: modelTechnique?.source ?? null,
    compilerSkillSource: compilerSkill.source,
  };
}

export async function compileMusicLibraryPrompt(input: {
  projectId: number;
  editionId: number;
  model?: string;
  promptMode?: "generic" | "modelSpecific";
  instruction?: string;
  effectiveMusicDurationSec?: number;
  requestedDurationSec?: number;
  lyricsVersionId?: number | null;
}) {
  const edition = await getMusicLibraryEdition(input.projectId, input.editionId);
  const item = await (u.db as any)("o_musicLibraryItem").where({ projectId: input.projectId, id: edition.libraryItemId }).first();
  if (!item) throw new Error("Music library item does not exist");
  const bible = await u.db("o_musicBible").where({ projectId: input.projectId, state: "complete" }).orderBy("version", "desc").first();
  if (!bible) throw new Error("Music bible is required before compiling a project music work");
  const lyrics = input.lyricsVersionId == null
    ? await (u.db as any)("o_musicLyricsVersion").where({ projectId: input.projectId, editionId: input.editionId, state: "confirmed" }).orderBy("version", "desc").first()
    : await (u.db as any)("o_musicLyricsVersion").where({ projectId: input.projectId, editionId: input.editionId, id: input.lyricsVersionId, state: "confirmed" }).first();
  if (edition.vocalMode === "vocal" && !lyrics) throw new Error("A confirmed lyrics version is required for vocal music");
  const promptMode = input.promptMode || "modelSpecific";
  if (promptMode === "modelSpecific" && !input.model) throw new Error("A model-specific prompt requires a model");
  const [profile, compilerSkill, songSkill, capabilities] = await Promise.all([
    promptMode === "modelSpecific" ? resolveMusicPromptProfile(String(input.model)) : Promise.resolve(null),
    readMusicSkill("music_prompt_compiler_technique.md", "Compile music design into a target model prompt."),
    readMusicSkill("music_song_creation_technique.md", "Create project songs and score works with clear structure and narrative purpose."),
    promptMode === "modelSpecific" ? resolveMusicModelCapabilities(String(input.model)) : Promise.resolve(null),
  ]);
  const modelTechnique = profile ? await readMusicModelTechnique(profile) : null;
  const promptSchema = createCompiledPromptSchema(profile);
  const editionMusicSpec = parseJsonValue<Record<string, unknown>>(edition.musicSpecJson, {});
  const requestedDurationSec = input.effectiveMusicDurationSec ?? input.requestedDurationSec ?? resolveSuggestedDuration(editionMusicSpec.durationSec);
  const duration = capabilities
    ? resolveMusicGenerationDuration({ effectiveMusicDurationSec: requestedDurationSec, requestedDurationSec: input.requestedDurationSec, capabilities })
    : { effectiveMusicDurationSec: resolveSuggestedDuration(requestedDurationSec), generationDurationSec: undefined, hasSilentTail: false, durationParameter: false };
  const result = await invokeAiObjectWithFallback({
    modelKey: "musicProductionAgent:executionAgent",
    label: "Music library prompt",
    schema: promptSchema,
    system: [
      promptMode === "modelSpecific"
        ? "You are compiling a confirmed project music work into a generation prompt for the selected model."
        : "You are compiling a confirmed project music work into a provider-neutral prompt that can later be adapted to a model.",
      "Use only the confirmed work, edition and lyrics. Do not invent plot material.",
      songSkill.content,
      compilerSkill.content,
      ...(profile ? ["# Target Music Model Prompt Profile", profile.content] : []),
      ...(modelTechnique ? ["# Target Music Model Prompt Technique", modelTechnique.content] : []),
    ].join("\n\n"),
    messages: [{
      role: "user",
      content: JSON.stringify({
        instruction: input.instruction || "",
        promptMode,
        model: input.model || null,
        musicBible: { content: bible.content, styleProfile: parseJsonValue(bible.styleProfileJson, {}) },
        work: item,
        edition: { ...edition, musicSpec: parseJsonValue(edition.musicSpecJson, {}) },
        lyrics: lyrics ? { id: lyrics.id, title: lyrics.title, language: lyrics.language, content: lyrics.content } : null,
        timing: musicTimingContext(duration),
      }, null, 2),
    }],
    fallbackTextParser: (text) => parseAiJsonWithSchema(text, promptSchema, "Music library prompt"),
  });
  const generationConfig = {
    ...(result.generationConfig || {}),
    ...(duration.generationDurationSec == null ? {} : { durationSec: duration.generationDurationSec }),
    ...(duration.effectiveMusicDurationSec == null ? {} : { effectiveMusicDurationSec: duration.effectiveMusicDurationSec }),
    vocalMode: edition.vocalMode,
  };
  const promptVersion = await saveMusicPromptVersion({
    projectId: input.projectId,
    targetType: "edition",
    editionId: input.editionId,
    lyricsVersionId: lyrics?.id ?? null,
    promptMode,
    model: input.model ?? null,
    profileSource: profile?.source ?? null,
    prompt: result.prompt,
    negativePrompt: result.negativePrompt,
    generationConfig,
    source: "ai",
  });
  return {
    ...result,
    generationConfig,
    promptVersionId: Number(promptVersion.id),
    promptHash: promptVersion.hash,
    lyricsVersionId: lyrics?.id ?? null,
    promptMode,
    model: input.model ?? null,
    modelCapabilities: capabilities,
    profileSource: profile?.source ?? null,
    modelTechniqueSource: modelTechnique?.source ?? null,
    compilerSkillSource: compilerSkill.source,
  };
}

export async function loadCompiledMusicPromptVersion(projectId: number, promptVersionId: number) {
  return getMusicPromptVersion(projectId, promptVersionId);
}
