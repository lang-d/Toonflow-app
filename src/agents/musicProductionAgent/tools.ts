import { tool, jsonSchema } from "ai";
import { z } from "zod";
import ResTool from "@/socket/resTool";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import { listMusicCues, parseJsonValue, type MusicScopeMode } from "@/services/musicDirector";
import { selectMusicCueAsset } from "@/services/musicAsset";
import {
  queueMusicBibleGenerate,
  queueMusicBibleReview,
  queueMusicPlanGenerate,
  queueMusicPlanReview,
  queueMusicCueCompilePrompt,
  queueMusicCueReviewPrompt,
  queueMusicCueGenerate,
} from "@/services/musicTaskQueue";
import {
  getMusicStageState,
  musicEpisodeIsolationKey,
  musicProjectIsolationKey,
} from "@/services/musicStageState";

type MusicToolConfig = {
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
};

export const musicProductionToolNames = [
  "get_music_stage_state",
  "generate_music_bible",
  "review_music_bible",
  "generate_music_plan",
  "review_music_plan",
  "list_music_cues",
  "compile_music_cue_prompt",
  "review_music_cue_prompt",
  "generate_music_cue_audio",
  "select_music_cue_asset",
  "get_music_bible_detail",
  "get_music_plan_detail",
  "remember_project_music_note",
  "remember_episode_music_note",
] as const;

function projectIdFrom(resTool: ResTool) {
  const projectId = Number(resTool.data.projectId);
  if (!Number.isFinite(projectId)) throw new Error("projectId is required");
  return projectId;
}

function contextScriptId(resTool: ResTool) {
  const scriptId = Number(resTool.data.scriptId);
  return Number.isFinite(scriptId) ? scriptId : null;
}

function contextMode(resTool: ResTool): MusicScopeMode {
  const mode = String(resTool.data.mode || "");
  if (mode === "concept" || mode === "project" || mode === "episode") return mode;
  return contextScriptId(resTool) == null ? "project" : "episode";
}

