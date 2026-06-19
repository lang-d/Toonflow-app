import fs from "node:fs/promises";
import path from "node:path";
import u from "@/utils";
import { createLogger, writeDiagnosticFile } from "@/logger";
import { readBuiltinDataFile } from "@/services/builtinData";
import {
  resolveWorkbenchReferences,
  WorkbenchReferenceInput,
  ResolvedWorkbenchReference,
} from "@/services/workbenchReference";
import { inspectVideoPromptEngineering } from "@/services/videoPromptSafetyGuard";
import {
  assertStoryboardFactsReady,
  buildStoryboardVideoFact,
  StoryboardVideoFact,
  summarizeFactSources,
} from "@/services/storyboardFacts";

export interface CompileVideoPromptInput {
  projectId: number;
  scriptId?: number;
  trackId?: number;
  references: WorkbenchReferenceInput[];
  model: string;
  mode: string;
  promptPrefix?: string;
  promptSuffix?: string;
}

export interface CompileVideoPromptResult {
  text: string;
  systemPrompt: string;
  systemPromptSource: string;
  promptContext: string;
  engineeringIssues: ReturnType<typeof inspectVideoPromptEngineering>["issues"];
  diagnosticFile?: string;
  factSourceSummary: Record<string, number>;
  groupSummary: {
    storyboardCount: number;
    totalDuration: number;
    scene: string;
    groupKey?: string;
    groupName?: string;
    groupIntent?: string;
  };
}

export interface CompileVideoPromptOptions {
  taskId?: string | number;
  legacyTaskId?: number;
}

const promptLog = createLogger("video-prompt-compiler");

