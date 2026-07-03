import { Socket } from "socket.io";
import { z } from "zod";
import { tool, jsonSchema } from "ai";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import { createSkillTools, parseFrontmatter, scanSkills, useSkill } from "@/utils/agent/skillsTools";
import useTools from "@/agents/productionAgent/tools";
import ResTool from "@/socket/resTool";
import * as fs from "fs";
import path from "path";
import { findBuiltinDataDir, readBuiltinDataFile } from "@/services/builtinData";
import { createTextAsset, summarizeLongText } from "@/services/textAsset";
import { getProjectDefaultVideoPolicy } from "@/services/videoModelPolicy";
import { getProjectContextPack } from "@/services/projectMaterial";
import {
  consumeFullStream as consumeAgentFullStream,
  createAgentModelStreamScope,
} from "@/agents/shared/streaming";

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

async function readBuiltinSkill(fileName: string) {
  const builtin = await readBuiltinDataFile("skills", fileName);
  if (builtin) return builtin.content;
  return fs.promises.readFile(path.join(u.getPath("skills"), fileName), "utf-8");
}

async function buildProductionModelInfo(params: {
  projectId: number;
  imageModelName: string;
  videoModelName: string;
  isRef: boolean;
}) {
  const durationPolicy = await getProjectDefaultVideoPolicy(params.projectId);
  const durationText = durationPolicy.canValidate
    ? `${durationPolicy.maxDuration}s`
    : `${durationPolicy.maxDuration}s（供应商未提供完整时长配置，按系统兜底提示；后端不会硬阻断）`;
  return [
    "项目使用的模型如下：",
    `图像模型：${params.imageModelName}`,
    `视频模型：${params.videoModelName}`,
    `多参：${params.isRef ? "是" : "否"}`,
    `默认视频模型最大支持时长：${durationText}`,
    "分镜组是一次视频生成单元，不是场次；单组总时长不得超过默认视频模型最大支持时长。",
  ].join("\n");
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

export function extractCompleteScriptPlanXml(text: string) {
  const match = String(text || "").match(/<scriptPlan\b[^>]*>([\s\S]*?)<\/scriptPlan>/i);
  const content = match?.[1]?.trim() || "";
  return content ? content : "";
}

async function persistDirectorScriptPlan(params: { projectId: number; scriptId: number; response: string }) {
  const content = extractCompleteScriptPlanXml(params.response);
  if (!content) return null;
  return createTextAsset({
    projectId: params.projectId,
    scriptId: params.scriptId,
    targetType: "scriptPlan",
    targetId: "director-plan",
    content,
    summary: "",
    state: "complete",
  });
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

function skillDirCandidates(...parts: string[]) {
  const dirs = [
    findBuiltinDataDir("skills", ...parts),
    u.getPath(["skills", ...parts]),
  ].filter(Boolean) as string[];
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

export async function runDecisionAI(ctx: AgentContext) {
  const { isolationKey, text, abortSignal } = ctx;
  const memory = new Memory("productionAgent", isolationKey);
  await memory.add("user", text);

  const prompt = await readBuiltinSkill("production_agent_decision.md");

  const projectInfo = await u.db("o_project").where("id", ctx.resTool.data.projectId).first();
  if (!projectInfo) throw new Error(`项目不存在，ID: ${ctx.resTool.data.projectId}`);
  const [_, imageModelName] = projectInfo.imageModel!.split(/:(.+)/);
  const [id, videoModelName] = projectInfo.videoModel!.split(/:(.+)/);
  const models = await u.vendor.getModelList(id);
  if (!models.length) throw new Error(`项目使用的模型不存在，ID: ${projectInfo.videoModel}`);
  let videoMode = "";
  try {
    videoMode = JSON.parse(projectInfo.mode ?? "");
  } catch (e) {
    videoMode = projectInfo.mode ?? "";
  }
  const isRef = Array.isArray(videoMode) ? true : false;
  // const findData = models.find((i: any) => i.modelName == videoModelName);
  // const isRef = findData.mode.every((i: any) => Array.isArray(i));

  const modelInfo = await buildProductionModelInfo({
    projectId: Number(ctx.resTool.data.projectId),
    imageModelName,
    videoModelName,
    isRef,
  });

  const mem = buildMemPrompt(await memory.get(text));

  const modelStreamScope = createAgentModelStreamScope(abortSignal);
  try {
    const { fullStream } = await u.Ai.Text("productionAgent:decisionAgent", ctx.thinkConfig.think, ctx.thinkConfig.thinlLevel).stream({
      messages: [
        { role: "system", content: prompt },
        { role: "assistant", content: mem + "\n" + modelInfo },
        { role: "user", content: text },
      ],
      abortSignal: modelStreamScope.signal,
      tools: {
        ...memory.getTools(),
        ...useTools({ resTool: ctx.resTool, msg: ctx.msg }),
        ...(await createSubAgent(ctx)),
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
    modelStreamScope.dispose();
  }
}

async function createSubAgent(parentCtx: AgentContext) {
  const { resTool, abortSignal } = parentCtx;
  const memory = new Memory("productionAgent", parentCtx.isolationKey);
  async function runAgent({
    key,
    prompt,
    system,
    name,
    memoryKey,
    tools: extraTools,
    messages,
  }: {
    key: `${string}:${string}`;
    prompt: string;
    system: string;
    name: string;
    memoryKey: string;
    tools?: Record<string, any>;
    messages?: { role: "user" | "assistant" | "system"; content: string }[];
  }) {
    parentCtx.msg.complete();
    const subMsg = resTool.newMessage("assistant", name);

    const modelStreamScope = createAgentModelStreamScope(abortSignal);
    let fullResponse: string;
    try {
      const { fullStream } = await u.Ai.Text(key, parentCtx.thinkConfig.think, parentCtx.thinkConfig.thinlLevel).stream({
        system,
        messages: messages ?? [{ role: "user", content: prompt }],
        abortSignal: modelStreamScope.signal,
        tools: { ...extraTools, ...useTools({ resTool, msg: subMsg }) },
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
    } finally {
      modelStreamScope.dispose();
    }

    if (fullResponse.trim()) {
      let memoryContent = removeAllXmlTags(fullResponse);
      if (memoryContent.length > 4000) {
        try {
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
    return fullResponse;
  }

  const promptInput = z
    .object({
      prompt: z.string().describe("交给子Agent的任务简约描述，100字以内"),
    })
    .toJSONSchema();

  const projectInfo = await u.db("o_project").where("id", resTool.data.projectId).first();
  if (!projectInfo) throw new Error(`项目不存在，ID: ${resTool.data.projectId}`);
  const artSkills = await createArtSkills(projectInfo?.artStyle!, projectInfo?.directorManual!);

  const [_, imageModelName] = projectInfo.imageModel!.split(/:(.+)/);
  const [id, videoModelName] = projectInfo.videoModel!.split(/:(.+)/);
  const models = await u.vendor.getModelList(id);
  if (!models.length) throw new Error(`项目使用的模型不存在，ID: ${projectInfo.videoModel}`);
  // const findData = models.find((i: any) => i.modelName == videoModelName);
  //
  let videoMode = "";
  try {
    videoMode = JSON.parse(projectInfo.mode ?? "");
  } catch (e) {
    videoMode = projectInfo.mode ?? "";
  }
  const isRef = Array.isArray(videoMode) ? true : false;

  const modelInfo = await buildProductionModelInfo({
    projectId: Number(resTool.data.projectId),
    imageModelName,
    videoModelName,
    isRef,
  });
  let storyboardPanelRanThisTurn = false;

  //衍生资产分析与信息写入
  const run_sub_agent_derive_assets = tool({
    description: "运行执行subAgent来完成衍生资产分析与信息写入相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const systemPrompt = await readBuiltinSkill("production_execution_derive_assets.md");
      return runAgent({
        key: "productionAgent:deriveAssetsAgent",
        prompt,
        system: systemPrompt,
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: artSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt },
        ],
        tools: { activate_skill: artSkills.tools.activate_skill },
      });
    },
  });

  //衍生资产图片生成
  const run_sub_agent_generate_assets = tool({
    description: "运行执行subAgent来完成衍生资产图片生成相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const systemPrompt = await readBuiltinSkill("production_execution_generate_assets.md");
      return runAgent({
        key: "productionAgent:generateAssetsAgent",
        prompt,
        system: systemPrompt,
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: artSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt },
        ],
        tools: { activate_skill: artSkills.tools.activate_skill },
      });
    },
  });

  //拍摄计划
  const run_sub_agent_director_plan = tool({
    description: "运行执行subAgent来完成导演规划相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const systemPrompt = await readBuiltinSkill("production_execution_director_plan.md");

      const addPrompt = "\n你必须使用如下XML格式写入工作区：\n```\n<scriptPlan>内容</scriptPlan>\n```";
      const projectContextPrompt = await buildDirectorProjectContextPrompt(Number(resTool.data.projectId));
      const directorPromptContext = `${projectContextPrompt}${addPrompt}`;

      const response = await runAgent({
        key: "productionAgent:directorPlanAgent",
        prompt,
        system: systemPrompt + addPrompt,
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: artSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt + directorPromptContext },
        ],
        tools: { activate_skill: artSkills.tools.activate_skill },
      });
      try {
        const asset = await persistDirectorScriptPlan({
          projectId: Number(resTool.data.projectId),
          scriptId: Number(resTool.data.scriptId),
          response,
        });
        if (asset) return `${response}\n\n导演规划已持久化为 textAsset:${asset.id}。`;
      } catch (err) {
        console.warn("[productionAgent] failed to persist scriptPlan", err);
      }
      return response;
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
      const systemPrompt = await readBuiltinSkill("production_execution_storyboard_gen.md");
      return runAgent({
        key: "productionAgent:storyboardGenAgent",
        prompt,
        system: systemPrompt,
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: artSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt },
        ],
        tools: { activate_skill: artSkills.tools.activate_skill },
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

  const productionSkills = await useProductionSkills(projectInfo?.artStyle!, projectInfo?.directorManual!);

  //分镜面板写入
  const run_sub_agent_storyboard_panel = tool({
    description: "运行执行subAgent来完成分镜面板写入相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const systemPrompt = await readBuiltinSkill("production_execution_storyboard_panel.md");

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
          systemPrompt +
          addPrompt +
          "\n\n完成后必须停止，等待用户明确确认后才允许进入分镜图生成阶段；不得自行启动分镜图生成。",
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: productionSkills.prompt + `\n${modelInfo}` },
          {
            role: "user",
            content:
              prompt +
              addPrompt +
              "\n\n完成后必须停止，等待用户明确确认后才允许进入分镜图生成阶段；不得自行启动分镜图生成。",
          },
        ],
        tools: { activate_skill: productionSkills.tools.activate_skill },
      });
      storyboardPanelRanThisTurn = true;
      return `${response}\n\n分镜面板写入已完成。需要用户明确确认后，才能启动分镜图生成。`;
    },
  });

  //分镜表写入
  const run_sub_agent_storyboard_table = tool({
    description: "运行执行subAgent来完成分镜表构建相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const systemPrompt = await readBuiltinSkill("production_execution_storyboard_table.md");

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
        "\n\nCommit failure handling: if commit_storyboard_table returns status=invalid or status=failed, stop immediately and report the short failure reason. Do not keep waiting, do not loop retry commit, and do not start a new generation in the same execution turn. For COMMIT_IN_PROGRESS, say: 提交仍被后端任务占用，请稍后重试或重新开始分镜表生成。";

      return runAgent({
        key: "productionAgent:storyboardTableAgent",
        prompt,
        system: systemPrompt + addPrompt + storyboardTableRules + commitFailureRules,
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: productionSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt + addPrompt + storyboardTableRules + commitFailureRules },
        ],
        tools: { activate_skill: productionSkills.tools.activate_skill },
      });
    },
  });

  const run_sub_agent_supervision = tool({
    description: "运行监督层subAgent执行独立任务，完成后返回结果",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const systemPrompt = await readBuiltinSkill("production_agent_supervision.md");
      return runAgent({
        key: "productionAgent:supervisionAgent",
        prompt,
        system: systemPrompt,
        name: "监制",
        memoryKey: "assistant:supervision",
        messages: [
          { role: "assistant", content: productionSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt },
        ],
        tools: { activate_skill: productionSkills.tools.activate_skill },
      });
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

async function createArtSkills(artName: string, storyName: string) {
  const skillList = [];
  for (const dir of [
    ...skillDirCandidates("art_skills", artName, "driector_skills"),
    ...skillDirCandidates("story_skills", storyName, "driector_skills"),
  ]) {
    skillList.push(...(await scanSkills(dir + "/*.md")));
  }
  const mainSkills: { path: string; name: string; description: string }[] = [];
  const seenSkillNames = new Set<string>();
  for (const skillPath of skillList) {
    if (!fs.existsSync(skillPath)) throw new Error(`主技能文件不存在: ${skillPath}`);
    const content = await fs.promises.readFile(skillPath, "utf-8");
    const parsed = parseFrontmatter(content);
    if (seenSkillNames.has(parsed.name)) continue;
    seenSkillNames.add(parsed.name);
    mainSkills.push({ path: skillPath, ...parsed });
  }
  const res = {
    prompt: `## Skills
以下技能提供了专业任务的专用指令。
当任务与某个技能的描述匹配时，调用 activate_skill 工具并传入技能名称来加载完整指令。
${buildSkillPrompt(mainSkills)}`,
    tools: createSkillTools(mainSkills, { mainSkill: mainSkills, secondarySkills: [], tertiarySkills: [] }),
  };
  return res;
}
function removeAllXmlTags(text: string): string {
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "");
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "");
  text = text.replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "");
  return text.trim();
}

