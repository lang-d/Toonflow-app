import { Socket } from "socket.io";
import ResTool from "@/socket/resTool";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import { getProjectContextPack } from "@/services/projectMaterial";
import { readConfiguredSkill } from "@/services/skillResolver";
import { runAgentRuntime } from "@/agents/shared/runtime";
import { createSharedAgentTools } from "@/agents/shared/tools";
import useMusicProductionTools from "@/agents/musicProductionAgent/tools";
import {
  musicProjectIsolationKey,
  resolveMusicIsolationKey,
  type MusicScopeInput,
} from "@/services/musicScope";
import { listMusicCues, parseJsonValue, type MusicScopeMode } from "@/services/musicDirector";
import type { AgentRunContext } from "@/services/agentRun";
import { readScriptContent } from "@/services/scriptWorkspaceText";

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  text: string;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  onTaskQueued?: (task: { taskId: string; targetType: string; targetId?: string | number | null; legacyTaskId?: number; status?: string }) => void | Promise<void>;
  runContext?: AgentRunContext;
  continuation?: {
    kind: "awaiting_user" | "resumable_interruption";
    run: {
      runId: string;
      reason: string | null;
      currentStage: string | null;
      currentSubAgent: string | null;
      resultJson: string | null;
      startedAt: number | null;
    };
    decision?: unknown;
    checkpoint?: unknown;
  } | null;
  thinkConfig: {
    think: boolean;
    thinlLevel: 0 | 1 | 2 | 3;
  };
}

function truncate(value: unknown, max = 4000) {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function buildMemPrompt(title: string, mem: Awaited<ReturnType<Memory["get"]>>) {
  const sections: string[] = [];
  if (mem.rag.length) sections.push(`[Relevant]\n${mem.rag.map((row) => row.content).join("\n")}`);
  if (mem.summaries.length) sections.push(`[Summaries]\n${mem.summaries.map((row, index) => `${index + 1}. ${row.content}`).join("\n")}`);
  if (mem.shortTerm.length) sections.push(`[Recent]\n${mem.shortTerm.map((row) => `${row.role}: ${row.content}`).join("\n")}`);
  return `## ${title}\n${sections.join("\n\n") || "No memory yet."}`;
}

async function readPrompt() {
  const fallback = [
      "You are the independent music production agent.",
      "Discuss music direction with the user, then create async music tasks only after the user confirms.",
      "Use only music tools. Do not modify director plans, storyboards, assets or videos.",
      "The task center is the execution source of truth; final business data must be fetched from music detail/list APIs.",
    ].join("\n");
  return (await readConfiguredSkill("music_production_agent.md", fallback)).content;
}

async function latestMusicBible(projectId: number) {
  const row = await u
    .db("o_musicBible")
    .where({ projectId, state: "complete" })
    .orderBy("version", "desc")
    .orderBy("id", "desc")
    .first();
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    content: truncate(row.content, 3000),
    styleProfile: parseJsonValue(row.styleProfileJson, {}),
  };
}

async function latestMusicPlan(projectId: number, mode: MusicScopeMode, scriptId?: number | null) {
  const row = await u
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
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    mode: row.mode,
    scriptId: row.scriptId,
    content: truncate(row.content, 3000),
    cueSheet: parseJsonValue(row.cueSheetJson, []),
    recommendedProduction: parseJsonValue(row.recommendedProductionJson, null),
  };
}