function escapeAttribute(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(value: unknown, max = 500) {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function resolveSystemPrompt(vendorId: string, modelName: string, mode: string) {
  const configured = await u.db("o_modelPrompt").where("vendorId", vendorId).where("model", modelName).first();
  if (configured?.path) {
    try {
      const file = path.join(u.getPath(["modelPrompt"]), configured.path);
      return { content: await fs.readFile(file, "utf8"), source: `o_modelPrompt:${configured.path}` };
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
    const builtin = await readBuiltinDataFile("modelPrompt", "video", fileName);
    if (builtin) return { content: builtin.content, source: builtin.file };
    try {
      const file = path.join(u.getPath(["modelPrompt"]), "video", fileName);
      return { content: await fs.readFile(file, "utf8"), source: file };
    } catch {}
  }

  const fallback = await u.db("o_prompt").where("type", "videoPromptGeneration").first();
  return { content: fallback?.useData || fallback?.data || "", source: "o_prompt:videoPromptGeneration" };
}

function constraintBlock(prefix?: string, suffix?: string) {
  const cleanPrefix = prefix?.trim();
  const cleanSuffix = suffix?.trim();
  if (!cleanPrefix && !cleanSuffix) return "";
  return `
**全局生成约束**
${cleanPrefix ? `- 前置约束：${cleanPrefix}` : ""}
${cleanSuffix ? `- 后置约束：${cleanSuffix}` : ""}
这些内容只用于约束本次视频提示词生成，不要逐字重复写入轨道提示词正文。`;
}

function referenceLine(item: ResolvedWorkbenchReference, index: number) {
  if (item.sources === "storyboard") {
    return `${index + 1}. <visualReference
  source='storyboard'
  referenceId='${item.id}'
  name='${escapeAttribute(item.name)}'
  fileType='${item.fileType}'
  note='该分镜图只作为视觉参考；完整分镜叙事以 trackId 查询到的分镜表事实为准'
></visualReference>`;
  }
  if (item.sources === "merged") {
    const sourceRefs = (item.sourceRefs || [])
      .map((ref) => `${ref.sources}:${ref.id}${ref.label ? `(${ref.label})` : ""}`)
      .join(", ");
    return `${index + 1}. <visualReference
  source='merged'
  referenceId='${item.id}'
  name='${escapeAttribute(item.name)}'
  fileType='${item.fileType}'
  sourceRefs='${escapeAttribute(sourceRefs)}'
  note='合图是视觉参考快照，不代表单个分镜，也不能替代轨道下的分镜表明细'
></visualReference>`;
  }
  const sourceType = item.category || item.fileType;
  return `${index + 1}. [${item.id}, ${sourceType}, ${item.name}, fileType=${item.fileType}]`;
}

function buildTrackFacts(track: any) {
  if (!track) return "";
  let groupPlan: any = null;
  try {
    groupPlan = track.groupPlanJson ? JSON.parse(track.groupPlanJson) : null;
  } catch {}
  const facts = [
    track.groupKey ? `- groupKey: ${track.groupKey}` : "",
    track.groupName ? `- groupName: ${track.groupName}` : "",
    track.groupIntent ? `- groupIntent: ${track.groupIntent}` : "",
    track.duration ? `- plannedDuration: ${track.duration}s` : "",
    groupPlan?.transition ? `- transition: ${groupPlan.transition}` : "",
    groupPlan?.pacing ? `- pacing: ${groupPlan.pacing}` : "",
  ].filter(Boolean);
  if (!facts.length) return "";
  return `
**分镜组既定事实**
${facts.join("\n")}
这些是分镜表阶段已经规划的事实。不要重新拆组，不要把下一场景镜头混入本组。`;
}

async function loadTrackStoryboards(input: CompileVideoPromptInput): Promise<StoryboardVideoFact[]> {
  if (!input.trackId) return [];
  const query = u
    .db("o_storyboard")
    .where({ trackId: input.trackId, projectId: input.projectId })
    .select(
      "id",
      "index",
      "duration",
      "videoDesc",
      "scene",
      "picture",
      "action",
      "shotSize",
      "cameraMove",
      "dialogue",
      "sound",
      "visibleEmotion",
      "location",
      "timeOfDay",
      "sceneContinuityId",
      "tableRowJson",
      "factStatus",
      "factVersion",
      "groupKey",
      "groupName",
      "groupIntent",
      "beatId",
      "shouldGenerateImage",
    )
    .orderBy("index", "asc")
    .orderBy("id", "asc");
  if (input.scriptId != null) query.where("scriptId", input.scriptId);
  const rows = await query;
  if (!rows.length) return [];

  const ids = rows.map((row: any) => Number(row.id));
  const assetRows = ids.length
    ? await u.db("o_assets2Storyboard").whereIn("storyboardId", ids).orderBy("rowid").select("storyboardId", "assetId")
    : [];
  const assetMap = new Map<number, number[]>();
  for (const row of assetRows as any[]) {
    const storyboardId = Number(row.storyboardId);
    if (!assetMap.has(storyboardId)) assetMap.set(storyboardId, []);
    assetMap.get(storyboardId)!.push(Number(row.assetId));
  }
  return rows.map((row: any) => buildStoryboardVideoFact(row, assetMap.get(Number(row.id)) || []));
}

function storyboardLine(item: StoryboardVideoFact, index: number) {
  return `${index + 1}. <trackStoryboard
  storyboardId='${item.storyboardId}'
  displayIndex='${escapeAttribute(item.displayIndex)}'
  factSource='${item.factSource}'
  duration='${escapeAttribute(item.duration)}'
  location='${escapeAttribute(item.location)}'
  timeOfDay='${escapeAttribute(item.timeOfDay)}'
  groupKey='${escapeAttribute(item.groupKey)}'
  groupName='${escapeAttribute(item.groupName)}'
  groupIntent='${escapeAttribute(item.groupIntent)}'
  beatId='${escapeAttribute(item.beatId)}'
  scene='${escapeAttribute(item.scene)}'
  picture='${escapeAttribute(item.picture)}'
  action='${escapeAttribute(item.action)}'
  shotSize='${escapeAttribute(item.shotSize)}'
  cameraMove='${escapeAttribute(item.cameraMove)}'
  dialogue='${escapeAttribute(item.dialogue)}'
  sound='${escapeAttribute(item.sound)}'
  visibleEmotion='${escapeAttribute(item.visibleEmotion)}'
  characters='${escapeAttribute(JSON.stringify(item.tableRow?.characters || []))}'
  requiredAssets='${escapeAttribute(JSON.stringify(item.tableRow?.requiredAssets || []))}'
  shouldGenerateImage='${item.shouldGenerateImage ?? ""}'
  associateAssetsIds='${JSON.stringify(item.associateAssetsIds)}'
></trackStoryboard>`;
}

function mostCommon(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function buildGroupSummary(storyboards: StoryboardVideoFact[], track: any) {
  const totalDuration = storyboards.reduce((sum, item) => {
    const duration = Number(item.duration);
    return sum + (Number.isFinite(duration) ? duration : 0);
  }, 0);
  return {
    storyboardCount: storyboards.length,
    totalDuration,
    scene: mostCommon(storyboards.map((item) => item.scene)),
    groupKey: track?.groupKey || storyboards.find((item) => item.groupKey)?.groupKey,
    groupName: track?.groupName || storyboards.find((item) => item.groupName)?.groupName,
    groupIntent: track?.groupIntent || storyboards.find((item) => item.groupIntent)?.groupIntent,
  };
}

function buildStoryboardFacts(storyboards: StoryboardVideoFact[], track: any) {
  if (!storyboards.length) {
    return `
**分镜组完整明细**
- 当前轨道未查询到分镜表明细。若引用区包含 storyboard，可使用引用区的视觉参考；否则不得臆造分镜数量。`;
  }
  const summary = buildGroupSummary(storyboards, track);
  const sourceSummary = summarizeFactSources(storyboards);
  const actionChain = storyboards
    .map((item) => item.action || item.picture)
    .filter(Boolean)
    .map((item) => truncate(item, 80))
    .join(" -> ");
  return `
**分镜表事实摘要**
- storyboardCount: ${summary.storyboardCount}
- totalDuration: ${summary.totalDuration || "未指定"}s
- groupKey: ${summary.groupKey || "未指定"}
- groupName: ${summary.groupName || "未指定"}
- groupIntent: ${summary.groupIntent || "未指定"}
- scene: ${summary.scene || "未指定"}
- factSources: storyboardTable=${sourceSummary.storyboardTable}, minimalFallback=${sourceSummary.minimalFallback}
- actionContinuity: ${actionChain || "未指定"}

**分镜组完整明细（以 trackId 查询结果为准）**
- 必须按下面 ${storyboards.length} 个分镜逐条生成视频提示词，不得把合图、资产图或任意单张参考图当作唯一分镜。
- 分镜图/合图只用于约束人物外观、场景空间、构图、光线和色彩；动作、台词、音效、节奏以分镜表事实为准。
- visibleEmotion 只能作为表演线索，不能原样写成抽象情绪词。请转写为可见动作、面部表情、呼吸、步伐、手部动作或台词语气。
${storyboards.map(storyboardLine).join("\n")}`;
}

function buildGenerationConstraints() {
  return `
**生成阶段质量约束**
- 保留模型专属 Prompt 的详细格式和引用编号规则。
- 分镜表事实是视频提示词主输入；分镜面板 prompt / imagePrompt 不作为视频主上下文。
- 不创造新剧情，不自行改写场景时间、光影、色调、人物关系。
- 有分镜图、合图或参考图时，沿用参考图中的环境、光线、色彩、人物外观、构图；不要强写与参考图冲突的站位和朝向。
- 无参考图时，只能使用导演规划或分镜表中的最小必要场景事实。
- 情绪必须尽量写成可见动作、眼神、呼吸、姿态、手部动作、步伐节奏或台词语气，避免只写“坚定、决绝、压迫、警惕”等抽象词。
- 画内音效可以进入视频提示词，例如脚步声、广播声、衣料摩擦声、呼吸声、环境声、动作声。
- BGM、配乐、OST、非画内音乐只属于后期建议，不得写入视频提示词。
- 不要加入图片生成用画质堆叠词，例如“极致细节、发丝根根分明、面容细腻渲染、纹理细节超清晰、强对比度与极致细节”。
- 生成阶段只输出视频提示词正文，不输出审校建议、分析过程或修订说明；审校建议由后续 reviewer 负责。`;
}

function buildVideoStyleGuide(project: any) {
  const style = String(project?.artStyle || "").trim();
  return `
**视频视觉风格约束**
- 项目风格标识：${style || "未指定"}。
- 用一句短语描述媒介和类型即可，优先写“都市写实摄影 / 真人实拍质感 / 现代都市纪实”等必要风格。
- 视觉细节以参考图为准，不要复制图片提示词里的画质堆叠词。`;
}

export async function compileWorkbenchVideoPrompt(
  input: CompileVideoPromptInput,
  options: CompileVideoPromptOptions = {},
): Promise<CompileVideoPromptResult> {
  const [vendorId, modelName = ""] = input.model.split(/:(.+)/);
  const project = await u.db("o_project").where("id", input.projectId).first();
  if (!project) throw new Error("项目不存在");

  const track = input.trackId ? await u.db("o_videoTrack").where({ id: input.trackId, projectId: input.projectId }).first() : null;
  const system = await resolveSystemPrompt(vendorId, modelName, input.mode);
  const trackStoryboards = await loadTrackStoryboards(input);
  assertStoryboardFactsReady(trackStoryboards);
  const referenceInputs = input.references || [];
  const references = await resolveWorkbenchReferences(referenceInputs, {
    projectId: input.projectId,
    scriptId: input.scriptId,
    trackId: input.trackId,
    requireFile: false,
  });

  const orderedReferenceText = references.map(referenceLine).join("\n");
  const promptContext = `
**模型名称**：${modelName}
**模式**：${input.mode}
**引用顺序**（编号严格对应模型输入顺序，不得按类型重排）：${orderedReferenceText}
${buildTrackFacts(track)}
${buildStoryboardFacts(trackStoryboards, track)}
${constraintBlock(input.promptPrefix, input.promptSuffix)}
${buildGenerationConstraints()}
`;

  const groupSummary = buildGroupSummary(trackStoryboards, track);
  const factSourceSummary = summarizeFactSources(trackStoryboards);
  const diagnosticBase = {
    taskId: options.taskId,
    legacyTaskId: options.legacyTaskId,
    projectId: input.projectId,
    scriptId: input.scriptId,
    trackId: input.trackId,
    model: input.model,
    mode: input.mode,
    systemPromptSource: system.source,
    references: referenceInputs,
    resolvedReferences: references.map((item, index) => ({
      order: index + 1,
      id: item.id,
      sources: item.sources,
      fileType: item.fileType,
      name: item.name,
      sourceRefs: item.sourceRefs,
    })),
    storyboardCount: trackStoryboards.length,
    factSourceSummary,
    groupSummary,
  };
  let text = "";
  try {
    const result = await u.Ai.Text("universalAi").invoke({
      system: system.content,
      messages: [
        { role: "assistant", content: buildVideoStyleGuide(project) },
        { role: "user", content: promptContext },
      ],
    });
    text = result.text;
  } catch (error) {
    const diagnosticFile = writeDiagnosticFile(
      `video-prompt-failed-track-${input.trackId || "unknown"}`,
      JSON.stringify({ ...diagnosticBase, promptContext, systemPrompt: system.content, error: u.error(error).message }, null, 2),
      { provider: "prompt", taskId: options.taskId, projectId: input.projectId, scriptId: input.scriptId, model: input.model },
    );
    promptLog.error("Video prompt generation failed", {
      event: "video-prompt.failed",
      taskId: options.taskId,
      projectId: input.projectId,
      scriptId: input.scriptId,
      businessId: input.trackId,
      model: input.model,
      diagnosticFile,
      error,
    });
    throw error;
  }
  const inspection = inspectVideoPromptEngineering(text);
  const diagnosticFile = writeDiagnosticFile(
    `video-prompt-track-${input.trackId || "unknown"}`,
    JSON.stringify(
      {
        ...diagnosticBase,
        promptContext,
        systemPrompt: system.content,
        aiOutputSummary: text.slice(0, 4000),
        aiOutputLength: text.length,
        engineeringIssues: inspection.issues,
      },
      null,
      2,
    ),
    { provider: "prompt", taskId: options.taskId, projectId: input.projectId, scriptId: input.scriptId, model: input.model },
  );
  promptLog.info("Video prompt diagnostic captured", {
    event: "video-prompt.diagnostic",
    taskId: options.taskId,
    projectId: input.projectId,
    scriptId: input.scriptId,
    businessId: input.trackId,
    model: input.model,
    storyboardCount: trackStoryboards.length,
    referenceCount: references.length,
    systemPromptSource: system.source,
    diagnosticFile,
  });
  if (inspection.issues.some((issue) => issue.severity === "blocking")) {
    throw new Error(inspection.issues.find((issue) => issue.severity === "blocking")?.message || "视频提示词生成失败");
  }
  return {
    text: text.trim(),
    systemPrompt: system.content,
    systemPromptSource: system.source,
    promptContext,
    engineeringIssues: inspection.issues,
    diagnosticFile,
    factSourceSummary,
    groupSummary,
  };
}