export function buildSkillPrompt(skills: { name: string; description: string }[]): string {
  const skillEntries = skills
    .map((s) => `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`)
    .join("\n");
  return `
<available_skills>
${skillEntries}
</available_skills>`;
}

async function useProductionSkills(artName: string, storyName: string) {
  const skillList = [];
  for (const dir of [
    ...skillDirCandidates("art_skills", artName, "driector_skills"),
    ...skillDirCandidates("story_skills", storyName, "driector_skills"),
    ...skillDirCandidates("production_skills"),
  ]) {
    skillList.push(...(await scanSkills(dir + "/*.md")));
  }
  const mainSkills: { path: string; name: string; description: string }[] = [];
  const seenSkillNames = new Set<string>();
  for (const skillPath of skillList) {
    if (!fs.existsSync(skillPath)) throw new Error(`主技能文件不存在: ${skillPath}`);
    const content = await fs.promises.readFile(skillPath, "utf-8");
    const parsed = parseFrontmatter(content);
    if (seenSkillNames.has(parsed.name)) continue;
    seenSkillNames.add(parsed.name);
    mainSkills.push({ path: skillPath, ...parsed });
  }
  const res = {
    prompt: `## Skills
以下技能提供了专业任务的专用指令。
当任务与某个技能的描述匹配时，调用 activate_skill 工具并传入技能名称来加载完整指令。
${buildSkillPrompt(mainSkills)}`,
    tools: createSkillTools(mainSkills, { mainSkill: mainSkills, secondarySkills: [], tertiarySkills: [] }),
  };
  return res;
}
