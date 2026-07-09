import { Socket } from "socket.io";
import { z } from "zod";
import { tool, jsonSchema } from "ai";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import useTools from "@/agents/productionAgent/tools";
import ResTool from "@/socket/resTool";
import { createTextAsset, summarizeLongText } from "@/services/textAsset";
import { getDirectorPlanGenerationState } from "@/services/directorPlanGeneration";
import { runLazyRetentionCleanup } from "@/services/retention";
import { getVideoModelPolicy } from "@/services/videoModelPolicy";
import { getProjectContextPack } from "@/services/projectMaterial";
import { readConfiguredSkill } from "@/services/skillResolver";
import { loadProductionStage, productionSupervisionStage } from "@/services/productionStageSkills";
import { createLogger } from "@/logger";
import {
  consumeFullStream as consumeAgentFullStream,
  createAgentModelStreamScope,
} from "@/agents/shared/streaming";
import type { AgentRunContext } from "@/services/agentRun";

const productionAgentLog = createLogger("production-agent");

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  text: string;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  messages?: { role: "user" | "assistant" | "system"; content: string }[];
  thinkConfig: {
    think: boolean;
    thinlLevel: 0 | 1 | 2 | 3;
  };
  runContext?: AgentRunContext;
  continuation?: {
    run: {
      runId: string;
      reason: string | null;
      currentStage: string | null;
      currentSubAgent: string | null;
      resultJson: string | null;
      startedAt: number | null;
    };
    decision: unknown;
  } | null;
}

function isAbortError(error: unknown) {
  const err = error as { name?: string; code?: string } | undefined;
  return err?.name === "AbortError" || err?.code === "ABORT_ERR";
}

function buildMemPrompt(mem: Awaited<ReturnType<Memory["get"]>>): string {
  let memoryContext = "";
  if (mem.rag.length) {
    memoryContext += `[相关记忆]\n${mem.rag.map((r) => r.content).join("\n")}`;
  }
  if (mem.summaries.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[历史摘要]\n${mem.summaries.map((s, i) => `${i + 1}. ${s.content}`).join("\n")}`;
  }
  if (mem.shortTerm.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[近期对话]\n${mem.shortTerm.map((m) => `${m.role}: ${m.content}`).join("\n")}`;
  }
  return `## Memory\n以下是你对用户的记忆，可作为参考但不要主动提及：\n${memoryContext}`;
}

function buildContinuationPrompt(continuation: AgentContext["continuation"]) {
  if (!continuation) return "";
  return `

## Pending user decision (authoritative continuation)
This context comes from the latest unresolved awaiting_user run in the same project/script session.
- sourceRunId: ${continuation.run.runId}
- stage: ${continuation.run.currentStage || "unknown"}
- subAgent: ${continuation.run.currentSubAgent || "unknown"}
- question/reason: ${continuation.run.reason || ""}
- structuredContext: ${JSON.stringify(continuation.decision)}

If the user is answering or asking to adjust this pending decision, continue from this context. For a storyboard-table validation decision, invoke storyboardTableAgent and preserve the generationId. The storyboard subagent must read the failed draft with get_storyboard_generation_draft before creating a revised generation. Do not treat the current formal storyboard table as the failed draft.`;
}

async function readBuiltinSkill(fileName: string) {
  return (await readConfiguredSkill(fileName)).content;
}

interface ProductionProjectModelSource {
  id?: number | string | null;
  imageModel?: string | null;
  videoModel?: string | null;
  mode?: string | null;
}

function configuredModelName(modelKey: string | null | undefined) {
  const [, modelName] = String(modelKey || "").split(/:(.+)/);
  return modelName || String(modelKey || "未配置");
}

