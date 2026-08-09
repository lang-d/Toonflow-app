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
import { getCommittedDirectorPlanVideoStyle } from "@/services/directorPlanGeneration";

export interface CompileVideoPromptInput {
  projectId: number;
  scriptId?: number;
  trackId?: number;
  references: WorkbenchReferenceInput[];
  model: string;
  mode: string;
  promptPrefix?: string;
  promptSuffix?: string;
  videoPromptType?: string | null;
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
  promptProfile: {
    model: string;
    modelId: string | null;
    videoPromptType: string | null;
    systemPromptSource: string;
  };
}

export interface CompileVideoPromptOptions {
  taskId?: string | number;
  legacyTaskId?: number;
}

const promptLog = createLogger("video-prompt-compiler");

interface PromptReferenceMeta {
  inputOrder: number;
  visualImageIndex?: number;
  audioReferenceIndex?: number;
  videoReferenceIndex?: number;
}

interface AnnotatedPromptReference {
  item: ResolvedWorkbenchReference;
  meta: PromptReferenceMeta;
}

type ReferenceDialect = "atImage" | "h3";

interface ReferenceTokenContractIssue {
  issueType: "unexpected_image_token" | "missing_image_token" | "unexpected_reference_label" | "missing_reference_label";
  severity: "blocking" | "warning";
  message: string;
  token: string;
}

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

interface VideoPromptProfileDefinition {
  path: string;
  referenceDialect: ReferenceDialect;
  contentProfiles: Map<string, VideoPromptContentProfile>;
}

interface VideoPromptProfileMap {
  entries: Map<string, VideoPromptProfileDefinition>;
  source: string;
}

export interface VideoPromptContentProfile {
  id: string;
  label: string;
  path: string;
}

export interface VideoPromptTypeCapability {
  options: Array<{ value: string; label: string }>;
  defaultValue?: string;
}

export interface VideoPromptTypeResolution {
  model: string;
  modelId: string | null;
  videoPromptType: string | null;
}

