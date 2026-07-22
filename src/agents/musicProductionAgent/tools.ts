import { tool, jsonSchema } from "ai";
import { z } from "zod";
import ResTool from "@/socket/resTool";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import { listMusicCues, parseJsonValue, type MusicScopeMode } from "@/services/musicDirector";
import { selectMusicCueAsset } from "@/services/musicAsset";
import {
  bindMusicCue,
  confirmMusicLyricsVersion,
  createMusicLibraryItem,
  getMusicLibraryDetail,
  listMusicLibrary,
  listMusicLyricsVersions,
  listMusicPromptVersions,
  saveMusicLibraryEdition,
  saveMusicLyricsVersion,
  saveMusicPromptVersion,
  selectMusicLibraryVersion,
} from "@/services/musicLibrary";
import {
  queueMusicBibleGenerate,
  queueMusicBibleReview,
  queueMusicPlanGenerate,
  queueMusicPlanReview,
  queueMusicCueCompilePrompt,
  queueMusicCueReviewPrompt,
  queueMusicCueGenerate,
  queueMusicLibraryCompilePrompt,
  queueMusicLibraryGenerate,
  queueMusicLibraryReviewPrompt,
  queueMusicLibraryTrim,
  queueMusicLyricsGenerate,
  queueGenericMusicCuePrompt,
  queueGenericMusicLibraryPrompt,
} from "@/services/musicTaskQueue";
import {
  musicEpisodeIsolationKey,
  musicProjectIsolationKey,
} from "@/services/musicScope";
import { listAvailableMusicModels } from "@/services/musicModelCapability";
import { readMusicModelProfile } from "@/services/musicCueCompiler";
import type { AgentRunContext } from "@/services/agentRun";

type MusicToolConfig = {
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  onTaskQueued?: (task: { taskId: string; targetType: string; targetId?: string | number | null }) => void;
  runContext?: AgentRunContext;
};

export const musicProductionToolNames = [
  "list_available_music_models",
  "read_music_model_profile",
  "update_agent_progress",
  "generate_music_bible",
  "review_music_bible",
  "generate_music_plan",
  "review_music_plan",
  "list_music_cues",
  "compile_music_cue_prompt",
  "compile_generic_music_prompt",
  "compile_model_music_prompt",
  "review_music_cue_prompt",
  "review_generic_music_prompt",
  "review_model_music_prompt",
  "generate_music_cue_audio",
  "select_music_cue_asset",
  "list_music_library",
  "get_music_library_detail",
  "create_music_work",
  "save_music_edition",
  "generate_music_lyrics_draft",
  "list_music_lyrics_versions",
  "save_music_lyrics_version",
  "confirm_music_lyrics_version",
  "compile_music_library_prompt",
  "list_music_prompt_versions",
  "save_music_prompt_version",
  "review_music_library_prompt",
  "generate_music_library_audio",
  "bind_music_cue",
  "select_music_library_version",
  "trim_music_library_audio",
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
      reportQueuedTasks(config, result);
      stream.complete({ title, text: typeof result === "string" ? result : JSON.stringify(result) });
      return result;
    },
  };
}

function reportQueuedTasks(config: MusicToolConfig, value: unknown, seen = new Set<unknown>()) {
  if (!value || seen.has(value)) return;
  if (typeof value === "string") {
    try {
      reportQueuedTasks(config, JSON.parse(value), seen);
    } catch {
      // Plain Agent text is not a task envelope.
    }
    return;
  }
  if (typeof value !== "object") return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (typeof record.taskId === "string" && typeof record.targetType === "string") {
    config.onTaskQueued?.({
      taskId: record.taskId,
      targetType: record.targetType,
      targetId: typeof record.targetId === "string" || typeof record.targetId === "number" ? record.targetId : null,
    });
  }
  Object.values(record).forEach((item) => reportQueuedTasks(config, item, seen));
}