function thinking(config: MusicToolConfig, title: string) {
  const stream = config.msg.thinking(title);
  return {
    done(result: unknown) {
      stream.complete({ title, text: typeof result === "string" ? result : JSON.stringify(result) });
      return result;
    },
  };
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

async function latestBible(projectId: number) {
  return u
    .db("o_musicBible")
    .where({ projectId, state: "complete" })
    .orderBy("version", "desc")
    .orderBy("id", "desc")
    .first();
}

async function latestPlan(projectId: number, mode: MusicScopeMode, scriptId?: number | null) {
  return u
    .db("o_musicPlan")
    .where({ projectId })
    .modify((qb: any) => {
      if (mode === "episode") qb.where("scriptId", scriptId);
      else qb.where("mode", mode).whereNull("scriptId");
    })
    .where("state", "complete")
    .orderBy("version", "desc")
    .orderBy("id", "desc")
    .first();
}

export default function useMusicProductionTools(config: MusicToolConfig) {
  const get_music_stage_state = tool({
    description: "Get isolated music production stage state, latest bible/plan summary, cues count and active music tasks.",
    inputSchema: jsonSchema<{ mode?: MusicScopeMode; scriptId?: number | null }>(
      z
        .object({
          mode: z.enum(["concept", "project", "episode"]).optional(),
          scriptId: z.number().nullable().optional(),
        })
        .toJSONSchema(),
    ),
    execute: async ({ mode, scriptId }) => {
      const scope = thinking(config, "Loading music stage state");
      const result = await getMusicStageState({
        projectId: projectIdFrom(config.resTool),
        scriptId: scriptId ?? contextScriptId(config.resTool),
        mode: mode || contextMode(config.resTool),
      });
      return scope.done(result);
    },
  });

  const generate_music_bible = tool({
    description: "Create an async task to generate the project-level Music Bible. Ask the user to confirm intent before using it.",
    inputSchema: jsonSchema<{ instruction?: string }>(
      z.object({ instruction: z.string().optional() }).toJSONSchema(),
    ),
    execute: async ({ instruction }) => {
      const scope = thinking(config, "Creating Music Bible task");
      const result = await queueMusicBibleGenerate({ projectId: projectIdFrom(config.resTool), instruction });
      return scope.done(result);
    },
  });

  const review_music_bible = tool({
    description: "Create an async task to review a Music Bible plan/prompt contract. Does not review generated audio.",
    inputSchema: jsonSchema<{ bibleId?: number }>(
      z.object({ bibleId: z.number().optional() }).toJSONSchema(),
    ),
    execute: async ({ bibleId }) => {
      const projectId = projectIdFrom(config.resTool);
      const bible = bibleId == null ? await latestBible(projectId) : { id: bibleId };
      if (!bible?.id) throw new Error("No Music Bible available to review");
      const scope = thinking(config, "Creating Music Bible review task");
      const result = await queueMusicBibleReview({ projectId, bibleId: Number(bible.id) });
      return scope.done(result);
    },
  });

  const generate_music_plan = tool({
    description: "Create an async task to generate a music plan and cue sheet for concept/project/episode scope.",
    inputSchema: jsonSchema<{
      mode?: MusicScopeMode;
      scriptId?: number | null;
      bibleId?: number;
      instruction?: string;
    }>(
      z
        .object({
          mode: z.enum(["concept", "project", "episode"]).optional(),
          scriptId: z.number().nullable().optional(),
          bibleId: z.number().optional(),
          instruction: z.string().optional(),
        })
        .toJSONSchema(),
    ),
    execute: async ({ mode, scriptId, bibleId, instruction }) => {
      const scopeMode = mode || contextMode(config.resTool);
      const effectiveScriptId = scopeMode === "episode" ? scriptId ?? contextScriptId(config.resTool) : null;
      const scope = thinking(config, "Creating music plan task");
      const result = await queueMusicPlanGenerate({
        projectId: projectIdFrom(config.resTool),
        scriptId: effectiveScriptId,
        mode: scopeMode,
        bibleId,
        instruction,
      });
      return scope.done(result);
    },
  });

  const review_music_plan = tool({
    description: "Create an async task to review a music plan and cue sheet.",
    inputSchema: jsonSchema<{ planId?: number; mode?: MusicScopeMode; scriptId?: number | null }>(
      z
        .object({
          planId: z.number().optional(),
          mode: z.enum(["concept", "project", "episode"]).optional(),
          scriptId: z.number().nullable().optional(),
        })
        .toJSONSchema(),
    ),
    execute: async ({ planId, mode, scriptId }) => {
      const projectId = projectIdFrom(config.resTool);
      const scopeMode = mode || contextMode(config.resTool);
      const effectiveScriptId = scopeMode === "episode" ? scriptId ?? contextScriptId(config.resTool) : null;
      const plan = planId == null ? await latestPlan(projectId, scopeMode, effectiveScriptId) : { id: planId };
      if (!plan?.id) throw new Error("No music plan available to review");
      const scope = thinking(config, "Creating music plan review task");
      const result = await queueMusicPlanReview({ projectId, planId: Number(plan.id) });
      return scope.done(result);
    },
  });

  const list_music_cues = tool({
    description: "List music cues and cue audio assets for the current isolated music scope.",
    inputSchema: jsonSchema<{ planId?: number; scriptId?: number | null }>(
      z.object({ planId: z.number().optional(), scriptId: z.number().nullable().optional() }).toJSONSchema(),
    ),
    execute: async ({ planId, scriptId }) => {
      const scope = thinking(config, "Loading music cues");
      const result = await listMusicCues({
        projectId: projectIdFrom(config.resTool),
        scriptId: scriptId ?? contextScriptId(config.resTool),
        planId,
      });
      return scope.done({ cues: result });
    },
  });

  const compile_music_cue_prompt = tool({
    description: "Create an async task to compile a cue into a model-friendly music prompt.",
    inputSchema: jsonSchema<{ cueId: number; model: string; instruction?: string }>(
      z.object({ cueId: z.number(), model: z.string(), instruction: z.string().optional() }).toJSONSchema(),
    ),
    execute: async ({ cueId, model, instruction }) => {
      const scope = thinking(config, "Creating cue prompt compile task");
      const result = await queueMusicCueCompilePrompt({ projectId: projectIdFrom(config.resTool), cueId, model, instruction });
      return scope.done(result);
    },
  });

  const review_music_cue_prompt = tool({
    description: "Create an async task to review a compiled cue prompt against the target model profile.",
    inputSchema: jsonSchema<{
      cueId: number;
      model: string;
      prompt: string;
      compiledPromptJson?: unknown;
    }>(
      z
        .object({
          cueId: z.number(),
          model: z.string(),
          prompt: z.string(),
          compiledPromptJson: z.any().optional(),
        })
        .toJSONSchema(),
    ),
    execute: async ({ cueId, model, prompt, compiledPromptJson }) => {
      const scope = thinking(config, "Creating cue prompt review task");
      const result = await queueMusicCueReviewPrompt({
        projectId: projectIdFrom(config.resTool),
        cueId,
        model,
        prompt,
        compiledPromptJson,
      });
      return scope.done(result);
    },
  });

  const generate_music_cue_audio = tool({
    description: "Create an async task to generate audio for a cue. The final audio must be fetched from cue list after task completion.",
    inputSchema: jsonSchema<{ cueId: number; model: string; instruction?: string; select?: boolean }>(
      z
        .object({
          cueId: z.number(),
          model: z.string(),
          instruction: z.string().optional(),
          select: z.boolean().optional(),
        })
        .toJSONSchema(),
    ),
    execute: async ({ cueId, model, instruction, select }) => {
      const scope = thinking(config, "Creating cue audio generation task");
      const result = await queueMusicCueGenerate({
        projectId: projectIdFrom(config.resTool),
        cueId,
        model,
        instruction,
        select,
      });
      return scope.done(result);
    },
  });

  const select_music_cue_asset = tool({
    description: "Select a completed music cue asset version. This is the only immediate music write tool.",
    inputSchema: jsonSchema<{ cueId: number; musicCueAssetId: number }>(
      z.object({ cueId: z.number(), musicCueAssetId: z.number() }).toJSONSchema(),
    ),
    execute: async ({ cueId, musicCueAssetId }) => {
      const scope = thinking(config, "Selecting cue audio asset");
      const musicCueAsset = await selectMusicCueAsset({
        projectId: projectIdFrom(config.resTool),
        cueId,
        musicCueAssetId,
      });
      return scope.done({ musicCueAsset });
    },
  });

  const get_music_bible_detail = tool({
    description: "Get Music Bible detail. If bibleId is omitted, returns latest complete version.",
    inputSchema: jsonSchema<{ bibleId?: number }>(
      z.object({ bibleId: z.number().optional() }).toJSONSchema(),
    ),
    execute: async ({ bibleId }) => {
      const projectId = projectIdFrom(config.resTool);
      const row =
        bibleId == null
          ? await latestBible(projectId)
          : await u.db("o_musicBible").where({ projectId, id: bibleId }).first();
      if (!row) throw new Error("Music Bible does not exist");
      const scope = thinking(config, "Loading Music Bible");
      return scope.done({ bible: normalizeBible(row) });
    },
  });

  const get_music_plan_detail = tool({
    description: "Get music plan detail. If planId is omitted, returns latest plan for the current scope.",
    inputSchema: jsonSchema<{ planId?: number; includeCues?: boolean; mode?: MusicScopeMode; scriptId?: number | null }>(
      z
        .object({
          planId: z.number().optional(),
          includeCues: z.boolean().optional(),
          mode: z.enum(["concept", "project", "episode"]).optional(),
          scriptId: z.number().nullable().optional(),
        })
        .toJSONSchema(),
    ),
    execute: async ({ planId, includeCues = true, mode, scriptId }) => {
      const projectId = projectIdFrom(config.resTool);
      const scopeMode = mode || contextMode(config.resTool);
      const effectiveScriptId = scopeMode === "episode" ? scriptId ?? contextScriptId(config.resTool) : null;
      const row =
        planId == null
          ? await latestPlan(projectId, scopeMode, effectiveScriptId)
          : await u.db("o_musicPlan").where({ projectId, id: planId }).first();
      if (!row) throw new Error("Music plan does not exist");
      const cues = includeCues ? await listMusicCues({ projectId, planId: Number(row.id) }) : undefined;
      const scope = thinking(config, "Loading music plan");
      return scope.done({ plan: normalizePlan(row), ...(cues ? { cues } : {}) });
    },
  });

  const remember_project_music_note = tool({
    description: "Store project-level music direction, themes, motifs, sonic palette or long-term style decisions.",
    inputSchema: jsonSchema<{ note: string }>(z.object({ note: z.string() }).toJSONSchema()),
    execute: async ({ note }) => {
      const projectId = projectIdFrom(config.resTool);
      const memory = new Memory("musicProductionAgent", musicProjectIsolationKey(projectId));
      await memory.add("assistant:project-music-note", note);
      return { remembered: true, isolationKey: musicProjectIsolationKey(projectId) };
    },
  });

  const remember_episode_music_note = tool({
    description: "Store episode-level cue decisions and temporary user preferences without changing the project Music Bible.",
    inputSchema: jsonSchema<{ note: string; scriptId?: number }>(
      z.object({ note: z.string(), scriptId: z.number().optional() }).toJSONSchema(),
    ),
    execute: async ({ note, scriptId }) => {
      const projectId = projectIdFrom(config.resTool);
      const effectiveScriptId = scriptId ?? contextScriptId(config.resTool);
      if (effectiveScriptId == null) throw new Error("scriptId is required for episode music memory");
      const isolationKey = musicEpisodeIsolationKey(projectId, effectiveScriptId);
      const memory = new Memory("musicProductionAgent", isolationKey);
      await memory.add("assistant:episode-music-note", note);
      return { remembered: true, isolationKey };
    },
  });

  return {
    get_music_stage_state,
    generate_music_bible,
    review_music_bible,
    generate_music_plan,
    review_music_plan,
    list_music_cues,
    compile_music_cue_prompt,
    review_music_cue_prompt,
    generate_music_cue_audio,
    select_music_cue_asset,
    get_music_bible_detail,
    get_music_plan_detail,
    remember_project_music_note,
    remember_episode_music_note,
  };
}
