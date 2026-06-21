import { Socket } from "socket.io";
import fs from "fs";
import path from "path";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import ResTool from "@/socket/resTool";
import useStoryTools from "@/agents/storyAgent/tools";
import { useStorySkills } from "@/agents/storyAgent/skills";
import {
  consumeFullStream as consumeAgentFullStream,
  createAgentModelStreamScope,
} from "@/agents/shared/streaming";

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  text: string;
  artifactId?: number;
  includeOpenAnnotations?: boolean;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  thinkConfig: {
    think: boolean;
    thinlLevel: 0 | 1 | 2 | 3;
  };
}

function fallbackPrompt() {
  return `You are Toonflow Story Agent.
Help the user develop ideas, story bibles, outlines, scripts, and revisions.
The main interaction is chat. When you produce an official story document, call create_artifact.
When the user asks to revise according to annotations, first read the artifact and open annotations, then call revise_artifact_with_annotations with the complete revised text.
Only call publish_artifact_to_script after explicit user confirmation.
Respond in the user's language.`;
}

async function readDecisionPrompt() {
  const candidates = [path.join(u.getPath("skills"), "story_agent_decision.md"), path.resolve("data", "skills", "story_agent_decision.md")];
  for (const filePath of candidates) {
    try {
      return await fs.promises.readFile(filePath, "utf8");
    } catch {
      // Try the next bundled/runtime location before falling back to the built-in prompt.
    }
  }
  return fallbackPrompt();
}

function buildMemPrompt(mem: Awaited<ReturnType<Memory["get"]>>): string {
  const parts: string[] = [];
  if (mem.rag.length) parts.push(`[Relevant memory]\n${mem.rag.map((r) => r.content).join("\n")}`);
  if (mem.summaries.length) parts.push(`[History summaries]\n${mem.summaries.map((s, i) => `${i + 1}. ${s.content}`).join("\n")}`);
  if (mem.shortTerm.length) parts.push(`[Recent chat]\n${mem.shortTerm.map((m) => `${m.role}: ${m.content}`).join("\n")}`);
  return parts.length ? `## Memory\n${parts.join("\n\n")}` : "";
}

async function buildArtifactContext(projectId: number, artifactId?: number, includeOpenAnnotations?: boolean) {
  if (!artifactId) return "";
  const artifact = await u.db("o_storyArtifact").where({ id: artifactId, projectId }).first();
  if (!artifact) return "";
  const annotations = includeOpenAnnotations
    ? await u.db("o_storyAnnotation").where({ artifactId, projectId, status: "open" }).orderBy("createTime", "asc")
    : [];
  return [
    "## Current Artifact",
    `id: ${artifact.id}`,
    `type: ${artifact.type}`,
    `title: ${artifact.title}`,
    `version: ${artifact.version}`,
    artifact.content || "",
    annotations.length
      ? `\n## Open User Annotations\n${annotations
          .map((item: any, index: number) =>
            [
              `${index + 1}. id=${item.id}`,
              `selectedText: ${item.selectedText || ""}`,
              `comment: ${item.comment || ""}`,
              item.blockId ? `blockId: ${item.blockId}` : "",
              item.startOffset != null || item.endOffset != null ? `range: ${item.startOffset ?? ""}-${item.endOffset ?? ""}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          )
          .join("\n\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runDecisionAI(ctx: AgentContext) {
  const { isolationKey, text, userMessageTime, abortSignal, resTool } = ctx;
  const projectId = Number(resTool.data.projectId);
  const memory = new Memory("storyAgent", isolationKey);
  await memory.add("user", text, { createTime: userMessageTime });

  const [prompt, mem, project, storySkills, artifactContext] = await Promise.all([
    readDecisionPrompt(),
    memory.get(text),
    u.db("o_project").where("id", projectId).first(),
    useStorySkills(),
    buildArtifactContext(projectId, ctx.artifactId, ctx.includeOpenAnnotations),
  ]);

  const projectInfo = [
    "## Project",
    `id: ${projectId}`,
    `name: ${project?.name ?? "unknown"}`,
    `type: ${project?.type ?? "unknown"}`,
    `intro: ${project?.intro ?? ""}`,
    `artStyle: ${project?.artStyle ?? ""}`,
  ].join("\n");

  const modelStreamScope = createAgentModelStreamScope(abortSignal);
  try {
    const { fullStream } = await u.Ai.Text("storyAgent:decisionAgent", ctx.thinkConfig.think, ctx.thinkConfig.thinlLevel).stream({
      messages: [
        { role: "system", content: `${prompt}\n\n${storySkills.prompt}` },
        { role: "assistant", content: [projectInfo, buildMemPrompt(mem), artifactContext].filter(Boolean).join("\n\n") },
        { role: "user", content: text },
      ],
      abortSignal: modelStreamScope.signal,
      tools: {
        ...memory.getTools(),
        ...storySkills.tools,
        ...useStoryTools(projectId),
      },
      onFinish: async (completion) => {
        await memory.add("assistant:decision", removeAllXmlTags(completion.text));
      },
    });

    await consumeAgentFullStream({
      agentName: "storyAgent:decisionAgent",
      fullStream,
      initialMsg: ctx.msg,
      userAbortSignal: abortSignal,
      abortModelStream: modelStreamScope.abort,
      projectId,
    });
  } finally {
    modelStreamScope.dispose();
  }
}

function removeAllXmlTags(text: string): string {
  return text
    .replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "")
    .replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "")
    .replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "")
    .trim();
}