const VIDEO_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const VIDEO_PROFILE_PATH_PATTERN = /^video\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseVideoPromptProfileMap(content: string, source = "profileMap.json"): VideoPromptProfileMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Video prompt profile map is not valid JSON: ${source}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Video prompt profile map must be an array: ${source}`);

  const entries = new Map<string, VideoPromptProfileDefinition>();
  for (const value of parsed) {
    if (!isRecord(value) || typeof value.modelId !== "string" || typeof value.path !== "string") {
      throw new Error(`Video prompt profile map has an invalid entry: ${source}`);
    }
    const modelId = value.modelId.trim();
    const profilePath = value.path.trim().replace(/\\/g, "/");
    const referenceDialect = value.referenceDialect == null ? "atImage" : value.referenceDialect;
    if (!VIDEO_PROFILE_ID_PATTERN.test(modelId)) {
      throw new Error(`Video prompt profile map has an invalid model ID '${modelId}': ${source}`);
    }
    if (!VIDEO_PROFILE_PATH_PATTERN.test(profilePath)) {
      throw new Error(`Video prompt profile map has an unsafe profile path '${profilePath}': ${source}`);
    }
    if (referenceDialect !== "atImage" && referenceDialect !== "h3") {
      throw new Error(`Video prompt profile map has an invalid reference dialect '${String(referenceDialect)}': ${source}`);
    }
    const contentProfiles = new Map<string, VideoPromptContentProfile>();
    if (value.contentProfiles != null && !Array.isArray(value.contentProfiles)) {
      throw new Error(`Video prompt profile map has invalid content profiles for '${modelId}': ${source}`);
    }
    for (const profile of value.contentProfiles || []) {
      if (!isRecord(profile) || typeof profile.id !== "string" || typeof profile.label !== "string" || typeof profile.path !== "string") {
        throw new Error(`Video prompt profile map has an invalid content profile for '${modelId}': ${source}`);
      }
      const id = profile.id.trim();
      const label = profile.label.trim();
      const contentPath = profile.path.trim().replace(/\\/g, "/");
      if (!VIDEO_PROFILE_ID_PATTERN.test(id) || !label || !VIDEO_PROFILE_PATH_PATTERN.test(contentPath)) {
        throw new Error(`Video prompt profile map has an invalid content profile '${id}': ${source}`);
      }
      if (contentProfiles.has(id)) throw new Error(`Video prompt profile map has duplicate content profile '${id}': ${source}`);
      contentProfiles.set(id, { id, label, path: contentPath });
    }
    if (entries.has(modelId)) throw new Error(`Video prompt profile map has duplicate model ID '${modelId}': ${source}`);
    entries.set(modelId, { path: profilePath, referenceDialect, contentProfiles });
  }
  return { entries, source };
}

export function resolveVideoPromptProfilePath(profileMap: VideoPromptProfileMap, modelId: unknown) {
  if (typeof modelId !== "string") return null;
  const normalized = modelId.trim();
  if (!VIDEO_PROFILE_ID_PATTERN.test(normalized)) return null;
  return profileMap.entries.get(normalized)?.path || null;
}

function resolveVideoPromptProfileDefinition(profileMap: VideoPromptProfileMap, modelId: unknown) {
  if (typeof modelId !== "string") return null;
  const normalized = modelId.trim();
  if (!VIDEO_PROFILE_ID_PATTERN.test(normalized)) return null;
  return profileMap.entries.get(normalized) || null;
}

export function resolveVideoPromptContentProfiles(profileMap: VideoPromptProfileMap, modelId: unknown): VideoPromptContentProfile[] {
  const definition = resolveVideoPromptProfileDefinition(profileMap, modelId);
  return definition ? [...definition.contentProfiles.values()] : [];
}

export function resolveVideoPromptContentProfile(
  profileMap: VideoPromptProfileMap,
  modelId: unknown,
  contentProfileId: unknown,
): VideoPromptContentProfile | null {
  if (typeof contentProfileId !== "string") return null;
  const id = contentProfileId.trim();
  if (!VIDEO_PROFILE_ID_PATTERN.test(id)) return null;
  return resolveVideoPromptProfileDefinition(profileMap, modelId)?.contentProfiles.get(id) || null;
}

export function isKnownVideoPromptContentProfile(profileMap: VideoPromptProfileMap, contentProfileId: unknown) {
  if (typeof contentProfileId !== "string") return false;
  const id = contentProfileId.trim();
  if (!VIDEO_PROFILE_ID_PATTERN.test(id)) return false;
  return [...profileMap.entries.values()].some((definition) => definition.contentProfiles.has(id));
}

async function readVideoPromptProfileMap(): Promise<VideoPromptProfileMap> {
  const builtin = await readBuiltinDataFile("modelPrompt", "video", "profileMap.json");
  if (builtin) return parseVideoPromptProfileMap(builtin.content, builtin.file);
  const file = path.join(u.getPath(["modelPrompt"]), "video", "profileMap.json");
  return parseVideoPromptProfileMap(await fs.readFile(file, "utf8"), file);
}

async function readVideoPromptProfile(profilePath: string) {
  const parts = profilePath.split("/");
  const builtin = await readBuiltinDataFile("modelPrompt", ...parts);
  if (builtin) return { content: builtin.content, source: builtin.file };
  const root = path.resolve(u.getPath(["modelPrompt"]));
  const file = path.resolve(root, ...parts);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) return null;
  try {
    return { content: await fs.readFile(file, "utf8"), source: file };
  } catch {
    return null;
  }
}

function parseVideoModelKey(model: unknown) {
  const [vendorId = "", modelName = ""] = String(model || "").split(/:(.+)/);
  return { vendorId: vendorId.trim(), modelName: modelName.trim() };
}

async function resolveVideoPromptModel(model: unknown, strict = false) {
  const { vendorId, modelName } = parseVideoModelKey(model);
  const fail = (message: string) => {
    if (strict) throw new Error(message);
    return null;
  };
  if (!vendorId || !modelName) return fail("视频模型必须为 vendorId:modelName");
  try {
    const runtime = u.vendor.getRuntime(vendorId) as { resolveVideoPromptModelId?: (model: unknown) => unknown };
    const videoModel = (await u.vendor.getModelList(vendorId)).find((item: any) => item?.type === "video" && item.modelName === modelName);
    if (!videoModel) return fail("未找到视频模型");
    if (typeof runtime.resolveVideoPromptModelId !== "function") {
      return { vendorId, modelName, videoModel, modelId: null, profileDefinition: null };
    }
    const resolvedModelId = runtime.resolveVideoPromptModelId(videoModel);
    const modelId = typeof resolvedModelId === "string" && VIDEO_PROFILE_ID_PATTERN.test(resolvedModelId.trim())
      ? resolvedModelId.trim()
      : null;
    const profileDefinition = modelId ? resolveVideoPromptProfileDefinition(await readVideoPromptProfileMap(), modelId) : null;
    return { vendorId, modelName, videoModel, modelId, profileDefinition };
  } catch (error) {
    if (strict) throw error;
    promptLog.warn("Video prompt model resolver failed", { model: String(model || ""), error: u.error(error).message });
    return null;
  }
}

export async function getVideoPromptTypeCapabilityForModel(model: string): Promise<VideoPromptTypeCapability | null> {
  const resolved = await resolveVideoPromptModel(model);
  const profiles = resolved?.profileDefinition ? [...resolved.profileDefinition.contentProfiles.values()] : [];
  if (!profiles.length) return null;
  return { options: profiles.map(({ id, label }) => ({ value: id, label })) };
}

export async function assertVideoPromptTypeForModel(model: string, requestedVideoPromptType?: string | null): Promise<VideoPromptTypeResolution> {
  const resolved = await resolveVideoPromptModel(model, true);
  if (!resolved) throw new Error("未找到视频模型");
  const value = typeof requestedVideoPromptType === "string" ? requestedVideoPromptType.trim() : "";
  if (!value) return { model, modelId: resolved.modelId, videoPromptType: null };
  if (!VIDEO_PROFILE_ID_PATTERN.test(value)) throw new Error("视频类型参数非法");
  const contentProfile = resolved.profileDefinition?.contentProfiles.get(value);
  if (!contentProfile) throw new Error("当前视频模型不支持该视频类型");
  return { model, modelId: resolved.modelId, videoPromptType: contentProfile.id };
}

async function resolveVendorVideoPromptProfile(vendorId: string, modelName: string, requestedContentProfileId?: string | null) {
  try {
    const resolved = await resolveVideoPromptModel(`${vendorId}:${modelName}`);
    if (!resolved) return null;
    const { modelId, profileDefinition } = resolved;
    if (!profileDefinition) {
      if (modelId != null) promptLog.warn("Video prompt model ID has no mapped profile", { vendorId, modelName, modelId });
      return null;
    }
    const profile = await readVideoPromptProfile(profileDefinition.path);
    if (!profile) {
      promptLog.warn("Mapped video prompt profile is unavailable", { vendorId, modelName, modelId, profilePath: profileDefinition.path });
      return null;
    }
    const normalizedContentProfileId = typeof requestedContentProfileId === "string" ? requestedContentProfileId.trim() : "";
    const contentProfile = normalizedContentProfileId && VIDEO_PROFILE_ID_PATTERN.test(normalizedContentProfileId)
      ? profileDefinition.contentProfiles.get(normalizedContentProfileId) || null
      : null;
    if (!contentProfile && requestedContentProfileId) {
      promptLog.warn("Project video prompt type is unavailable for the resolved model", {
        vendorId,
        modelName,
        modelId,
        videoPromptType: requestedContentProfileId,
      });
    }
    const contentRule = contentProfile ? await readVideoPromptProfile(contentProfile.path) : null;
    if (contentProfile && !contentRule) {
      promptLog.warn("Mapped video prompt content profile is unavailable", {
        vendorId,
        modelName,
        modelId,
        videoPromptType: contentProfile.id,
        profilePath: contentProfile.path,
      });
    }
    return {
      ...profile,
      content: contentRule ? `${profile.content}\n\n${contentRule.content}` : profile.content,
      referenceDialect: profileDefinition.referenceDialect,
      source: `vendor:${vendorId}:${String(modelId)} -> ${profile.source}${contentRule ? ` + ${contentRule.source}` : ""}`,
      modelId: String(modelId),
      videoPromptType: contentRule ? contentProfile?.id || null : null,
    };
  } catch (error) {
    promptLog.warn("Video prompt model ID resolver failed", { vendorId, modelName, error: u.error(error).message });
    return null;
  }
}

export async function getVideoPromptContentProfilesForModel(model: string): Promise<VideoPromptContentProfile[]> {
  const resolved = await resolveVideoPromptModel(model);
  return resolved?.profileDefinition ? [...resolved.profileDefinition.contentProfiles.values()] : [];
}

async function resolveSystemPrompt(vendorId: string, modelName: string, mode: string, videoPromptType?: string | null) {
  if (videoPromptType) {
    const vendorProfile = await resolveVendorVideoPromptProfile(vendorId, modelName, videoPromptType);
    if (!vendorProfile || vendorProfile.videoPromptType !== videoPromptType) {
      throw new Error("当前视频模型不支持该视频类型");
    }
    return vendorProfile;
  }
  const configured = await u.db("o_modelPrompt").where("vendorId", vendorId).where("model", modelName).first();
  if (configured?.path) {
    try {
      const file = path.join(u.getPath(["modelPrompt"]), configured.path);
      return { content: await fs.readFile(file, "utf8"), referenceDialect: "atImage" as const, source: `o_modelPrompt:${configured.path}`, modelId: null, videoPromptType: null };
    } catch {}
  }

  const vendorProfile = await resolveVendorVideoPromptProfile(vendorId, modelName, videoPromptType);
  if (vendorProfile) return vendorProfile;

  let fileName: string | null = null;
  if (["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(mode)) {
    fileName = "universalFirstAndLastFrameMode.md";
  } else if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
    fileName = "universalMulti-parameterMode.md";
  }
  if (fileName) {
    const builtin = await readBuiltinDataFile("modelPrompt", "video", fileName);
    if (builtin) return { content: builtin.content, referenceDialect: "atImage" as const, source: builtin.file, modelId: null, videoPromptType: null };
    try {
      const file = path.join(u.getPath(["modelPrompt"]), "video", fileName);
      return { content: await fs.readFile(file, "utf8"), referenceDialect: "atImage" as const, source: file, modelId: null, videoPromptType: null };
    } catch {}
  }

  const fallback = await u.db("o_prompt").where("type", "videoPromptGeneration").first();
  return { content: fallback?.useData || fallback?.data || "", referenceDialect: "atImage" as const, source: "o_prompt:videoPromptGeneration", modelId: null, videoPromptType: null };
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

function annotateReferences(items: ResolvedWorkbenchReference[]) {
  let visualImageIndex = 0;
  let audioReferenceIndex = 0;
  let videoReferenceIndex = 0;
  return items.map((item, index) => {
    const meta: PromptReferenceMeta = { inputOrder: index + 1 };
    if (item.fileType === "image") meta.visualImageIndex = ++visualImageIndex;
    if (item.fileType === "audio") meta.audioReferenceIndex = ++audioReferenceIndex;
    if (item.fileType === "video") meta.videoReferenceIndex = ++videoReferenceIndex;
    return { item, meta };
  });
}

function referenceLine(item: ResolvedWorkbenchReference, meta: PromptReferenceMeta) {
  if (item.fileType === "audio") {
    return `${meta.inputOrder}. <audioReference
  inputOrder='${meta.inputOrder}'
  audioReferenceIndex='${meta.audioReferenceIndex ?? ""}'
  source='${item.sources}'
  referenceId='${escapeAttribute(item.id)}'
  name='${escapeAttribute(item.name)}'
  fileType='audio'
  note='参考音频${meta.audioReferenceIndex ?? ""}只用于声音、音色、台词语气或画内音效参考；不得写成 @ImageN，也不占用视觉 @ImageN 编号'
