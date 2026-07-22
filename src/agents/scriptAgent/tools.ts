import { jsonSchema, tool, Tool } from "ai";
import { z } from "zod";
import u from "@/utils";
import type { AgentRunContext } from "@/services/agentRun";
import { recordAgentRunEvent } from "@/services/agentRun";
import { createTextAsset, getTextAssetContent } from "@/services/textAsset";
import {
  deleteScriptAgentScript,
  getScriptAgentWorkspace,
  readScriptAgentScripts,
  saveScriptAgentStage,
  SCRIPT_AGENT_STAGES,
  upsertScriptAgentScript,
} from "@/services/scriptAgentWorkspace";
import {
  PROJECT_MATERIAL_CATEGORIES,
  getProjectContextPack,
  listProjectMaterials,
  readProjectMaterial,
} from "@/services/projectMaterial";
import ResTool from "@/socket/resTool";

const stageSchema = z.enum(SCRIPT_AGENT_STAGES);
const projectMaterialCategorySchema = z.enum(PROJECT_MATERIAL_CATEGORIES);
const reviewTargetSchema = z.enum(["storySkeleton", "adaptationStrategy", "script"]);

interface ToolConfig {
  resTool: ResTool;
  runContext?: AgentRunContext | null;
  toolsNames?: string[];
}

function projectIdOf(resTool: ResTool) {
  const projectId = Number(resTool.data.projectId);
  if (!Number.isFinite(projectId) || projectId <= 0) throw new Error("Script Agent project scope is missing");
  return projectId;
}

function emitWorkspaceUpdate(resTool: ResTool, kind: "stage" | "script", payload: Record<string, unknown>) {
  resTool.socket.emit("scriptAgent:workspace:update", {
    projectId: projectIdOf(resTool),
    scriptId: 0,
    kind,
    ...payload,
  });
}