export async function buildProductionProjectModelContext(projectInfo: ProductionProjectModelSource) {
  const videoModelKey = String(projectInfo.videoModel || "");
  const durationPolicy = await getVideoModelPolicy(videoModelKey);
  let videoMode: unknown = projectInfo.mode ?? "";
  try {
    videoMode = JSON.parse(String(projectInfo.mode ?? ""));
  } catch {
    // Legacy projects may store a plain mode string.
  }

  const availabilityText =
    durationPolicy.availability === "available"
      ? "可用，能力信息完整"
      : durationPolicy.availability === "metadata_incomplete"
        ? "可用，但时长等能力信息不完整"
        : "当前不可用或供应商模型目录尚未就绪";
  const durationText =
    durationPolicy.availability === "available"
      ? `${durationPolicy.maxDuration}s（已按模型能力验证）`
      : `${durationPolicy.maxDuration}s（安全兜底，仅用于规划，不代表模型已验证支持）`;
  const modelInfo = [
    "项目使用的模型如下：",
    `图像模型：${configuredModelName(projectInfo.imageModel)}`,
    `视频模型：${configuredModelName(videoModelKey)}`,
    `视频模型状态：${availabilityText}`,
    `多参：${Array.isArray(videoMode) ? "是" : "否"}`,
    `默认视频模型最大规划时长：${durationText}`,
    "分镜组是一次视频生成单元，不是场次；单组总时长不得超过默认视频模型最大规划时长。",
    durationPolicy.availability === "unavailable"
      ? "当前只允许继续策划；实际生成视频前必须刷新供应商模型或重新选择可用模型。"
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const logContext = {
    event: "project-video-model.resolved",
    projectId: projectInfo.id ?? undefined,
    model: videoModelKey,
    availability: durationPolicy.availability,
    maxDuration: durationPolicy.maxDuration,
    diagnostic: durationPolicy.diagnostic,
  };
  if (durationPolicy.availability === "available") {
    productionAgentLog.info("Project video model metadata resolved", logContext);
  } else {
    productionAgentLog.warn("Project video model metadata degraded; continuing planning", logContext);
  }

  return { modelInfo, durationPolicy };
}

function isExplicitStoryboardImageGenerationRequest(text: string) {
  const compact = String(text || "").replace(/\s+/g, "");
  if (!/(分镜图|分镜图片|故事板图|storyboard)/i.test(compact)) return false;
  if (/(不生成|不要生成|别生成|暂不生成|先不生成|无需生成|不用生成)/.test(compact)) return false;
  return /(生成|开始|启动|确认|同意|执行|生图)/.test(compact);
}

function isShortConfirmation(text: string) {
  const compact = String(text || "").replace(/\s+/g, "");
  return /^(确认|可以|好的|好|同意|开始|生成|是|要)$/.test(compact);
}

function recentlyAskedStoryboardImageGeneration(mem: Awaited<ReturnType<Memory["get"]>>) {
  const recent = mem.shortTerm
    .slice(-6)
    .map((item) => `${item.role}: ${item.content}`)
    .join("\n");
  return /是否生成分镜图|要不要生成分镜图|确认生成分镜图|生成分镜图/.test(recent);
}

function allowsDerivedAssetDelete(userText: string, taskPrompt: string) {
  return /(删除|移除|删掉|清除|作废|delete|remove)/i.test(`${userText}\n${taskPrompt}`);
}

async function buildDirectorProjectContextPrompt(projectId: number) {
  const pack = await getProjectContextPack(projectId).catch(() => null);
  const content = String(pack?.content || "").trim();
  if (!content) return "";
  const clipped = content.length > 4000 ? `${content.slice(0, 4000)}\n...(已截断)` : content;
  return `

【项目制作参考包（仅供导演规划软参考）】
用途：用于保持项目连续性、角色关系、世界观、视觉方向、音乐/节奏方向。
优先级：不得覆盖用户本轮明确要求、剧本文本、已有资产设定；不要把参考包原文整段复述进导演规划。

${clipped}`;
}

export async function runDecisionAI(ctx: AgentContext) {
  const { isolationKey, text, abortSignal } = ctx;
  const memory = new Memory("productionAgent", isolationKey);
  await memory.add("user", text);

  const prompt = await readBuiltinSkill("production_agent_decision.md");

  const projectInfo = await u.db("o_project").where("id", ctx.resTool.data.projectId).first();
  if (!projectInfo) throw new Error(`项目不存在，ID: ${ctx.resTool.data.projectId}`);
  const { modelInfo } = await buildProductionProjectModelContext(projectInfo);

  const mem = buildMemPrompt(await memory.get(text));
  const continuationPrompt = buildContinuationPrompt(ctx.continuation);

  const modelStreamScope = createAgentModelStreamScope(abortSignal);
  if (ctx.runContext) {
    ctx.runContext.requestStop = () => modelStreamScope.abort();
    ctx.runContext.markStage("decision", "decisionAgent");
  }
  try {
    const { fullStream } = await u.Ai.Text("productionAgent:decisionAgent", ctx.thinkConfig.think, ctx.thinkConfig.thinlLevel).stream({
      messages: [
        { role: "system", content: prompt },
        { role: "assistant", content: mem + "\n" + modelInfo + continuationPrompt },
        { role: "user", content: text },
      ],
      abortSignal: modelStreamScope.signal,
      tools: {
        ...memory.getTools(),
        ...useTools({
          resTool: ctx.resTool,
          msg: ctx.msg,
          toolsNames: ["get_flowData", "await_user_decision"],
          runContext: ctx.runContext,
        }),
        ...(await createSubAgent(ctx, { projectInfo, modelInfo })),
      },
      onFinish: async (completion) => {
        await memory.add("assistant:decision", removeAllXmlTags(completion.text));
      },
    });

    let currentMsg = ctx.msg;
    await consumeAgentFullStream({
      agentName: "productionAgent:decisionAgent",
      fullStream,
      initialMsg: currentMsg,
      userAbortSignal: abortSignal,
      abortModelStream: modelStreamScope.abort,
      projectId: ctx.resTool.data.projectId,
      scriptId: ctx.resTool.data.scriptId,
      syncMsg: () => {
        if (ctx.msg === currentMsg) return currentMsg;
        currentMsg.complete();
        currentMsg = ctx.msg;
        return currentMsg;
      },
    });
  } finally {
    if (ctx.runContext?.requestStop) ctx.runContext.requestStop = undefined;
    modelStreamScope.dispose();
  }
}

async function createSubAgent(
  parentCtx: AgentContext,
  context: { projectInfo: any; modelInfo: string },
) {
  const { resTool, abortSignal } = parentCtx;
  const { projectInfo, modelInfo } = context;
  const memory = new Memory("productionAgent", parentCtx.isolationKey);
  const continuationPrompt = buildContinuationPrompt(parentCtx.continuation);
  async function runAgent({
    key,
    prompt,
    system,
    name,
    memoryKey,
    tools: extraTools,
    toolNames,
    messages,
  }: {
    key: `${string}:${string}`;
    prompt: string;
    system: string;
    name: string;
    memoryKey: string;
    tools?: Record<string, any>;
    toolNames: string[];
    messages?: { role: "user" | "assistant" | "system"; content: string }[];
  }) {
    parentCtx.msg.complete();
    const subMsg = resTool.newMessage("assistant", name);

    const modelStreamScope = createAgentModelStreamScope(abortSignal);
    parentCtx.runContext?.markStage(memoryKey.replace(/^assistant:/, ""), key.split(":")[1] || key);
    const previousStop = parentCtx.runContext?.requestStop;
    if (parentCtx.runContext) parentCtx.runContext.requestStop = () => modelStreamScope.abort();
    let fullResponse: string;
    try {
      const { fullStream } = await u.Ai.Text(key, parentCtx.thinkConfig.think, parentCtx.thinkConfig.thinlLevel).stream({
        system,
        messages: messages ?? [{ role: "user", content: prompt }],
        abortSignal: modelStreamScope.signal,
        tools: { ...extraTools, ...useTools({ resTool, msg: subMsg, toolsNames: toolNames, runContext: parentCtx.runContext }) },
      });

      fullResponse = await consumeAgentFullStream({
        agentName: key,
        fullStream,
        initialMsg: subMsg,
        userAbortSignal: abortSignal,
        abortModelStream: modelStreamScope.abort,
        projectId: resTool.data.projectId,
        scriptId: resTool.data.scriptId,
      });
    } catch (error) {
      if (parentCtx.runContext?.terminalIntent && isAbortError(error)) {
        fullResponse = parentCtx.runContext.terminalIntent.reason;
      } else {
        throw error;
      }
    } finally {
      if (parentCtx.runContext) parentCtx.runContext.requestStop = previousStop;
      modelStreamScope.dispose();
    }

    if (fullResponse.trim()) {
      let memoryContent = removeAllXmlTags(fullResponse);
      if (memoryContent.length > 4000) {
        try {
          await runLazyRetentionCleanup();
          const asset = await createTextAsset({
            projectId: Number(resTool.data.projectId),
            scriptId: resTool.data.scriptId == null ? null : Number(resTool.data.scriptId),
            targetType: "agentOutput",
            targetId: `${key}:${Date.now()}`,
            content: fullResponse,
            summary: `${name} output (${fullResponse.length} chars)`,
            state: "complete",
          });
          memoryContent = summarizeLongText(memoryContent, asset.id);
        } catch (err) {
          console.warn("[productionAgent] failed to archive long output", err);
        }
      }
      await memory.add(memoryKey, memoryContent, {
        name,
        createTime: new Date(subMsg.datetime).getTime(),
      });
    }

    parentCtx.msg = resTool.newMessage("assistant", "视频策划");
    if (parentCtx.runContext?.terminalIntent) parentCtx.runContext.stopForTerminal();
    return fullResponse;
  }

  const promptInput = z
    .object({
      prompt: z.string().describe("交给子Agent的任务简约描述，100字以内"),
    })
    .toJSONSchema();

  let storyboardPanelRanThisTurn = false;

  //衍生资产分析与信息写入
  const run_sub_agent_derive_assets = tool({
    description: "运行执行subAgent来完成衍生资产分析与信息写入相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const stage = await loadProductionStage({
        stage: "deriveAssets",
        artStyle: projectInfo.artStyle || "",
        directorManual: projectInfo.directorManual || "",
      });
      const toolNames = allowsDerivedAssetDelete(parentCtx.text, prompt)
        ? [...stage.definition.tools, "del_deriveAsset"]
        : stage.definition.tools;
      return runAgent({
        key: "productionAgent:deriveAssetsAgent",
        prompt,
        system: stage.workflow,
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: modelInfo },
          { role: "user", content: prompt },
        ],
        tools: stage.tools,
        toolNames,
      });
    },
  });

  //衍生资产图片生成
  const run_sub_agent_generate_assets = tool({
    description: "运行执行subAgent来完成衍生资产图片生成相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const stage = await loadProductionStage({
        stage: "generateAssets",
        artStyle: projectInfo.artStyle || "",
        directorManual: projectInfo.directorManual || "",
      });
      return runAgent({
        key: "productionAgent:generateAssetsAgent",
        prompt,
        system: stage.workflow,
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: modelInfo },
          { role: "user", content: prompt },
        ],
        tools: stage.tools,
        toolNames: stage.definition.tools,
      });
    },
  });

  //拍摄计划
  const run_sub_agent_director_plan = tool({
    description: "运行执行subAgent来完成导演规划相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const startedAt = Date.now();
      const stage = await loadProductionStage({
        stage: "directorPlan",
        artStyle: projectInfo.artStyle || "",
        directorManual: projectInfo.directorManual || "",
      });

      const projectContextPrompt = await buildDirectorProjectContextPrompt(Number(resTool.data.projectId));
      const directorPromptContext = projectContextPrompt;

      const response = await runAgent({
        key: "productionAgent:directorPlanAgent",
        prompt,
        system: stage.workflow,
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: stage.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt + directorPromptContext },
        ],
        tools: stage.tools,
        toolNames: stage.definition.tools,
      });
      const generation = await getDirectorPlanGenerationState(
        Number(resTool.data.projectId),
        Number(resTool.data.scriptId),
      );
      const current = generation.current;
      if (current?.state === "committed" && current.textAssetId && Number(current.updatedAt) >= startedAt) {
        return JSON.stringify({
          status: "committed",
          generationId: current.generationId,
          textAssetId: current.textAssetId,
          version: current.version,
          summary: response.trim().slice(0, 1000),
        });
      }
      parentCtx.runContext?.setAwaitingUser({
        stage: "directorPlan",
        subAgent: "directorPlanAgent",
        reason: "Director plan was not committed in this execution; user decision is required before retrying.",
        resultJson: {
          generationId: current?.generationId || null,
          state: current?.state || "failed",
          error: generation.lastFailure?.errorJson || null,
        },
      });
      parentCtx.runContext?.stopForTerminal();
      return JSON.stringify({
        status: current?.state || "failed",
        generationId: current?.generationId || null,
        error: generation.lastFailure?.errorJson || "Director plan was not committed in this execution.",
        terminal: true,
      });
    },
  });

  //分镜图生成
  const run_sub_agent_storyboard_gen = tool({
    description: "运行执行subAgent来完成分镜图生成相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      if (storyboardPanelRanThisTurn) {
        return "分镜面板刚刚写入完成。必须先等待用户明确确认，不能在同一轮自动启动分镜图生成。请询问用户是否生成分镜图。";
      }
      const confirmedFromRecentPrompt =
        isShortConfirmation(parentCtx.text) && recentlyAskedStoryboardImageGeneration(await memory.get(parentCtx.text));
      if (!isExplicitStoryboardImageGenerationRequest(parentCtx.text) && !confirmedFromRecentPrompt) {
        return "未检测到用户本轮明确确认生成分镜图。不能自动启动分镜图生成；请先询问用户是否生成分镜图。";
      }
      const stage = await loadProductionStage({
        stage: "storyboardGenerate",
        artStyle: projectInfo.artStyle || "",
        directorManual: projectInfo.directorManual || "",
      });
      return runAgent({
        key: "productionAgent:storyboardGenAgent",
        prompt,
        system: stage.workflow,
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: modelInfo },
          { role: "user", content: prompt },
        ],
        tools: stage.tools,
        toolNames: stage.definition.tools,
      });
    },
  });

  // const mainSkills: { path: string; name: string; description: string }[] = [];
  // for (const skill of mainSkill) {
  //   const skillPath = path.join(rootDir, skill + ".md");
  //   if (!fs.existsSync(skillPath)) throw new Error(`主技能文件不存在: ${skillPath}`);
  //   if (!isPathInside(skillPath, normalizedRootDir)) throw new Error(`技能名称无效：检测到路径穿越。${skillPath}`);
  //   const content = await fs.promises.readFile(skillPath, "utf-8");
  //   const parsed = parseFrontmatter(content);
  //   mainSkills.push({ path: skillPath, ...parsed });
  // }

  //分镜面板写入
  const run_sub_agent_storyboard_panel = tool({
    description: "运行执行subAgent来完成分镜面板写入相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const stage = await loadProductionStage({
        stage: "storyboardPanel",
        artStyle: projectInfo.artStyle || "",
        directorManual: projectInfo.directorManual || "",
      });

      const addPrompt = `

分镜叙事事实已经由 tableRowJson 保存。你不能新增分镜，也不能修改任何分镜事实。
你必须读取 get_flowData("storyboard") 返回的已有分镜，并调用 update_storyboard_panel_v2：
- 使用 storyboardId（优先）或 index 定位已有分镜。
- 只写分镜图 prompt、shouldGenerateImage 和 associateAssetsIds。
- prompt 仅用于生成分镜图，不是视频叙事事实源。
- 不生成 videoDesc。
- 不输出 XML、Markdown 或完整分镜 JSON，不要求前端解析或保存。
`;

      const response = await runAgent({
        key: "productionAgent:storyboardPanelAgent",
        prompt,
        system:
          stage.workflow +
          addPrompt +
          "\n\n完成后必须停止，等待用户明确确认后才允许进入分镜图生成阶段；不得自行启动分镜图生成。",
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: stage.prompt + `\n${modelInfo}` },
          {
            role: "user",
            content:
              prompt +
              addPrompt +
              "\n\n完成后必须停止，等待用户明确确认后才允许进入分镜图生成阶段；不得自行启动分镜图生成。",
          },
        ],
        tools: stage.tools,
        toolNames: stage.definition.tools,
      });
      storyboardPanelRanThisTurn = true;
      parentCtx.runContext?.setAwaitingUser({
        stage: "storyboardPanel",
        subAgent: "storyboardPanelAgent",
        reason: "Storyboard panel has been written; user confirmation is required before generating storyboard images.",
      });
      parentCtx.runContext?.stopForTerminal();
      return `${response}\n\n分镜面板写入已完成。需要用户明确确认后，才能启动分镜图生成。`;
    },
  });

  //分镜表写入
  const run_sub_agent_storyboard_table = tool({
    description: "运行执行subAgent来完成分镜表构建相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const stage = await loadProductionStage({
        stage: "storyboardTable",
        artStyle: projectInfo.artStyle || "",
        directorManual: projectInfo.directorManual || "",
      });

      const addPrompt = `

你必须只通过结构化工具写入分镜表，不得输出整张 Markdown、XML、JSON 或要求前端解析文本。
执行顺序：
1. 先完成全局分组和总行数规划，调用 begin_storyboard_table。
2. 严格按 index 从 0 开始，每批 5-10 条调用 append_storyboard_rows。
3. 每批以后端返回的 nextIndex 继续；中断重试时提交完全相同的批次。
4. 全部写入后调用 commit_storyboard_table。
5. 提交成功后只返回“分镜表已完成，共 N 条分镜、M 个分组”。
每条分镜必须完整符合 StoryboardTableRow 结构；禁止从 videoDesc、Markdown、XML、图片 prompt 或聊天文本恢复事实。
`;

      const storyboardTableRules =
        "\n\n分镜组规则：分镜组是一次视频生成单元，不是场次。单个场次可拆为多个分镜组；每组 storyboardIndexes 必须连续递增；每组 durationSec 总和必须小于等于上方模型信息里的默认视频模型最大支持时长。跨场景、跨时间、跨连续事件目标或跨戏剧功能时必须新建分镜组。";

      const commitFailureRules =
        "\n\nCommit failure handling: if commit_storyboard_table returns status=invalid, do not retry any storyboard write tool in this run. Explain every returned issue in user-facing language, offer concrete adjustment choices, then call await_user_decision. If it returns status=failed, stop immediately and report the failure. Never start a new generation in the same execution turn.";

      const response = await runAgent({
        key: "productionAgent:storyboardTableAgent",
        prompt,
        system: stage.workflow + addPrompt + storyboardTableRules + commitFailureRules,
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: stage.prompt + `\n${modelInfo}` + continuationPrompt },
          {
            role: "user",
            content: prompt + addPrompt + storyboardTableRules + commitFailureRules + continuationPrompt,
          },
        ],
        tools: stage.tools,
        toolNames: stage.definition.tools,
      });
      if (parentCtx.runContext?.pendingDecision && !parentCtx.runContext.terminalIntent) {
        parentCtx.runContext.setAwaitingUser(parentCtx.runContext.pendingDecision);
        parentCtx.runContext.stopForTerminal();
      }
      return response;
    },
  });

  const run_sub_agent_supervision = tool({
    description: "运行监督层subAgent执行独立任务，完成后返回结果",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const startedAt = Date.now();
      const beforeOpenSuggestions = await u
        .db("o_productionReviewSuggestion")
        .where({ projectId: Number(resTool.data.projectId), scriptId: Number(resTool.data.scriptId), status: "open" })
        .count<{ count: number }[]>({ count: "*" });
      const stage = await loadProductionStage({
        stage: productionSupervisionStage(prompt),
        artStyle: projectInfo.artStyle || "",
        directorManual: projectInfo.directorManual || "",
      });
      const response = await runAgent({
        key: "productionAgent:supervisionAgent",
        prompt,
        system: stage.workflow,
        name: "监制",
        memoryKey: "assistant:supervision",
        messages: [
          { role: "assistant", content: stage.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt },
        ],
        tools: stage.tools,
        toolNames: stage.definition.tools,
      });
      const beforeCount = Number(beforeOpenSuggestions?.[0]?.count || 0);
      const afterOpenSuggestions = await u
        .db("o_productionReviewSuggestion")
        .where({ projectId: Number(resTool.data.projectId), scriptId: Number(resTool.data.scriptId), status: "open" })
        .andWhere("updateTime", ">=", startedAt)
        .count<{ count: number }[]>({ count: "*" });
      const newSuggestionCount = Number(afterOpenSuggestions?.[0]?.count || 0);
      if (newSuggestionCount > 0) {
        parentCtx.runContext?.setAwaitingUser({
          stage: "supervision",
          subAgent: "supervisionAgent",
          reason: "Production review has open suggestions that require user handling.",
          resultJson: { newSuggestionCount, openSuggestionCountBeforeRun: beforeCount },
        });
        parentCtx.runContext?.stopForTerminal();
      }
      return response;
    },
  });

  return {
    run_sub_agent_derive_assets,
    run_sub_agent_generate_assets,
    run_sub_agent_director_plan,
    run_sub_agent_storyboard_gen,
    run_sub_agent_storyboard_panel,
    run_sub_agent_storyboard_table,
    run_sub_agent_supervision,
  };
}

function removeAllXmlTags(text: string): string {
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "");
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "");
  text = text.replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "");
  return text.trim();
}