async function buildReadOnlyProductionContext(input: Required<Pick<MusicScopeInput, "projectId">> & MusicScopeInput) {
  const project = await u
    .db("o_project")
    .where("id", input.projectId)
    .first("id", "name", "intro", "type", "artStyle", "directorManual");
  if (!project) throw new Error("Project does not exist");

  const script = input.scriptId == null
    ? null
    : await u
        .db("o_script")
        .where({ projectId: input.projectId, id: input.scriptId })
        .first("id", "name", "projectId", "content", "contentTextAssetId");
  const contextPack = await getProjectContextPack(input.projectId).catch(() => null);
  const storyboardCount = await u
    .db("o_storyboard")
    .where({ projectId: input.projectId })
    .modify((qb: any) => {
      if (input.scriptId != null) qb.where("scriptId", input.scriptId);
    })
    .count<{ count: number }[]>("id as count")
    .first();
  const trackCount = await u
    .db("o_videoTrack")
    .where({ projectId: input.projectId })
    .modify((qb: any) => {
      if (input.scriptId != null) qb.where("scriptId", input.scriptId);
    })
    .count<{ count: number }[]>("id as count")
    .first()
    .catch(() => ({ count: 0 }));
  const bible = await latestMusicBible(input.projectId);
  const plan = await latestMusicPlan(input.projectId, input.mode || "project", input.scriptId);
  const cues = plan ? await listMusicCues({ projectId: input.projectId, planId: Number(plan.id) }) : [];

  return {
    scope: {
      mode: input.mode || "project",
      projectId: input.projectId,
      scriptId: input.scriptId ?? null,
      isolationKey: resolveMusicIsolationKey(input),
      projectMemoryKey: musicProjectIsolationKey(input.projectId),
    },
    project: {
      id: project.id,
      name: project.name,
      intro: truncate(project.intro, 1200),
      type: project.type,
      artStyle: project.artStyle,
      directorManual: truncate(project.directorManual, 1200),
    },
    script: script
      ? { id: script.id, name: script.name, content: truncate(await readScriptContent(script), 4000) }
      : null,
    contextPack: contextPack ? truncate((contextPack as any).content, 3000) : "",
    productionReadOnlySummary: {
      storyboardCount: Number((storyboardCount as any)?.count || 0),
      videoTrackCount: Number((trackCount as any)?.count || 0),
    },
    latestMusicBible: bible,
    latestMusicPlan: plan,
    cueCount: cues.length,
  };
}

function stripXmlTags(text: string) {
  return text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "").replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "").trim();
}

async function ensureAgentDeployRow(input: {
  key: string;
  fallbackKey?: string;
  name: string;
  desc: string;
  copyWhenEmpty?: boolean;
}) {
  const existing = await u.db("o_agentDeploy").where("key", input.key).first();
  const fallback = input.fallbackKey ? await u.db("o_agentDeploy").where("key", input.fallbackKey).first() : null;
  const values = {
    model: fallback?.model || "",
    modelName: fallback?.modelName || "",
    vendorId: fallback?.vendorId ?? null,
  };

  if (!existing) {
    await u.db("o_agentDeploy").insert({
      ...values,
      key: input.key,
      name: input.name,
      desc: input.desc,
      temperature: fallback?.temperature ?? 1,
      maxOutputTokens: fallback?.maxOutputTokens ?? 0,
      disabled: false,
    });
    return { ...values, key: input.key };
  }

  if (input.copyWhenEmpty && !existing.modelName && values.modelName) {
    await u.db("o_agentDeploy").where("key", input.key).update(values);
    return { ...existing, ...values };
  }
  return existing;
}

async function ensureMusicProductionAgentDeploy() {
  const base = await ensureAgentDeployRow({
    key: "musicProductionAgent",
    fallbackKey: "productionAgent",
    name: "配乐生产Agent",
    desc: "独立配乐生产阶段，用于音乐创作讨论和配乐任务调度",
    copyWhenEmpty: true,
  });
  await ensureAgentDeployRow({
    key: "musicProductionAgent:decisionAgent",
    fallbackKey: "productionAgent:decisionAgent",
    name: "配乐生产Agent:决策层",
    desc: "配乐创作讨论和任务调度",
    copyWhenEmpty: true,
  });
  await ensureAgentDeployRow({
    key: "musicProductionAgent:executionAgent",
    fallbackKey: "productionAgent",
    name: "配乐生产 Agent：执行层",
    desc: "Music Bible、配乐计划、歌词与提示词创作执行",
    copyWhenEmpty: true,
  });
  await ensureAgentDeployRow({
    key: "musicProductionAgent:supervisionAgent",
    fallbackKey: "productionAgent:supervisionAgent",
    name: "配乐生产 Agent：监督层",
    desc: "Music Bible、配乐计划、歌词与提示词审核",
    copyWhenEmpty: true,
  });

  const agentUseMode = await u.db("o_setting").where("key", "agentUseMode").first();
  if (agentUseMode?.value === "1") {
    const decision = await u.db("o_agentDeploy").where("key", "musicProductionAgent:decisionAgent").first();
    if (decision && !decision.modelName && base?.modelName) {
      await u.db("o_agentDeploy").where("key", "musicProductionAgent:decisionAgent").update({
        model: base.model || "",
        modelName: base.modelName || "",
        vendorId: base.vendorId ?? null,
      });
    }
  }
}

function buildContinuationPrompt(continuation: AgentContext["continuation"]) {
  if (!continuation) return "";
  if (continuation.kind === "resumable_interruption") {
    return `## Resumable prior Music Agent Chat checkpoint (non-authoritative)\nThe current user message is authoritative. Resume only when it asks to continue.\n- sourceRunId: ${continuation.run.runId}\n- stage: ${continuation.run.currentStage || "unknown"}\n- checkpoint: ${JSON.stringify(continuation.checkpoint)}`;
  }
  return `## Recent awaiting-user Music Agent run (non-authoritative)\nUse current formal music tools before acting on versions or task results.\n- sourceRunId: ${continuation.run.runId}\n- stage: ${continuation.run.currentStage || "unknown"}\n- question: ${continuation.run.reason || ""}\n- context: ${JSON.stringify(continuation.decision)}`;
}