></audioReference>`;
  }
  if (item.fileType === "video") {
    return `${meta.inputOrder}. <videoReference
  inputOrder='${meta.inputOrder}'
  videoReferenceIndex='${meta.videoReferenceIndex ?? ""}'
  source='${item.sources}'
  referenceId='${escapeAttribute(item.id)}'
  name='${escapeAttribute(item.name)}'
  fileType='video'
  note='参考视频${meta.videoReferenceIndex ?? ""}只作为动态、动作或节奏参考；不得写成 @ImageN，也不占用视觉 @ImageN 编号'
></videoReference>`;
  }
  if (item.sources === "storyboard") {
    return `${meta.inputOrder}. <visualReference
  inputOrder='${meta.inputOrder}'
  visualImageIndex='${meta.visualImageIndex ?? ""}'
  visualToken='${meta.visualImageIndex ? `@Image${meta.visualImageIndex}` : ""}'
  source='storyboard'
  referenceId='${escapeAttribute(item.id)}'
  name='${escapeAttribute(item.name)}'
  fileType='${item.fileType}'
  note='该分镜图是对应分镜的唯一初始视觉依据；动作、台词和画内声音仍以 trackId 查询到的分镜表事实为准'
></visualReference>`;
  }
  if (item.sources === "merged") {
    const sourceRefs = (item.sourceRefs || [])
      .map((ref) => `${ref.sources}:${ref.id}${ref.label ? `(${ref.label})` : ""}`)
      .join(", ");
    return `${meta.inputOrder}. <visualReference
  inputOrder='${meta.inputOrder}'
  visualImageIndex='${meta.visualImageIndex ?? ""}'
  visualToken='${meta.visualImageIndex ? `@Image${meta.visualImageIndex}` : ""}'
  source='merged'
  referenceId='${escapeAttribute(item.id)}'
  name='${escapeAttribute(item.name)}'
  fileType='${item.fileType}'
  sourceRefs='${escapeAttribute(sourceRefs)}'
  note='合图是视觉参考快照，不代表单个分镜，也不能替代轨道下的分镜表明细'