async function queueTaskResult(config: MusicToolConfig, result: Promise<unknown>) {
  const resolved = await result;
  reportQueuedTasks(config, resolved);
  return resolved;
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
    libraryPlan: parseJsonValue(row.libraryPlanJson, []),
    recommendedProduction: parseJsonValue(row.recommendedProductionJson, null),
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
  const list_available_music_models = tool({
    description: "List actual enabled music models. `model` is the only executable vendor:modelName key; `name` is display text only. Read this before choosing a model-specific prompt compiler.",
    inputSchema: jsonSchema<Record<string, never>>(z.object({}).toJSONSchema()),
    execute: async () => ({ models: await listAvailableMusicModels() }),
  });

  const read_music_model_profile = tool({
    description: "Read the configured profile for one exact vendor:model key. A missing profile is a fact for the Agent to decide how to handle.",
    inputSchema: jsonSchema<{ model: string }>(z.object({ model: z.string().min(1) }).toJSONSchema()),
    execute: async ({ model }) => ({ model, profile: await readMusicModelProfile(model) }),
  });

  const update_agent_progress = tool({
    description: "Report the current business progress for this run. This records a timeline fact and does not end the run.",
    inputSchema: jsonSchema<{ stage: string; subAgent?: string; title: string; detail?: string; phase?: string }>(
      z.object({ stage: z.string().min(1).max(100), subAgent: z.string().min(1).max(100).optional(), title: z.string().min(1).max(300), detail: z.string().max(2000).optional(), phase: z.string().max(80).optional() }).toJSONSchema(),
    ),
    execute: async (input) => {
      if (!config.runContext) throw new Error("Agent run context is unavailable");
      await config.runContext.updateProgress(input);
      return { recorded: true };
    },
  });

  const complete_agent_run = tool({
    description: "Explicitly finish this Agent Run after the requested work is complete. This records the model-declared terminal state and does not alter music business facts or task status.",
    inputSchema: jsonSchema<{ stage: string; subAgent?: string; summary?: string }>(
      z.object({ stage: z.string().min(1).max(100), subAgent: z.string().min(1).max(100).optional(), summary: z.string().max(2000).optional() }).toJSONSchema(),
    ),
    execute: async (input) => {
      if (!config.runContext) throw new Error("Agent Run context is required to complete a run");
      config.runContext.setCompleted({
        stage: input.stage,
        subAgent: input.subAgent,
        reason: input.summary || "",
        resultJson: { kind: "agent_completed", summary: input.summary ?? null },
      });
      config.runContext.stopForTerminal();
      return { status: "completed", terminal: true, ...input };
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
    description: "Create an async task to compile a cue into a model-friendly music prompt. `model` must be the exact vendor:modelName value from list_available_music_models, never its display name.",
    inputSchema: jsonSchema<{ cueId: number; model: string; instruction?: string }>(
      z.object({ cueId: z.number(), model: z.string(), instruction: z.string().optional() }).toJSONSchema(),
    ),
    execute: async ({ cueId, model, instruction }) => {
      const scope = thinking(config, "Creating cue prompt compile task");
      const result = await queueMusicCueCompilePrompt({ projectId: projectIdFrom(config.resTool), cueId, model, instruction });
      return scope.done(result);
    },
  });

  const compile_generic_music_prompt = tool({
    description: "Queue provider-neutral prompt compilation for an exact cue or music edition. Use when no configured model profile is selected.",
    inputSchema: jsonSchema<any>(z.object({ targetType: z.enum(["cue", "edition"]), cueId: z.number().optional(), editionId: z.number().optional(), instruction: z.string().optional(), effectiveMusicDurationSec: z.number().optional(), requestedDurationSec: z.number().optional(), lyricsVersionId: z.number().nullable().optional() }).toJSONSchema()),
    execute: async (input) => {
      const projectId = projectIdFrom(config.resTool);
      if (input.targetType === "cue") {
        if (input.cueId == null || input.editionId != null) throw new Error("A generic cue prompt requires only cueId");
        return queueTaskResult(config, queueGenericMusicCuePrompt({ projectId, cueId: input.cueId, instruction: input.instruction }));
      }
      if (input.editionId == null || input.cueId != null) throw new Error("A generic edition prompt requires only editionId");
      return queueTaskResult(config, queueGenericMusicLibraryPrompt({ projectId, editionId: input.editionId, instruction: input.instruction, effectiveMusicDurationSec: input.effectiveMusicDurationSec, requestedDurationSec: input.requestedDurationSec, lyricsVersionId: input.lyricsVersionId }));
    },
  });

  const compile_model_music_prompt = tool({
    description: "Queue model-specific prompt compilation for an exact enabled vendor:model key from list_available_music_models. Do not pass the display-only name field.",
    inputSchema: jsonSchema<any>(z.object({ targetType: z.enum(["cue", "edition"]), cueId: z.number().optional(), editionId: z.number().optional(), model: z.string().min(1), instruction: z.string().optional(), effectiveMusicDurationSec: z.number().optional(), requestedDurationSec: z.number().optional(), lyricsVersionId: z.number().nullable().optional() }).toJSONSchema()),
    execute: async (input) => {
      const projectId = projectIdFrom(config.resTool);
      if (input.targetType === "cue") {
        if (input.cueId == null || input.editionId != null) throw new Error("A model cue prompt requires only cueId");
        return queueTaskResult(config, queueMusicCueCompilePrompt({ projectId, cueId: input.cueId, model: input.model, instruction: input.instruction }));
      }
      if (input.editionId == null || input.cueId != null) throw new Error("A model edition prompt requires only editionId");
      return queueTaskResult(config, queueMusicLibraryCompilePrompt({ projectId, editionId: input.editionId, model: input.model, instruction: input.instruction, effectiveMusicDurationSec: input.effectiveMusicDurationSec, requestedDurationSec: input.requestedDurationSec, lyricsVersionId: input.lyricsVersionId }));
    },
  });

  const review_music_cue_prompt = tool({
    description: "Create an async task to review a compiled cue prompt against the target model profile.",
    inputSchema: jsonSchema<{ cueId: number; promptVersionId: number }>(
      z
        .object({
          cueId: z.number(),
          promptVersionId: z.number(),
        })
        .toJSONSchema(),
    ),
    execute: async ({ cueId, promptVersionId }) => {
      const scope = thinking(config, "Creating cue prompt review task");
      const result = await queueMusicCueReviewPrompt({
        projectId: projectIdFrom(config.resTool),
        cueId,
        promptVersionId,
      });
      return scope.done(result);
    },
  });

  const review_generic_music_prompt = tool({
    description: "Queue review for one exact provider-neutral saved prompt version.",
    inputSchema: jsonSchema<any>(z.object({ targetType: z.enum(["cue", "edition"]), cueId: z.number().optional(), editionId: z.number().optional(), promptVersionId: z.number() }).toJSONSchema()),
    execute: async (input) => {
      const projectId = projectIdFrom(config.resTool);
      if (input.targetType === "cue") {
        if (input.cueId == null || input.editionId != null) throw new Error("A cue review requires only cueId");
        return queueTaskResult(config, queueMusicCueReviewPrompt({ projectId, cueId: input.cueId, promptVersionId: input.promptVersionId, expectedPromptMode: "generic" }));
      }
      if (input.editionId == null || input.cueId != null) throw new Error("An edition review requires only editionId");
      return queueTaskResult(config, queueMusicLibraryReviewPrompt({ projectId, editionId: input.editionId, promptVersionId: input.promptVersionId, expectedPromptMode: "generic" }));
    },
  });

  const review_model_music_prompt = tool({
    description: "Queue review for one exact model-specific saved prompt version.",
    inputSchema: jsonSchema<any>(z.object({ targetType: z.enum(["cue", "edition"]), cueId: z.number().optional(), editionId: z.number().optional(), promptVersionId: z.number() }).toJSONSchema()),
    execute: async (input) => {
      const projectId = projectIdFrom(config.resTool);
      if (input.targetType === "cue") {
        if (input.cueId == null || input.editionId != null) throw new Error("A cue review requires only cueId");
        return queueTaskResult(config, queueMusicCueReviewPrompt({ projectId, cueId: input.cueId, promptVersionId: input.promptVersionId, expectedPromptMode: "modelSpecific" }));
      }
      if (input.editionId == null || input.cueId != null) throw new Error("An edition review requires only editionId");
      return queueTaskResult(config, queueMusicLibraryReviewPrompt({ projectId, editionId: input.editionId, promptVersionId: input.promptVersionId, expectedPromptMode: "modelSpecific" }));
    },
  });

  const generate_music_cue_audio = tool({
    description: "Create an async task to generate audio for a cue. The final audio must be fetched from cue list after task completion.",
    inputSchema: jsonSchema<{ cueId: number; promptVersionId: number; select?: boolean; acknowledgeWarnings?: boolean }>(
      z
        .object({
          cueId: z.number(),
          promptVersionId: z.number(),
          select: z.boolean().optional(),
          acknowledgeWarnings: z.boolean().optional(),
        })
        .toJSONSchema(),
    ),
    execute: async ({ cueId, promptVersionId, select, acknowledgeWarnings }) => {
      const scope = thinking(config, "Creating cue audio generation task");
      const result = await queueMusicCueGenerate({
        projectId: projectIdFrom(config.resTool),
        cueId,
        promptVersionId,
        select,
        acknowledgeWarnings,
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

  const list_music_library = tool({
    description: "List reusable project music works, narrative editions and completed versions.",
    inputSchema: jsonSchema<{ workType?: string; state?: string }>(z.object({ workType: z.string().optional(), state: z.string().optional() }).toJSONSchema()),
    execute: async (input) => ({ libraryItems: await listMusicLibrary({ projectId: projectIdFrom(config.resTool), ...input }) }),
  });

  const get_music_library_detail = tool({
    description: "Get one music work with its editions, lyrics, prompts and generated or trimmed versions.",
    inputSchema: jsonSchema<{ libraryItemId: number }>(z.object({ libraryItemId: z.number() }).toJSONSchema()),
    execute: async ({ libraryItemId }) => ({ libraryItem: await getMusicLibraryDetail({ projectId: projectIdFrom(config.resTool), libraryItemId }) }),
  });

  const create_music_work = tool({
    description: "Create a project music work only after the user explicitly confirms that the work is needed.",
    inputSchema: jsonSchema<any>(z.object({
      workKey: z.string(), workType: z.enum(["theme_song", "opening_song", "ending_song", "insert_song", "score_theme", "source_music", "stinger"]),
      title: z.string(), narrativeRole: z.string().optional(), reuseScope: z.enum(["project", "episode", "single_use"]).optional(),
      relatedItemId: z.number().nullable().optional(), relationType: z.enum(["evolves_from", "replaces", "companion"]).nullable().optional(),
    }).toJSONSchema()),
    execute: async (input) => ({ libraryItem: await createMusicLibraryItem({ projectId: projectIdFrom(config.resTool), ...input }) }),
  });

  const save_music_edition = tool({
    description: "Create or update a planned narrative/arrangement edition after user confirmation; this does not generate audio.",
    inputSchema: jsonSchema<any>(z.object({
      libraryItemId: z.number(), editionId: z.number().optional(), editionKey: z.string(),
      editionType: z.enum(["master", "narrative_variant", "arrangement", "vocal_variant", "instrumental", "short_edit", "custom"]),
      parentEditionId: z.number().nullable().optional(), title: z.string().optional(), narrativePhase: z.string().optional(),
      episodeStart: z.number().nullable().optional(), episodeEnd: z.number().nullable().optional(), vocalMode: z.enum(["instrumental", "vocal", "optional"]).optional(),
      language: z.string().optional(), musicSpec: z.any().optional(),
    }).toJSONSchema()),
    execute: async (input) => ({ edition: await saveMusicLibraryEdition({ projectId: projectIdFrom(config.resTool), ...input }) }),
  });

  const generate_music_lyrics_draft = tool({
    description: "Queue an AI lyrics draft. The result remains a draft and cannot be used for vocal generation until the user confirms it.",
    inputSchema: jsonSchema<{ editionId: number; instruction?: string; basedOnId?: number | null }>(z.object({ editionId: z.number(), instruction: z.string().optional(), basedOnId: z.number().nullable().optional() }).toJSONSchema()),
    execute: async (input) => queueTaskResult(config, queueMusicLyricsGenerate({ projectId: projectIdFrom(config.resTool), ...input })),
  });

  const list_music_lyrics_versions = tool({
    description: "List immutable lyrics versions for an edition.",
    inputSchema: jsonSchema<{ editionId: number }>(z.object({ editionId: z.number() }).toJSONSchema()),
    execute: async ({ editionId }) => ({ lyricsVersions: await listMusicLyricsVersions({ projectId: projectIdFrom(config.resTool), editionId }) }),
  });

  const save_music_lyrics_version = tool({
    description: "Save user-edited lyrics as a new draft version without overwriting earlier drafts.",
    inputSchema: jsonSchema<any>(z.object({ editionId: z.number(), title: z.string().optional(), language: z.string().optional(), content: z.string(), basedOnId: z.number().nullable().optional() }).toJSONSchema()),
    execute: async (input) => ({ lyricsVersion: await saveMusicLyricsVersion({ projectId: projectIdFrom(config.resTool), source: "user", ...input }) }),
  });

  const confirm_music_lyrics_version = tool({
    description: "Confirm the exact lyrics version selected by the user for vocal music generation.",
    inputSchema: jsonSchema<{ editionId: number; lyricsVersionId: number }>(z.object({ editionId: z.number(), lyricsVersionId: z.number() }).toJSONSchema()),
    execute: async (input) => ({ lyricsVersion: await confirmMusicLyricsVersion({ projectId: projectIdFrom(config.resTool), ...input }) }),
  });

  const compile_music_library_prompt = tool({
    description: "Queue model-specific prompt compilation for a project music edition and persist the resulting prompt version.",
    inputSchema: jsonSchema<any>(z.object({ editionId: z.number(), model: z.string(), instruction: z.string().optional(), effectiveMusicDurationSec: z.number().optional(), requestedDurationSec: z.number().optional(), lyricsVersionId: z.number().nullable().optional() }).toJSONSchema()),
    execute: async (input) => queueTaskResult(config, queueMusicLibraryCompilePrompt({ projectId: projectIdFrom(config.resTool), ...input })),
  });

  const list_music_prompt_versions = tool({
    description: "List immutable prompt versions for a cue or project music edition.",
    inputSchema: jsonSchema<{ cueId?: number; editionId?: number }>(z.object({ cueId: z.number().optional(), editionId: z.number().optional() }).toJSONSchema()),
    execute: async (input) => ({ promptVersions: await listMusicPromptVersions({ projectId: projectIdFrom(config.resTool), ...input }) }),
  });

  const save_music_prompt_version = tool({
    description: "Save the user's edited prompt as a new immutable version. Generation must use the returned promptVersionId.",
    inputSchema: jsonSchema<any>(z.object({ targetType: z.enum(["cue", "edition"]), cueId: z.number().nullable().optional(), editionId: z.number().nullable().optional(), promptMode: z.enum(["generic", "modelSpecific"]), model: z.string().nullable().optional(), profileSource: z.string().nullable().optional(), prompt: z.string(), negativePrompt: z.string().optional(), generationConfig: z.any().optional(), basedOnId: z.number().nullable().optional() }).toJSONSchema()),
    execute: async (input) => ({ promptVersion: await saveMusicPromptVersion({ projectId: projectIdFrom(config.resTool), source: "user", ...input }) }),
  });

  const review_music_library_prompt = tool({
    description: "Queue review of the exact saved prompt version for a project music edition.",
    inputSchema: jsonSchema<{ editionId: number; promptVersionId: number }>(z.object({ editionId: z.number(), promptVersionId: z.number() }).toJSONSchema()),
    execute: async (input) => queueTaskResult(config, queueMusicLibraryReviewPrompt({ projectId: projectIdFrom(config.resTool), ...input })),
  });

  const generate_music_library_audio = tool({
    description: "Queue audio generation using exactly one saved prompt version and, for vocal music, one confirmed lyrics version.",
    inputSchema: jsonSchema<{ editionId: number; promptVersionId: number; lyricsVersionId?: number | null }>(z.object({ editionId: z.number(), promptVersionId: z.number(), lyricsVersionId: z.number().nullable().optional() }).toJSONSchema()),
    execute: async (input) => queueTaskResult(config, queueMusicLibraryGenerate({ projectId: projectIdFrom(config.resTool), ...input })),
  });

  const bind_music_cue = tool({
    description: "Set an episode music segment to reuse, new or silence. Reuse should point to an existing completed version.",
    inputSchema: jsonSchema<any>(z.object({ cueId: z.number(), usageMode: z.enum(["reuse", "new", "silence"]), editionId: z.number().nullable().optional(), libraryVersionId: z.number().nullable().optional(), suggestedUseDurationSec: z.number().nullable().optional() }).toJSONSchema()),
    execute: async (input) => ({ binding: await bindMusicCue({ projectId: projectIdFrom(config.resTool), ...input }) }),
  });

  const select_music_library_version = tool({
    description: "Select a completed take for one edition after the user auditions it; other editions are unaffected.",
    inputSchema: jsonSchema<{ editionId: number; libraryVersionId: number }>(z.object({ editionId: z.number(), libraryVersionId: z.number() }).toJSONSchema()),
    execute: async (input) => ({ edition: await selectMusicLibraryVersion({ projectId: projectIdFrom(config.resTool), ...input }) }),
  });

  const trim_music_library_audio = tool({
    description: "Queue a non-destructive WAV derivative from a completed master; final placement remains in Jianying.",
    inputSchema: jsonSchema<any>(z.object({ sourceLibraryVersionId: z.number(), startMs: z.number(), endMs: z.number(), fadeInMs: z.number().optional(), fadeOutMs: z.number().optional(), title: z.string(), bindCueId: z.number().nullable().optional() }).toJSONSchema()),
    execute: async (input) => queueTaskResult(config, queueMusicLibraryTrim({ projectId: projectIdFrom(config.resTool), ...input })),
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
    list_available_music_models,
    read_music_model_profile,
    update_agent_progress,
    complete_agent_run,
    generate_music_bible,
    review_music_bible,
    generate_music_plan,
    review_music_plan,
    list_music_cues,
    compile_music_cue_prompt,
    compile_generic_music_prompt,
    compile_model_music_prompt,
    review_music_cue_prompt,
    review_generic_music_prompt,
    review_model_music_prompt,
    generate_music_cue_audio,
    select_music_cue_asset,
    list_music_library,
    get_music_library_detail,
    create_music_work,
    save_music_edition,
    generate_music_lyrics_draft,
    list_music_lyrics_versions,
    save_music_lyrics_version,
    confirm_music_lyrics_version,
    compile_music_library_prompt,
    list_music_prompt_versions,
    save_music_prompt_version,
    review_music_library_prompt,
    generate_music_library_audio,
    bind_music_cue,
    select_music_library_version,
    trim_music_library_audio,
    get_music_bible_detail,
    get_music_plan_detail,
    remember_project_music_note,
    remember_episode_music_note,
  };
}
