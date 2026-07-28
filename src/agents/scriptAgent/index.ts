import { Socket } from "socket.io";
import { jsonSchema, tool } from "ai";
import { z } from "zod";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import useTools from "@/agents/scriptAgent/tools";
import ResTool from "@/socket/resTool";
import { recordAgentModelStreamFinished, type AgentRunContext } from "@/services/agentRun";
import { readConfiguredSkill } from "@/services/skillResolver";
import { consumeFullStream as consumeAgentFullStream, createAgentModelStreamScope } from "@/agents/shared/streaming";
import { SCRIPT_SUB_AGENT_TOOL_NAMES } from "@/agents/scriptAgent/toolPolicy";

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  text: string;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  thinkConfig: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 };
  runContext?: AgentRunContext | null;
}

function buildMemPrompt(mem: Awaited<ReturnType<Memory["get"]>>) {
  const sections: string[] = [];
  if (mem.rag.length) sections.push(`[相关记忆]\n${mem.rag.map((row) => row.content).join("\n")}`);
  if (mem.summaries.length) sections.push(`[历史摘要]\n${mem.summaries.map((row, index) => `${index + 1}. ${row.content}`).join("\n")}`);
  if (mem.shortTerm.length) sections.push(`[近期对话]\n${mem.shortTerm.map((row) => `${row.role}: ${row.content}`).join("\n")}`);
  return `## Memory\n以下内容仅用于对话连续性，不是项目事实来源。涉及小说、工作台、剧本或审核时必须调用数据工具确认。\n${sections.join("\n\n")}`;
}

export async function runDecisionAI(ctx: AgentContext) {
  const memory = new Memory("scriptAgent", ctx.isolationKey);
  await memory.add("user", ctx.text, { createTime: ctx.userMessageTime });

  const systemPrompt = (await readConfiguredSkill("script_agent_decision.md")).content;
  const memoryPrompt = buildMemPrompt(await memory.get(ctx.text));
  const modelStreamScope = createAgentModelStreamScope(ctx.abortSignal);

  try {
    const { fullStream } = await u.Ai.Text("scriptAgent:decisionAgent", ctx.thinkConfig.think, ctx.thinkConfig.thinlLevel).stream({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "assistant", content: memoryPrompt },
        { role: "user", content: ctx.text },
      ],
      abortSignal: modelStreamScope.signal,
      tools: {
        ...memory.getTools(),
        ...useTools({ resTool: ctx.resTool, runContext: ctx.runContext }),
        ...createSubAgents(ctx),
      },
      onFinish: async (completion) => {
        if (ctx.runContext) {
          await recordAgentModelStreamFinished(ctx.runContext.runId, completion).catch((error) => {
            console.warn("[scriptAgent] failed to record model stream completion:", u.error(error).message);
          });
        }
        if (completion.text.trim()) {
          await memory.add("assistant:decision", completion.text, { createTime: new Date(ctx.msg.datetime).getTime() });
        }
      },
    });

    let currentMsg = ctx.msg;
    await consumeAgentFullStream({
      agentName: "scriptAgent:decisionAgent",
      fullStream,
      initialMsg: currentMsg,
      userAbortSignal: ctx.abortSignal,
      abortModelStream: modelStreamScope.abort,
      projectId: Number(ctx.resTool.data.projectId),
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

function createSubAgents(parentCtx: AgentContext) {
  const memory = new Memory("scriptAgent", parentCtx.isolationKey);

  async function runAgent(input: {
    key: `${string}:${string}`;
    prompt: string;
    skillFile: string;
    name: string;
    memoryKey: string;
    toolNames: string[];
  }) {
    parentCtx.msg.complete();
    const subMsg = parentCtx.resTool.newMessage("assistant", input.name);
    const system = (await readConfiguredSkill(input.skillFile)).content;
    const modelStreamScope = createAgentModelStreamScope(parentCtx.abortSignal);

    let fullResponse = "";
    try {
      const { fullStream } = await u.Ai.Text(input.key, parentCtx.thinkConfig.think, parentCtx.thinkConfig.thinlLevel).stream({
        system,
        messages: [{ role: "user", content: input.prompt }],
        abortSignal: modelStreamScope.signal,
        tools: useTools({ resTool: parentCtx.resTool, runContext: parentCtx.runContext, toolsNames: input.toolNames }),
      });
      fullResponse = await consumeAgentFullStream({
        agentName: input.key,
        fullStream,
        initialMsg: subMsg,
        userAbortSignal: parentCtx.abortSignal,
        abortModelStream: modelStreamScope.abort,
        projectId: Number(parentCtx.resTool.data.projectId),
      });
    } finally {
      modelStreamScope.dispose();
    }

    if (fullResponse.trim()) {
      await memory.add(input.memoryKey, fullResponse, { name: input.name, createTime: new Date(subMsg.datetime).getTime() });
    }
    parentCtx.msg = parentCtx.resTool.newMessage("assistant", "剧本策划");
    return fullResponse;
  }

  const inputSchema = jsonSchema<{ prompt: string }>(z.object({ prompt: z.string().min(1) }).toJSONSchema());

  return {
    run_sub_agent_storySkeleton: tool({
      description: "Run the story-skeleton specialist. It reads current facts and saves a complete skeleton with its backend tool.",
      inputSchema,
      execute: async ({ prompt }) =>
        runAgent({
          key: "scriptAgent:storySkeletonAgent",
          prompt,
          skillFile: "script_execution_skeleton.md",
          name: "编剧",
          memoryKey: "assistant:execution:storySkeleton",
          toolNames: [...SCRIPT_SUB_AGENT_TOOL_NAMES.storySkeleton],
        }),
    }),
    run_sub_agent_adaptationStrategy: tool({
      description: "Run the adaptation-strategy specialist. It reads current facts and saves a complete strategy with its backend tool.",
      inputSchema,
      execute: async ({ prompt }) =>
        runAgent({
          key: "scriptAgent:adaptationStrategyAgent",
          prompt,
          skillFile: "script_execution_adaptation.md",
          name: "编剧",
          memoryKey: "assistant:execution:adaptationStrategy",
          toolNames: [...SCRIPT_SUB_AGENT_TOOL_NAMES.adaptationStrategy],
        }),
    }),
    run_sub_agent_script: tool({
      description: "Run the script-writing specialist. It reads the selected source facts and saves each complete script with backend tools.",
      inputSchema,
      execute: async ({ prompt }) =>
        runAgent({
          key: "scriptAgent:scriptAgent",
          prompt,
          skillFile: "script_execution_script.md",
          name: "编剧",
          memoryKey: "assistant:execution:script",
          toolNames: [...SCRIPT_SUB_AGENT_TOOL_NAMES.script],
        }),
    }),
    run_supervision_agent: tool({
      description: "Run the read-only script supervision specialist. It records review text and may await a user decision.",
      inputSchema,
      execute: async ({ prompt }) =>
        runAgent({
          key: "scriptAgent:supervisionAgent",
          prompt,
          skillFile: "script_agent_supervision.md",
          name: "编剧监督",
          memoryKey: "assistant:supervision",
          toolNames: [...SCRIPT_SUB_AGENT_TOOL_NAMES.supervision],
        }),
    }),
  };
}