></visualReference>`;
  }
  const sourceType = item.category || item.fileType;
  return `${meta.inputOrder}. <visualReference
  inputOrder='${meta.inputOrder}'
  visualImageIndex='${meta.visualImageIndex ?? ""}'
  visualToken='${meta.visualImageIndex ? `@Image${meta.visualImageIndex}` : ""}'
  source='${item.sources}'
  referenceId='${escapeAttribute(item.id)}'
  name='${escapeAttribute(item.name)}'
  sourceType='${escapeAttribute(sourceType)}'
  fileType='${item.fileType}'
  note='该素材是视觉参考；若使用 @ImageN，只能使用 visualToken 对应的编号'
></visualReference>`;
}

export function buildReferenceTokenBlock(items: AnnotatedPromptReference[]) {
  const visualLines = items
    .filter(({ item, meta }) => item.fileType === "image" && meta.visualImageIndex)
    .map(({ item, meta }) => {
      const sourceType = item.category || item.sources || item.fileType;
      return `- @Image${meta.visualImageIndex}: inputOrder=${meta.inputOrder}, name='${escapeAttribute(item.name)}', source='${escapeAttribute(item.sources)}', sourceType='${escapeAttribute(sourceType)}'`;
    });
  const audioLines = items
    .filter(({ item, meta }) => item.fileType === "audio" && meta.audioReferenceIndex)
    .map(({ item, meta }) => `- 参考音频${meta.audioReferenceIndex}: inputOrder=${meta.inputOrder}, name='${escapeAttribute(item.name)}'`);
  const videoLines = items
    .filter(({ item, meta }) => item.fileType === "video" && meta.videoReferenceIndex)
    .map(({ item, meta }) => `- 参考视频${meta.videoReferenceIndex}: inputOrder=${meta.inputOrder}, name='${escapeAttribute(item.name)}'`);
  return `
