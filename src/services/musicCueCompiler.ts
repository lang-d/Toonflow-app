import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import u from "@/utils";
import { invokeAiObjectWithFallback, parseAiJsonWithSchema } from "@/services/aiJsonObject";
import { readBuiltinDataFile } from "@/services/builtinData";
import { parseJsonValue, readMusicSkill } from "@/services/musicDirector";

const compiledPromptSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string().optional().default(""),
  generationConfig: z.record(z.string(), z.any()).default({}),
  promptNotes: z.string().optional().default(""),
});

function splitModel(model: string) {
  const [vendorId, modelName] = String(model || "").split(/:(.+)/);
  if (!vendorId || !modelName) throw new Error("Music model must be in vendor:modelName format");
  return { vendorId, modelName };
}

export async function resolveMusicPromptProfile(model: string) {
  const { vendorId, modelName } = splitModel(model);
  const configured = await u.db("o_modelPrompt").where("vendorId", vendorId).where("model", modelName).first();
  if (configured?.path) {
    try {
      const file = path.join(u.getPath(["modelPrompt"]), configured.path);
      return { content: await fs.readFile(file, "utf8"), source: `o_modelPrompt:${configured.path}` };
    } catch {}
  }
  if (vendorId === "dreamina") {
    const dreamina = await readBuiltinDataFile("modelPrompt", "music", "dreamina-seedmusic.md");
    if (dreamina) return { content: dreamina.content, source: dreamina.file };
  }
  const builtin = await readBuiltinDataFile("modelPrompt", "music", "default.md");
  if (builtin) return { content: builtin.content, source: builtin.file };
  return {
    content: [
      "Write concise, model-friendly music generation prompts.",
      "Include duration, emotion arc, instrumentation, structure, vocal/lyrics mode and avoid list.",
      "Do not include full story dumps or long plot explanations.",
    ].join("\n"),
    source: "fallback:modelPrompt/music/default.md",
  };
}

export async function compileMusicCuePrompt(input: {
  projectId: number;
  cueId: number;
  model: string;
  instruction?: string;
}) {
  const cue = await u.db("o_musicCue").where({ projectId: input.projectId, id: input.cueId }).first();
  if (!cue) throw new Error("Music cue does not exist");
  const plan = await u.db("o_musicPlan").where({ projectId: input.projectId, id: cue.planId }).first();
  if (!plan) throw new Error("Music plan does not exist");
  const bible = await u.db("o_musicBible").where({ projectId: input.projectId, id: plan.bibleId }).first();
  if (!bible) throw new Error("Music bible does not exist");

  const [profile, compilerSkill] = await Promise.all([
    resolveMusicPromptProfile(input.model),
    readMusicSkill("music_prompt_compiler_technique.md", "Compile cue design into a target music model prompt."),
  ]);
  const result = await invokeAiObjectWithFallback({
    modelKey: "productionAgent",
    label: "Music cue prompt",
    schema: compiledPromptSchema,
    system: [
      "You are compiling a scoring cue into a music generation model prompt.",
      "Follow the target model prompt profile. Do not hardcode another model's conventions.",
      "Do not paste full story material. Keep only the musical generation information needed by the model.",
      compilerSkill.content,
      "# Target Music Model Prompt Profile",
      profile.content,
    ].join("\n\n"),
    messages: [
      {
        role: "user",
        content: JSON.stringify(
          {
            instruction: input.instruction || "",
            model: input.model,
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
    fallbackTextParser: (text) => parseAiJsonWithSchema(text, compiledPromptSchema, "Music cue prompt"),
  });
  return {
    ...result,
    model: input.model,
    profileSource: profile.source,
    compilerSkillSource: compilerSkill.source,
  };
}
