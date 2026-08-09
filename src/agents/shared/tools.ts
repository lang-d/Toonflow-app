import { jsonSchema, tool } from "ai";
import { z } from "zod";
import u from "@/utils";
import { recordAgentRunEvent, type AgentRunContext } from "@/services/agentRun";

export type AgentTaskEnvelope = {
  taskId: string;
  targetType: string;
  targetId?: string | number | null;
  legacyTaskId?: number;
  status?: string;
};

export async function recordAgentTaskSubmitted(runId: string | undefined, task: AgentTaskEnvelope) {
  if (!runId) return;
  await recordAgentRunEvent(runId, "agent_task_submitted", {
    taskId: task.taskId,
    legacyTaskId: task.legacyTaskId ?? null,
    targetType: task.targetType,
    targetId: task.targetId ?? null,
    status: task.status ?? "queued",
  });
}

export function createSharedAgentTools(config: {
  runContext?: AgentRunContext;
  projectId: number;
  scriptId?: number | null;
  taskTargetTypes?: readonly string[];
  projectScopeScriptId?: number | null;
}) {
  const update_agent_progress = tool({
    description: "Record current business progress for this Agent Run. This does not complete, cancel or otherwise change the Run terminal state.",
    inputSchema: jsonSchema<{
      stage: string;
      subAgent?: string;
      title: string;
      detail?: string;
      phase?: string;
    }>(
      z
        .object({
          stage: z.string().min(1).max(100),
          subAgent: z.string().min(1).max(100).optional(),
          title: z.string().min(1).max(300),
          detail: z.string().max(2000).optional(),
          phase: z.string().max(80).optional(),
        })
        .toJSONSchema(),
    ),
    execute: async (input) => {
      if (!config.runContext) throw new Error("Agent Run context is unavailable");
      await config.runContext.updateProgress(input);
      return { recorded: true };
    },
  });

  const await_user_decision = tool({
    description: "End the current Chat in awaiting_user state with one explicit natural-language question. Do not encode UI options or buttons.",
    inputSchema: jsonSchema<{
      stage: string;
      subAgent?: string;
      question: string;
      context?: string;
    }>(
      z
        .object({
          stage: z.string().min(1).max(100),
          subAgent: z.string().min(1).max(100).optional(),
          question: z.string().min(1).max(2000),
          context: z.string().max(4000).optional(),
        })
        .toJSONSchema(),
    ),
    execute: async (input) => {
      if (!config.runContext) throw new Error("Agent Run context is unavailable");
      config.runContext.setAwaitingUser({
        stage: input.stage,
        subAgent: input.subAgent,
        reason: input.question,
        resultJson: {
          kind: "awaiting_user",
          question: input.question,
          context: input.context ?? null,
        },
      });
      return { status: "awaiting_user", terminal: true, ...input };
    },
  });

  const complete_agent_run = tool({
    description: "Explicitly complete this Agent Run after the requested work or requested async task submission is complete. This does not alter business facts or task status.",
    inputSchema: jsonSchema<{
      stage: string;
      subAgent?: string;
      summary?: string;
      outcome?: "completed" | "task_submitted";
    }>(
      z
        .object({
          stage: z.string().min(1).max(100),
          subAgent: z.string().min(1).max(100).optional(),
          summary: z.string().max(2000).optional(),
          outcome: z.enum(["completed", "task_submitted"]).default("completed"),
        })
        .toJSONSchema(),
    ),
    execute: async (input) => {
      if (!config.runContext) throw new Error("Agent Run context is required to complete a run");
      config.runContext.setCompleted({
        stage: input.stage,
        subAgent: input.subAgent,
        reason: input.summary || "",
        resultJson: {
          kind: input.outcome === "task_submitted" ? "agent_task_submitted" : "agent_completed",
          outcome: input.outcome,
          summary: input.summary ?? null,
        },
      });
      return { status: "completed", terminal: true, ...input };
    },
  });

  const get_agent_task_status = tool({
    description: "Read persisted unified task facts for the current Agent scope. Returns status and references only; it does not decide whether a task should be retried.",
    inputSchema: jsonSchema<{ taskId?: string; limit?: number }>(
      z.object({ taskId: z.string().min(1).optional(), limit: z.number().int().min(1).max(20).default(10) }).toJSONSchema(),
    ),
    execute: async ({ taskId, limit = 10 }) => {
      const query = u.db("o_tasks").where("projectId", config.projectId);
      const effectiveScriptId = config.scriptId === config.projectScopeScriptId ? null : config.scriptId;
      if (effectiveScriptId != null) {
        query.where((builder: any) => builder.where("scriptId", effectiveScriptId).orWhere("episode", effectiveScriptId));
      } else {
        query.where((builder: any) => builder.whereNull("scriptId").orWhereNull("episode").orWhere("scriptId", 0).orWhere("episode", 0));
      }
      if (config.taskTargetTypes?.length) query.whereIn("targetType", [...config.taskTargetTypes]);
      if (taskId) query.where("taskId", taskId);
      const rows = await query.orderBy("updateTime", "desc").limit(taskId ? 1 : limit);
      return {
        tasks: rows.map((row: any) => ({
          taskId: row.taskId,
          legacyTaskId: Number(row.id),
          targetType: row.targetType,
          targetId: row.targetId,
          status: row.status,
          phase: row.phase,
          progress: row.progress == null ? null : Number(row.progress),
          result: parseJson(row.resultJson),
          reason: row.reason || null,
          model: row.model || null,
          createdAt: Number(row.createdAt || row.startTime || 0) || null,
          updatedAt: Number(row.updateTime || 0) || null,
          finishedAt: Number(row.finishTime || 0) || null,
        })),
      };
    },
  });

  return {
    update_agent_progress,
    await_user_decision,
    complete_agent_run,
    get_agent_task_status,
  };
}

function parseJson(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