**可用引用 token（最终提示词必须按此表使用，不得重排或新增）**
${visualLines.length ? visualLines.join("\n") : "- 无可用 @Image 图片引用。"}
${audioLines.length ? audioLines.join("\n") : ""}
${videoLines.length ? videoLines.join("\n") : ""}
- 只能使用上表列出的 @Image 编号；不得生成 @Image${visualLines.length + 1} 或任何未列出的图片编号。
- 素材用途可以根据分镜事实说明，但 token 与素材名的绑定不能改变。例如上表中 @Image2 是某个角色图，就不能把 @Image2 写成场景图。
- inputOrder 只用于追踪原始输入顺序，不是最终 @Image 编号；最终图片编号永远以 @ImageN token 为准。`;
}

function imageTokenPattern(token: string) {
  return new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`);
}

export function inspectReferenceTokenContract(
  text: string,
  items: AnnotatedPromptReference[],
  referenceDialect: ReferenceDialect = "atImage",
) {
  const value = String(text || "");
  const visualTokens = items
    .filter(({ item, meta }) => item.fileType === "image" && meta.visualImageIndex)
    .map(({ meta }) => `@Image${meta.visualImageIndex}`);
  if (referenceDialect === "h3") {
    const expected = items.flatMap(({ item, meta }) => {
      if (item.fileType === "image" && meta.visualImageIndex) return [`<Picture ${meta.visualImageIndex}>`];
      if (item.fileType === "video" && meta.videoReferenceIndex) return [`<Video ${meta.videoReferenceIndex}>`];
      if (item.fileType === "audio" && meta.audioReferenceIndex) return [`<Audio ${meta.audioReferenceIndex}>`];
      return [];
    });
    const expectedSet = new Set(expected);
    const mentioned = [...value.matchAll(/<(Picture|Video|Audio)\s+(\d+)>/gi)].map((match) => `<${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${match[2]}>`);
    const issues: ReferenceTokenContractIssue[] = [];
    for (const token of [...new Set([...value.matchAll(/@Image\d+/g)].map((match) => match[0]))]) {
      issues.push({
        issueType: "unexpected_reference_label",
        severity: "warning",
        token,
        message: `H3 提示词不应输出内部图片标记 ${token}，请使用对应的 <Picture N>`,
      });
    }
    for (const token of [...new Set(mentioned)]) {
      if (!expectedSet.has(token)) {
        issues.push({
          issueType: "unexpected_reference_label",
          severity: "warning",
          token,
          message: `H3 提示词引用了未提供的官方参考标签 ${token}`,
        });
      }
    }
    for (const token of expected) {
      if (!value.includes(token)) {
        issues.push({
          issueType: "missing_reference_label",
          severity: "warning",
          token,
          message: `H3 提示词缺少已提供参考素材的官方标签 ${token}`,
        });
      }
    }
    return { expectedVisualTokens: visualTokens, expectedReferenceLabels: expected, issues };
  }
  const allowed = new Set(visualTokens);
  const mentioned = [...value.matchAll(/@Image(\d+)/g)].map((match) => `@Image${match[1]}`);
  const issues: ReferenceTokenContractIssue[] = [];

  for (const token of [...new Set(mentioned)]) {
    if (!allowed.has(token)) {
      issues.push({
        issueType: "unexpected_image_token",
        severity: "blocking",
        token,
        message: `视频提示词引用了未提供的图片编号 ${token}`,
      });
    }
  }

  for (const token of visualTokens) {
    if (!imageTokenPattern(token).test(value)) {
      issues.push({
        issueType: "missing_image_token",
        severity: "blocking",
        token,
        message: `视频提示词参考定义缺少图片编号 ${token}`,
      });
    }
  }

  return { expectedVisualTokens: visualTokens, expectedReferenceLabels: visualTokens, issues };
}