function contextOverflowFeedback(ctx: AgentContext) {
  const feedback = ctx.resTool.newMessage("assistant", "配乐导演");
  feedback.text("当前 Chat 因供应商连续两次报告上下文溢出而安全中断，工作断点已保存。可以发送“继续”在新 Chat 中恢复，或切换更大上下文模型后继续。");
  feedback.complete();
}

export async function runDecisionAI(ctx: AgentContext) {
  const projectId = Number(ctx.resTool.data.projectId);
  const scriptId = ctx.resTool.data.scriptId == null ? null : Number(ctx.resTool.data.scriptId);
  const mode = (ctx.resTool.data.mode || (scriptId == null ? "project" : "episode")) as MusicScopeMode;
  const expectedIsolationKey = resolveMusicIsolationKey({ projectId, scriptId, mode });
  if (ctx.isolationKey !== expectedIsolationKey) {
    throw new Error(`musicProductionAgent isolationKey mismatch: expected ${expectedIsolationKey}`);
  }
  await ensureMusicProductionAgentDeploy();

  const currentMemory = new Memory("musicProductionAgent", ctx.isolationKey, {
    autoSummarize: false,
    allowedRoles: ["user", "assistant:final", "assistant:project-music-note", "assistant:episode-music-note"],
    includeSummaries: false,
    includeAutomaticRag: false,
  });
  const currentMem = await currentMemory.get(ctx.text);
  await currentMemory.add("user", ctx.text, ctx.userMessageTime == null ? undefined : { createTime: ctx.userMessageTime });

  const projectKey = musicProjectIsolationKey(projectId);
  const projectMemory = projectKey === ctx.isolationKey ? currentMemory : new Memory("musicProductionAgent", projectKey);
  const projectMem = projectKey === ctx.isolationKey ? currentMem : await projectMemory.get(ctx.text);
  const prompt = await readPrompt();
  const readOnlyContext = await buildReadOnlyProductionContext({ projectId, scriptId, mode });

  const initialContext = [
    buildMemPrompt("Project Music Memory", projectMem),
    projectKey === ctx.isolationKey ? "" : buildMemPrompt("Episode Music Memory", currentMem),
    buildContinuationPrompt(ctx.continuation),
    `## Read-only Production Context\n${JSON.stringify(readOnlyContext, null, 2)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const buildSharedTools = () =>
    createSharedAgentTools({
      runContext: ctx.runContext,
      projectId,
      scriptId,
      projectScopeScriptId: 0,
      taskTargetTypes: ["musicBible", "musicPlan", "musicPrompt", "musicLyrics", "musicCueAsset", "musicLibraryVersion"],
    });

  await runAgentRuntime({
    agentName: "musicProductionAgent:decisionAgent",
    agentLabel: "Music Production Agent",
    modelKey: "musicProductionAgent:decisionAgent",
    stableInstructions: prompt,
    objective: ctx.text,
    initialContext,
    stage: "musicDecision",
    subAgent: "decisionAgent",
    projectId,
    scriptId,
    think: ctx.thinkConfig.think,
    thinkLevel: ctx.thinkConfig.thinlLevel,
    abortSignal: ctx.abortSignal,
    runContext: ctx.runContext,
    message: {
      get: () => ctx.msg,
      set: (message) => {
        ctx.msg = message;
      },
      create: () => ctx.resTool.newMessage("assistant", "配乐导演"),
    },
    buildTools: () => ({
      ...currentMemory.getTools(),
      ...useMusicProductionTools({
        resTool: ctx.resTool,
        msg: ctx.msg,
        onTaskQueued: ctx.onTaskQueued,
      }),
      ...buildSharedTools(),
    }),
    terminalCorrection: {
      maxAttempts: 1,
      buildTools: () => {
        const { await_user_decision, complete_agent_run } = buildSharedTools();
        return { await_user_decision, complete_agent_run };
      },
    },
    onRepeatedContextOverflow: () => contextOverflowFeedback(ctx),
  });

  const finalMemory = stripXmlTags(ctx.runContext?.terminalIntent?.reason || "");
  if (finalMemory) await currentMemory.add("assistant:final", finalMemory, { createTime: Date.now() });
}
