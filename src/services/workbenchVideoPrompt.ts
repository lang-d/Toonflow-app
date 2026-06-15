import fs from "node:fs/promises";
import path from "node:path";
import u from "@/utils";
import {
  resolveWorkbenchReferences,
  WorkbenchReferenceInput,
} from "@/services/workbenchReference";

interface GenerateVideoPromptInput {
  projectId: number;
  scriptId?: number;
  trackId?: number;
  references: WorkbenchReferenceInput[];
  model: string;
  mode: string;
  promptPrefix?: string;
  promptSuffix?: string;
}

function escapeAttribute(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function resolveSystemPrompt(vendorId: string, modelName: string, mode: string) {
  const configured = await u.db("o_modelPrompt").where("vendorId", vendorId).where("model", modelName).first();
  if (configured?.path) {
    try {
      return await fs.readFile(path.join(u.getPath(["modelPrompt"]), configured.path), "utf8");
    } catch {}
  }

  const modelLower = modelName.toLowerCase();
  let fileName: string | null = null;
  if (modelLower.includes("wan") && modelLower.includes("2.6")) {
    fileName = "wan2.6Single-imageFirstFrameMode.md";
  } else if (/seedance.*2[.\-]0/i.test(modelName)) {
    fileName = "seedance2Multi-parameterMode.md";
  } else if (["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(mode)) {
    fileName = "universalFirstAndLastFrameMode.md";
  } else if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
    fileName = "universalMulti-parameterMode.md";
  }
  if (fileName) {
    try {
      return await fs.readFile(path.join(u.getPath(["modelPrompt"]), "video", fileName), "utf8");
    } catch {}
  }

  const fallback = await u.db("o_prompt").where("type", "videoPromptGeneration").first();
  return fallback?.useData || fallback?.data || "";
}

function constraintBlock(prefix?: string, suffix?: string) {
  const cleanPrefix = prefix?.trim();
  const cleanSuffix = suffix?.trim();
  if (!cleanPrefix && !cleanSuffix) return "";
  return `
**全局生成约束**
${cleanPrefix ? `- 前置约束：${cleanPrefix}` : ""}
${cleanSuffix ? `- 后置约束：${cleanSuffix}` : ""}
这些内容只用于约束本次提示词生成，不要把它们逐字重复写入返回的轨道提示词正文。`;
}

export async function generateWorkbenchVideoPrompt(input: GenerateVideoPromptInput) {
  const [vendorId, modelName = ""] = input.model.split(/:(.+)/);
  const project = await u.db("o_project").where("id", input.projectId).first();
  if (!project) throw new Error("项目不存在");
  const system = await resolveSystemPrompt(vendorId, modelName, input.mode);
  const references = await resolveWorkbenchReferences(input.references, {
    projectId: input.projectId,
    scriptId: input.scriptId,
    trackId: input.trackId,
    requireFile: false,
  });
  const orderedReferenceText = references
    .map((item, index) => {
      if (item.sources === "storyboard") {
        return `${index + 1}. <storyboardItem
  source='storyboard'
  referenceId='${item.id}'
  videoDesc='${escapeAttribute(item.videoDesc)}'
  duration='${escapeAttribute(item.duration)}'
  shouldGenerateImage='${item.shouldGenerateImage ?? ""}'
  associateAssetsIds='${JSON.stringify(item.associateAssetsIds || [])}'
></storyboardItem>`;
      }
      const sourceType = item.sources === "merged" ? "merged" : item.category || item.fileType;
      return `${index + 1}. [${item.id}, ${sourceType}, ${item.name}]`;
    })
    .join("\n");
  const artStyle = project.artStyle || "无";
  const visualManual = u.getArtPrompt(artStyle, "art_skills", "art_storyboard_video");
  const content = `
**模型名称**：${modelName}
**模式**：${input.mode}
**引用顺序**（编号严格对应模型输入顺序，不得按类型重排）：
${orderedReferenceText}
${constraintBlock(input.promptPrefix, input.promptSuffix)}
`;
  const { text } = await u.Ai.Text("universalAi").invoke({
    system,
    messages: [
      { role: "assistant", content: `${visualManual}` },
      { role: "user", content },
    ],
  });
  return text;
}