function buildReferenceTokenRetryPrompt(
  previousText: string,
  tokenBlock: string,
  issues: ReferenceTokenContractIssue[],
) {
  return `
请只修复视频提示词中的引用编号契约问题，保留原有分镜内容和动作描述。

${tokenBlock}

本次必须修复的问题：
${issues.map((issue) => `- ${issue.message}`).join("\n")}

上一版提示词：
${previousText}

请重新输出完整视频提示词正文。要求：
- “参考定义”必须列出可用引用 token 表中的全部 @ImageN。
- 不得出现可用引用 token 表之外的 @ImageN。
- 不要输出解释、审校建议、JSON 或 Markdown。`;
}

function buildTrackFacts(track: any) {
  if (!track) return "";
  if (!track.duration) return "";
  return `
**当前生成组**
- plannedDuration: ${track.duration}s
按下方分镜顺序完成当前组，不重新拆组，也不混入其他组内容。`;
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

function storyboardReferenceIds(items: AnnotatedPromptReference[]) {
  const ids = new Set<number>();
  for (const { item } of items) {
    if (item.fileType !== "image") continue;
    if (item.sources === "storyboard") {
      const id = Number(item.id);
      if (Number.isFinite(id)) ids.add(id);
    }
  }
  return ids;
}

function storyboardLine(item: StoryboardVideoFact, index: number, hasStoryboardImage: boolean) {
  const isV3 = item.factVersion === 3;
  const attributes = [
    `storyboardId='${item.storyboardId}'`,
    `displayIndex='${escapeAttribute(item.displayIndex)}'`,
    `factVersion='${escapeAttribute(item.factVersion)}'`,
    `duration='${escapeAttribute(item.duration)}'`,
    `visualStart='${hasStoryboardImage ? "storyboardReference" : "textFallback"}'`,
    ...(isV3
      ? [
          `shotDescription='${escapeAttribute(item.shotDescription)}'`,
          ...(hasStoryboardImage
            ? [`shotDescriptionRole='temporalContinuation'`]
            : [
                `shotDescriptionRole='fullShot'`,
                `shotSize='${escapeAttribute(item.shotSize)}'`,
                ...(item.cameraAngle ? [`cameraAngle='${escapeAttribute(item.cameraAngle)}'`] : []),
              ]),
        ]
      : [
          ...(!hasStoryboardImage
            ? [`picture='${escapeAttribute(item.picture)}'`, `shotSize='${escapeAttribute(item.shotSize)}'`]
            : []),
          `action='${escapeAttribute(item.action)}'`,
        ]),
    `cameraMove='${escapeAttribute(item.cameraMove)}'`,
    `dialogue='${escapeAttribute(item.dialogue)}'`,
    `sound='${escapeAttribute(item.sound)}'`,
  ];
  return `${index + 1}. <trackStoryboard\n  ${attributes.join("\n  ")}\n></trackStoryboard>`;
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

function buildStoryboardFacts(storyboards: StoryboardVideoFact[], references: AnnotatedPromptReference[]) {
  if (!storyboards.length) {
    return `
**分镜组完整明细**
- 当前轨道未查询到分镜表明细。若引用区包含 storyboard，可使用引用区的视觉参考；否则不得臆造分镜数量。`;
  }
  const sourceSummary = summarizeFactSources(storyboards);
  const storyboardImages = storyboardReferenceIds(references);
  if (storyboards.every((item) => item.factVersion === 3)) {
    return `
**分镜事实（Storyboard V3）**
- storyboardCount: ${storyboards.length}
- factSources: storyboardTable=${sourceSummary.storyboardTable}, minimalFallback=${sourceSummary.minimalFallback}

按顺序逐条生成。shotDescription 是唯一的时间事实正文。
- visualStart=storyboardReference：分镜图是唯一开拍画面依据，只从 shotDescription 组织开拍后的变化与结束状态，不复述或重建初始构图。
- visualStart=textFallback：使用完整 shotDescription、shotSize 和必要 cameraAngle 建立开拍状态及后续变化。
${storyboards.map((item, index) => storyboardLine(item, index, storyboardImages.has(item.storyboardId))).join("\n")}`;
  }
  if (storyboards.some((item) => item.factVersion === 3)) {
    return `
**分镜事实（版本混合）**
- storyboardCount: ${storyboards.length}
- factSources: storyboardTable=${sourceSummary.storyboardTable}, minimalFallback=${sourceSummary.minimalFallback}

逐条按 factVersion 原生解释：V3 使用 shotDescription；历史 V1/V2 使用 picture/action。不得在版本之间拼接或借用字段。每条 visualStart=storyboardReference 时，分镜图都是该条唯一初始画面依据。
${storyboards.map((item, index) => storyboardLine(item, index, storyboardImages.has(item.storyboardId))).join("\n")}`;
  }
  return `
**分镜事实**
- storyboardCount: ${storyboards.length}
- factSources: storyboardTable=${sourceSummary.storyboardTable}, minimalFallback=${sourceSummary.minimalFallback}

按顺序逐条生成。以下为历史 V1/V2 事实：visualStart=storyboardReference 时，分镜图是唯一初始画面依据；textFallback 时才使用 picture 和 shotSize。action 是历史行的时间变化正文来源。
${storyboards.map((item, index) => storyboardLine(item, index, storyboardImages.has(item.storyboardId))).join("\n")}`;
}

function buildGenerationConstraints() {
  return `
**生成阶段质量约束**
- 保留模型专属 Prompt 的详细格式和引用编号规则。
- 当模型专属 Prompt 要求使用 @ImageN 时，@ImageN 只对应引用区 visualToken='@ImageN' 的图片引用；音频和视频引用不占用、不改写、不顺延 @ImageN。
- 音频引用只能写成“参考音频N”或音频素材名，用于声音、音色、台词语气或画内音效参考，不得当作视觉参考。
- 分镜表事实是视频提示词主输入；分镜面板 prompt / imagePrompt 不作为视频主上下文。
- 不创造新剧情，不自行改写场景时间、光影、色调、人物关系。
- visualStart=storyboardReference 时，分镜图已经锁定初始构图，不再用文字复述或重新规划人物站位、景别和机位；普通角色/场景/道具参考不能替代分镜图的这一职责。
- visualStart=textFallback 时，按该条 factVersion 使用版本原生字段建立初始画面：V3 使用完整 shotDescription、shotSize 和必要 cameraAngle；历史 V1/V2 使用 picture 和 shotSize。
- 时间变化只读取版本原生正文：V3 使用 shotDescription；历史 V1/V2 使用 action。不得跨版本寻找缺失字段，也不得另行扩写一套“情绪表演”。
- 画内音效可以进入视频提示词，例如脚步声、广播声、衣料摩擦声、呼吸声、环境声、动作声。
- BGM、配乐、OST、非画内音乐只属于后期建议，不得写入视频提示词。
- 不要加入图片生成用画质堆叠词，例如“极致细节、发丝根根分明、面容细腻渲染、纹理细节超清晰、强对比度与极致细节”。
- 生成阶段只输出视频提示词正文，不输出审校建议、分析过程或修订说明；审校建议由后续 reviewer 负责。`;
}

function buildStoryboardVersionConstraints() {
  return `
**Storyboard version interpretation**
- factVersion=3: shotDescription is one chronological source: opening state, trigger, visible change, ending state.
- factVersion=1/2: picture is the textual opening fallback and action is the temporal body.
- When visualStart=storyboardReference, the storyboard image is the only opening visual. Use only the version-native temporal body for subsequent change and ending state; do not restate or replace the image composition.
- Never merge fields across versions, split shotDescription with backend-style keywords, or invent a second opening state.
`;
}

function buildFormalVideoStyleBlock(videoStyle: string) {
  if (!videoStyle) return "";
  return `
**正式视频风格（当前已提交导演规划）**
${videoStyle}
- 这是整集稳定风格锚点。必须原义沿用，不得扩写、二次总结或改写为另一种媒介。`;
}

function buildVideoStyleGuide(videoStyle: string) {
  return `
**视频视觉风格约束**
- 不单独读取视觉手册，不根据项目 artStyle 名称自行扩写媒介、画风或视觉标签。
- ${videoStyle ? "‘画面风格和类型’直接使用正式 videoStyle 的原义，不增加场景、天气、人物、动作、机位、画质词或生成参数。" : "当前没有正式视频风格时，不自行发明风格首行，只按参考图和分镜事实生成镜头正文。"}
- 参考图用于锁定人物外观、环境、构图、光线和色彩等具体事实；不得借此改变正式视频风格的媒介类型。
- 不得覆盖分镜表中的 action、台词和画内声音事实。`;
}

export async function compileWorkbenchVideoPrompt(
  input: CompileVideoPromptInput,
  options: CompileVideoPromptOptions = {},
): Promise<CompileVideoPromptResult> {
  const { vendorId, modelName } = parseVideoModelKey(input.model);
  const project = await u.db("o_project").where("id", input.projectId).first();
  if (!project) throw new Error("项目不存在");

  const track = input.trackId ? await u.db("o_videoTrack").where({ id: input.trackId, projectId: input.projectId }).first() : null;
  const selectedVideoPromptType = typeof input.videoPromptType === "string" ? input.videoPromptType.trim() || null : null;
  await assertVideoPromptTypeForModel(input.model, selectedVideoPromptType);
  const system = await resolveSystemPrompt(vendorId, modelName, input.mode, selectedVideoPromptType);
  const scriptId = input.scriptId ?? (track?.scriptId == null ? undefined : Number(track.scriptId));
  const videoStyle = scriptId == null ? "" : await getCommittedDirectorPlanVideoStyle({ projectId: input.projectId, scriptId });
  const trackStoryboards = await loadTrackStoryboards(input);
  assertStoryboardFactsReady(trackStoryboards);
  const referenceInputs = input.references || [];
  const references = await resolveWorkbenchReferences(referenceInputs, {
    projectId: input.projectId,
    scriptId: input.scriptId,
    trackId: input.trackId,
    requireFile: false,
  });

  const annotatedReferences = annotateReferences(references);
  const orderedReferenceText = annotatedReferences.map(({ item, meta }) => referenceLine(item, meta)).join("\n");
  const referenceTokenBlock = buildReferenceTokenBlock(annotatedReferences);
  const promptContext = `
**模型名称**：${modelName}
**模式**：${input.mode}
${buildFormalVideoStyleBlock(videoStyle)}
${referenceTokenBlock}

**原始引用清单**（仅供核对 source/referenceId，不用于重排 @Image）：${orderedReferenceText}
${buildTrackFacts(track)}
${buildStoryboardFacts(trackStoryboards, annotatedReferences)}
${constraintBlock(input.promptPrefix, input.promptSuffix)}
${buildGenerationConstraints()}
${buildStoryboardVersionConstraints()}
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
    modelId: system.modelId || null,
    referenceDialect: system.referenceDialect,
    selectedVideoPromptType,
    effectiveVideoPromptType: system.videoPromptType || null,
    references: referenceInputs,
    resolvedReferences: annotatedReferences.map(({ item, meta }) => ({
      order: meta.inputOrder,
      inputOrder: meta.inputOrder,
      id: item.id,
      sources: item.sources,
      fileType: item.fileType,
      name: item.name,
      visualImageIndex: meta.visualImageIndex,
      audioReferenceIndex: meta.audioReferenceIndex,
      videoReferenceIndex: meta.videoReferenceIndex,
      sourceRefs: item.sourceRefs,
    })),
    storyboardCount: trackStoryboards.length,
    factSourceSummary,
    groupSummary,
  };
  let text = "";
  let retryReason: ReferenceTokenContractIssue[] = [];
  let retryOutputSummary = "";
  const baseMessages = [
    { role: "assistant" as const, content: buildVideoStyleGuide(videoStyle) },
    { role: "user" as const, content: promptContext },
  ];
  try {
    const result = await u.Ai.Text("universalAi").invoke({
      system: system.content,
      messages: baseMessages,
    });
    text = String(result.text || "");
    const firstContractInspection = inspectReferenceTokenContract(text, annotatedReferences, system.referenceDialect);
    if (system.referenceDialect === "atImage" && firstContractInspection.issues.length) {
      retryReason = firstContractInspection.issues;
      retryOutputSummary = text.slice(0, 4000);
      const retryResult = await u.Ai.Text("universalAi").invoke({
        system: system.content,
        messages: [
          ...baseMessages,
          { role: "assistant" as const, content: text },
          {
            role: "user" as const,
            content: buildReferenceTokenRetryPrompt(text, referenceTokenBlock, firstContractInspection.issues),
          },
        ],
      });
      text = String(retryResult.text || "");
    }
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
  const referenceInspection = inspectReferenceTokenContract(text, annotatedReferences, system.referenceDialect);
  const engineeringIssues = [...inspection.issues, ...referenceInspection.issues];
  const diagnosticFile = writeDiagnosticFile(
    `video-prompt-track-${input.trackId || "unknown"}`,
    JSON.stringify(
      {
        ...diagnosticBase,
        promptContext,
        systemPrompt: system.content,
        aiOutputSummary: text.slice(0, 4000),
        aiOutputLength: text.length,
        referenceContract: {
          expectedVisualTokens: referenceInspection.expectedVisualTokens,
          expectedReferenceLabels: referenceInspection.expectedReferenceLabels,
          dialect: system.referenceDialect,
          retried: retryReason.length > 0,
          retryReason,
          firstAiOutputSummary: retryOutputSummary || undefined,
        },
        engineeringIssues,
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
  if (engineeringIssues.some((issue) => issue.severity === "blocking")) {
    const blocking = engineeringIssues.find((issue) => issue.severity === "blocking");
    const prefix = referenceInspection.issues.length ? "视频提示词引用编号校验失败" : "视频提示词生成失败";
    throw new Error(`${prefix}：${blocking?.message || "未知错误"}`);
  }
  return {
    text: text.trim(),
    systemPrompt: system.content,
    systemPromptSource: system.source,
    promptContext,
    engineeringIssues,
    diagnosticFile,
    factSourceSummary,
    groupSummary,
    promptProfile: {
      model: input.model,
      modelId: system.modelId || null,
      videoPromptType: system.videoPromptType || null,
      systemPromptSource: system.source,
    },
  };
}