export default ({ resTool, runContext, toolsNames }: ToolConfig) => {
  const tools: Record<string, Tool> = {
    read_script_workspace: tool({
      description: "Read the current Script Agent workspace. This is the source of truth for story skeleton and adaptation strategy.",
      inputSchema: jsonSchema<Record<string, never>>(z.object({}).toJSONSchema()),
      execute: async () => getScriptAgentWorkspace(projectIdOf(resTool)),
    }),
    save_story_skeleton: tool({
      description: "Persist the complete current story skeleton for this project.",
      inputSchema: jsonSchema<{ content: string }>(z.object({ content: z.string().min(1) }).toJSONSchema()),
      execute: async ({ content }) => {
        const saved = await saveScriptAgentStage({ projectId: projectIdOf(resTool), stage: "storySkeleton", content, allowWhileRun: true });
        emitWorkspaceUpdate(resTool, "stage", { stage: saved.stage, workspaceId: saved.workspaceId });
        return saved;
      },
    }),
    save_adaptation_strategy: tool({
      description: "Persist the complete current adaptation strategy for this project.",
      inputSchema: jsonSchema<{ content: string }>(z.object({ content: z.string().min(1) }).toJSONSchema()),
      execute: async ({ content }) => {
        const saved = await saveScriptAgentStage({ projectId: projectIdOf(resTool), stage: "adaptationStrategy", content, allowWhileRun: true });
        emitWorkspaceUpdate(resTool, "stage", { stage: saved.stage, workspaceId: saved.workspaceId });
        return saved;
      },
    }),
    list_project_scripts: tool({
      description: "List current project scripts. Read individual content with read_project_scripts when needed.",
      inputSchema: jsonSchema<Record<string, never>>(z.object({}).toJSONSchema()),
      execute: async () => {
        const scripts = await readScriptAgentScripts({ projectId: projectIdOf(resTool) });
        return { scripts: scripts.map((script: { id: number; name: string }) => ({ id: script.id, name: script.name })) };
      },
    }),
    read_project_scripts: tool({
      description: "Read exact project scripts by ID. IDs must belong to the current project.",
      inputSchema: jsonSchema<{ ids: number[] }>(z.object({ ids: z.array(z.number().int().positive()).min(1).max(10) }).toJSONSchema()),
      execute: async ({ ids }) => ({ scripts: await readScriptAgentScripts({ projectId: projectIdOf(resTool), ids }) }),
    }),
    upsert_project_script: tool({
      description: "Create a new project script or update one exact existing script by ID.",
      inputSchema: jsonSchema<{ id?: number; name: string; content: string }>(
        z.object({ id: z.number().int().positive().optional(), name: z.string().trim().min(1), content: z.string().min(1) }).toJSONSchema(),
      ),
      execute: async ({ id, name, content }) => {
        const saved = await upsertScriptAgentScript({ projectId: projectIdOf(resTool), id, name, content, allowWhileRun: true });
        emitWorkspaceUpdate(resTool, "script", { action: saved.created ? "created" : "updated", scriptRecordId: saved.id });
        return saved;
      },
    }),
    delete_project_script: tool({
      description: "Delete one exact project script by ID. Only use when the user explicitly requested deletion.",
      inputSchema: jsonSchema<{ id: number }>(z.object({ id: z.number().int().positive() }).toJSONSchema()),
      execute: async ({ id }) => {
        const deleted = await deleteScriptAgentScript({ projectId: projectIdOf(resTool), id, allowWhileRun: true });
        emitWorkspaceUpdate(resTool, "script", { action: "deleted", scriptRecordId: id });
        return deleted;
      },
    }),
    list_novel_chapters: tool({
      description: "List factual novel chapter and event extraction availability for the current project.",
      inputSchema: jsonSchema<Record<string, never>>(z.object({}).toJSONSchema()),
      execute: async () => {
        const chapters = await u
          .db("o_novel")
          .where({ projectId: projectIdOf(resTool) })
          .orderBy("chapterIndex", "asc")
          .select("id", "chapterIndex", "chapter", "eventState");
        return {
          chapters: chapters.map((row: any) => ({
            id: Number(row.id),
            chapterIndex: Number(row.chapterIndex),
            title: String(row.chapter || ""),
            eventState: Number(row.eventState || 0),
          })),
        };
      },
    }),
    read_novel_events: tool({
      description: "Read factual extracted events for selected current-project chapters. eventState is returned without interpretation.",
      inputSchema: jsonSchema<{ chapterIndexes: number[] }>(
        z.object({ chapterIndexes: z.array(z.number().int().positive()).min(1).max(30) }).toJSONSchema(),
      ),
      execute: async ({ chapterIndexes }) => {
        const rows = await u
          .db("o_novel")
          .where({ projectId: projectIdOf(resTool) })
          .whereIn("chapterIndex", chapterIndexes)
          .orderBy("chapterIndex", "asc")
          .select("id", "chapterIndex", "chapter", "event", "eventState");
        return {
          chapters: rows.map((row: any) => ({
            id: Number(row.id),
            chapterIndex: Number(row.chapterIndex),
            title: String(row.chapter || ""),
            event: row.event ?? null,
            eventState: Number(row.eventState || 0),
          })),
        };
      },
    }),
    read_novel_text: tool({
      description: "Read the original text of one current-project novel chapter.",
      inputSchema: jsonSchema<{ chapterIndex: number }>(z.object({ chapterIndex: z.number().int().positive() }).toJSONSchema()),
      execute: async ({ chapterIndex }) => {
        const row = await u.db("o_novel").where({ projectId: projectIdOf(resTool), chapterIndex }).first("chapterData", "chapter");
        if (!row) throw new Error("Novel chapter not found in current project");
        return { chapterIndex, title: String(row.chapter || ""), content: String(row.chapterData || "") };
      },
    }),
    get_script_project_context: tool({
      description: "Read factual project metadata for script work.",
      inputSchema: jsonSchema<Record<string, never>>(z.object({}).toJSONSchema()),
      execute: async () => {
        const projectId = projectIdOf(resTool);
        const project = await u.db("o_project").where({ id: projectId }).first();
        if (!project) throw new Error("Project not found");
        return {
          id: projectId,
          name: String(project.name || ""),
          type: String(project.type || ""),
          intro: String(project.intro || ""),
          artStyle: String(project.artStyle || ""),
          videoRatio: String(project.videoRatio || ""),
        };
      },
    }),
    list_project_materials: tool({
      description: "List project reference materials by category.",
      inputSchema: jsonSchema<{ category?: string }>(z.object({ category: projectMaterialCategorySchema.optional() }).toJSONSchema()),
      execute: async ({ category }) => listProjectMaterials({ projectId: projectIdOf(resTool), category: category as any }),
    }),
    read_project_material: tool({
      description: "Read project reference material text using pagination.",
      inputSchema: jsonSchema<{ id: number; offset?: number; limit?: number }>(
        z.object({ id: z.number().int().positive(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() }).toJSONSchema(),
      ),
      execute: async ({ id, offset, limit }) => readProjectMaterial({ id, projectId: projectIdOf(resTool), offset, limit }),
    }),
    get_project_context_pack: tool({
      description: "Read the latest project context pack when one exists.",
      inputSchema: jsonSchema<Record<string, never>>(z.object({}).toJSONSchema()),
      execute: async () => getProjectContextPack(projectIdOf(resTool)),
    }),
    update_agent_progress: tool({
      description: "Report business progress for recovery. This does not finish the run or change script facts.",
      inputSchema: jsonSchema<{ stage: string; subAgent?: string; title: string; detail?: string; phase?: string }>(
        z.object({ stage: z.string().min(1), subAgent: z.string().min(1).optional(), title: z.string().min(1), detail: z.string().optional(), phase: z.string().optional() }).toJSONSchema(),
      ),
      execute: async (input) => {
        if (!runContext) return { recorded: false, reason: "no agent run context" };
        await runContext.updateProgress({ stage: input.stage, subAgent: input.subAgent ?? null, title: input.title, detail: input.detail ?? null, phase: input.phase ?? null });
        resTool.socket.emit("agent:run:update", {
          agentKey: "scriptAgent",
          projectId: projectIdOf(resTool),
          scriptId: 0,
          runId: runContext.runId,
          status: "running",
          progress: input,
          serverTime: Date.now(),
        });
        return { recorded: true, ...input };
      },
    }),
    complete_agent_run: tool({
      description: "Explicitly finish this Agent Run after the requested work is complete. This only records the model-declared terminal state; it does not change script facts.",
      inputSchema: jsonSchema<{ stage: string; subAgent?: string; summary?: string }>(
        z.object({ stage: z.string().min(1), subAgent: z.string().min(1).optional(), summary: z.string().max(2000).optional() }).toJSONSchema(),
      ),
      execute: async (input) => {
        if (!runContext) throw new Error("Agent Run context is required to complete a run");
        runContext.setCompleted({
          stage: input.stage,
          subAgent: input.subAgent,
          reason: input.summary || "",
          resultJson: { kind: "agent_completed", summary: input.summary ?? null },
        });
        runContext.stopForTerminal();
        return { status: "completed", terminal: true, ...input };
      },
    }),
    await_user_decision: tool({
      description: "Finish this run in awaiting_user after preparing one concrete user question.",
      inputSchema: jsonSchema<{ stage: string; subAgent?: string; question: string; options?: string[]; context?: string }>(
        z.object({ stage: z.string().min(1), subAgent: z.string().min(1).optional(), question: z.string().min(1), options: z.array(z.string().min(1)).max(6).optional(), context: z.string().optional() }).toJSONSchema(),
      ),
      execute: async (input) => {
        if (!runContext) throw new Error("Agent Run context is required to await a user decision");
        runContext.setAwaitingUser({
          stage: input.stage,
          subAgent: input.subAgent,
          reason: input.question,
          resultJson: { kind: "user_decision", ...input },
        });
        runContext.stopForTerminal();
        return { status: "awaiting_user", terminal: true, ...input };
      },
    }),
    record_script_review: tool({
      description: "Persist a read-only Script Agent review as text. This never changes workspace or script facts.",
      inputSchema: jsonSchema<{ target: "storySkeleton" | "adaptationStrategy" | "script"; content: string; summary?: string }>(
        z.object({ target: reviewTargetSchema, content: z.string().min(1), summary: z.string().optional() }).toJSONSchema(),
      ),
      execute: async ({ target, content, summary }) => {
        const projectId = projectIdOf(resTool);
        const asset = await createTextAsset({
          projectId,
          targetType: "reviewReport",
          targetId: `scriptAgent:${target}`,
          content,
          summary,
        });
        if (runContext) {
          await recordAgentRunEvent(runContext.runId, "agent_output_archived", {
            category: "scriptAgentReview",
            target,
            textAssetId: asset.id,
            summary: asset.summary,
            size: asset.size,
          });
        }
        return { recorded: true, target, textAssetId: asset.id, summary: asset.summary, size: asset.size };
      },
    }),
    list_script_reviews: tool({
      description: "List Script Agent review text assets for the current project.",
      inputSchema: jsonSchema<{ target?: "storySkeleton" | "adaptationStrategy" | "script"; limit?: number }>(
        z.object({ target: reviewTargetSchema.optional(), limit: z.number().int().min(1).max(20).optional() }).toJSONSchema(),
      ),
      execute: async ({ target, limit = 10 }) => {
        const projectId = projectIdOf(resTool);
        const assets = await u.db("o_textAsset").where({ projectId, targetType: "reviewReport" }).orderBy("id", "desc").limit(limit * 3);
        const reviews = assets
          .filter((asset: any) => String(asset.targetId || "").startsWith("scriptAgent:"))
          .filter((asset: any) => !target || String(asset.targetId) === `scriptAgent:${target}`)
          .slice(0, limit)
          .map((asset: any) => ({ id: Number(asset.id), target: String(asset.targetId).slice("scriptAgent:".length), summary: String(asset.summary || ""), size: Number(asset.size || 0), createTime: Number(asset.createTime || 0) }));
        return { reviews };
      },
    }),
    read_script_review: tool({
      description: "Read one Script Agent review text asset from the current project.",
      inputSchema: jsonSchema<{ id: number; offset?: number; limit?: number }>(
        z.object({ id: z.number().int().positive(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() }).toJSONSchema(),
      ),
      execute: async ({ id, offset, limit }) => {
        const projectId = projectIdOf(resTool);
        const asset = await u.db("o_textAsset").where({ id, projectId, targetType: "reviewReport" }).first();
        if (!asset || !String(asset.targetId || "").startsWith("scriptAgent:")) throw new Error("Script review not found in current project");
        return { asset: { id: Number(asset.id), summary: String(asset.summary || ""), size: Number(asset.size || 0), target: String(asset.targetId).slice("scriptAgent:".length) }, ...(await getTextAssetContent({ id, projectId, offset, limit })) };
      },
    }),
  };

  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([name]) => toolsNames.includes(name))) : tools;
};
