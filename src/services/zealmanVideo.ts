import axios from "axios";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import FormData from "form-data";
import type {
  ZealmanExecutionOverrides,
  ZealmanExecutionValue,
  ZealmanQualityParameterKey,
} from "@/services/zealmanWorkflowSettings";

export const ZEALMAN_U06_MODEL_KEY = "zealman:minimax-h3-u06";
export const ZEALMAN_U06_LIGHT2V_MODEL_KEY = "zealman:minimax-h3-u06-light2v";

export const ZEALMAN_WORKFLOWS = {
  [ZEALMAN_U06_MODEL_KEY]: {
    modelKey: ZEALMAN_U06_MODEL_KEY,
    workflowId: "U06-minimax_h3_多图参考生视频叠加加速插帧优化版",
    label: "MiniMax H3 U06",
  },
  [ZEALMAN_U06_LIGHT2V_MODEL_KEY]: {
    modelKey: ZEALMAN_U06_LIGHT2V_MODEL_KEY,
    workflowId: "U06-minimax_h3_light2v多图参考生视频叠加加速插帧优化版",
    label: "MiniMax H3 Light2v U06",
  },
} as const;

export const ZEALMAN_U06_WORKFLOW_ID = ZEALMAN_WORKFLOWS[ZEALMAN_U06_MODEL_KEY].workflowId;

const REFERENCE_LIMITS = { image: 9, video: 3, audio: 3 } as const;
const CUSTOM_WIDTH = "自定义宽";
const CUSTOM_HEIGHT = "自定义高";

export type ZealmanModelKey = keyof typeof ZEALMAN_WORKFLOWS;
export type ZealmanReference = { type: keyof typeof REFERENCE_LIMITS; filePath: string };
export type ZealmanInput = {
  prompt: string;
  duration: number;
  aspectRatio: string;
  resolution: string;
  audio?: boolean;
  references: ZealmanReference[];
};
type WorkflowNode = { class_type?: string; inputs?: Record<string, any>; _meta?: { title?: string } };
export type WorkflowTemplate = Record<string, WorkflowNode>;
type ReferenceBinding = {
  type: ZealmanReference["type"];
  index: number;
  h3Field: string;
  nodeId: string;
  inputName: string;
};
type RtxSuperResolutionBinding = {
  nodeId: string;
  inputName: "resize_type.scale";
  source: [string, number];
  consumers: Array<{ nodeId: string; inputName: string }>;
};
type ZealmanQualityBinding = {
  nodeId: string;
  inputName: string;
  rtxSuperResolution?: RtxSuperResolutionBinding;
};
type ZealmanQualityBindings = Record<ZealmanQualityParameterKey, ZealmanQualityBinding>;
type ExecutionContract = {
  modelKey: ZealmanModelKey;
  h3NodeId: string;
  bindings: ReferenceBinding[];
  promptNodeId: string;
  durationNodeId: string;
  latentNodeId: string;
  uploadedNames: Record<string, string>;
  prompt: string;
  duration: number;
  width: number;
  height: number;
  executionOverrides: ZealmanExecutionOverrides;
  qualityBindings: ZealmanQualityBindings;
};
export type ZealmanWorkflowExecutionParameter = {
  key: ZealmanQualityParameterKey;
  label: string;
  currentValue: ZealmanExecutionValue;
  ui: "select" | "number" | "toggle";
  options?: Array<string | number>;
  help?: string;
};
export type ZealmanQualityParameterDefinitions = Record<ZealmanQualityParameterKey, { options?: string[] }>;
export type ZealmanEndpoint = { url: string; modelKey: ZealmanModelKey; workflowHash: string };

type HttpGet = { get: (url: string, config?: any) => Promise<{ status?: number; data: any }> };
type HttpPost = { post: (url: string, body?: any, config?: any) => Promise<{ data: any }> };
type HttpClient = HttpGet & HttpPost;

function asTemplate(value: unknown): WorkflowTemplate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Zealman did not return a workflow_template");
  return value as WorkflowTemplate;
}

function cloneTemplate(template: WorkflowTemplate): WorkflowTemplate {
  return JSON.parse(JSON.stringify(template)) as WorkflowTemplate;
}

function asLink(value: unknown): [string, number] | undefined {
  return Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number" ? [value[0], value[1]] : undefined;
}

function modelFromKey(value: string): ZealmanModelKey {
  if (value in ZEALMAN_WORKFLOWS) return value as ZealmanModelKey;
  throw new Error(`Unsupported Zealman video model: ${value}`);
}

export function getZealmanWorkflow(value: string) {
  return ZEALMAN_WORKFLOWS[modelFromKey(value)];
}

function templateFromResponse(value: unknown) {
  const response = value && typeof value === "object" ? value as Record<string, any> : {};
  const nested = response.data && typeof response.data === "object" ? response.data : response;
  return asTemplate(nested.workflow_template || nested);
}

function removeRtxNodesForComparison(templateValue: unknown) {
  const template = cloneTemplate(asTemplate(templateValue));
  for (const [nodeId, node] of Object.entries(template)) {
    if (node.class_type !== "RTXVideoSuperResolution") continue;
    const source = asLink(node.inputs?.images);
    if (!source || !template[source[0]]) throw new Error("Zealman RTX super-resolution node must have one image input");
    for (const consumer of Object.values(template)) {
      for (const [inputName, value] of Object.entries(consumer.inputs || {})) {
        if (asLink(value)?.[0] === nodeId) consumer.inputs![inputName] = [...source];
      }
    }
    delete template[nodeId];
  }
  delete template._api_config;
  return Object.fromEntries(Object.entries(template).sort(([left], [right]) => left.localeCompare(right)).map(([nodeId, node]) => [nodeId, {
    class_type: node.class_type || "",
    inputs: node.inputs || {},
  }]));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Zealman's API configuration intentionally omits the optional RTX branch, while
 * its own quick panel reads the full per-workflow execution graph from this URL.
 * Both are read for every use so a stale auxiliary graph can never be submitted.
 */
export async function fetchZealmanExecutionTemplate(baseUrl: string, modelKey: string, client: HttpGet = axios) {
  const workflow = getZealmanWorkflow(modelKey);
  const [configured, execution] = await Promise.all([
    client.get(`${baseUrl}/api/workflow/config/${encodeURIComponent(workflow.workflowId)}`, { timeout: 30_000 }),
    client.get(`${baseUrl}/${encodeURIComponent(workflow.workflowId)}.json`, { timeout: 30_000 }),
  ]);
  const configuredTemplate = templateFromResponse(configured.data);
  const executionTemplate = templateFromResponse(execution.data);
  if (stableJson(removeRtxNodesForComparison(configuredTemplate)) !== stableJson(removeRtxNodesForComparison(executionTemplate))) {
    throw new Error("Zealman quick-panel execution graph no longer matches the configured workflow");
  }
  return executionTemplate;
}

export function parseZealmanInstanceUrls(value: unknown) {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of String(value || "").split(/[\r\n,]+/)) {
    const candidate = raw.trim();
    if (!candidate) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error(`Invalid Zealman instance URL: ${candidate}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Zealman instance URL must use HTTP or HTTPS: ${candidate}`);
    const normalized = parsed.toString().replace(/\/+$/, "");
    if (!seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  }
  if (!urls.length) throw new Error("Configure at least one Zealman instance URL");
  return urls;
}

export function zealmanDimensions(resolution: string, aspectRatio: string) {
  if (String(resolution).toLowerCase() !== "768p") throw new Error("Zealman H3 U06 supports 768P only");
  if (aspectRatio === "16:9") return { width: 1344, height: 768 };
  if (aspectRatio === "9:16") return { width: 768, height: 1344 };
  throw new Error("Zealman H3 U06 supports 16:9 or 9:16 only");
}

function validateInput(input: ZealmanInput) {
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("Zealman H3 U06 requires a video prompt");
  if (!Number.isInteger(input.duration) || input.duration < 4 || input.duration > 15) throw new Error("Zealman H3 U06 supports durations from 4 to 15 seconds");
  const byType = { image: [] as ZealmanReference[], video: [] as ZealmanReference[], audio: [] as ZealmanReference[] };
  for (const reference of input.references) byType[reference.type].push(reference);
  if (!byType.image.length) throw new Error("Zealman H3 U06 requires at least one image reference");
  for (const type of Object.keys(REFERENCE_LIMITS) as ZealmanReference["type"][]) {
    if (byType[type].length > REFERENCE_LIMITS[type]) throw new Error(`Zealman H3 U06 supports at most ${REFERENCE_LIMITS[type]} ${type} references`);
  }
  return { prompt, byType, dimensions: zealmanDimensions(input.resolution, input.aspectRatio) };
}

function findH3Node(template: WorkflowTemplate) {
  const matches = Object.entries(template).filter(([, node]) => node?.class_type === "MiniMaxH3ReferenceToVideo");
  if (matches.length !== 1) throw new Error(`Zealman workflow must contain exactly one MiniMaxH3ReferenceToVideo node; found ${matches.length}`);
  const [id, node] = matches[0];
  if (!node.inputs) throw new Error("Zealman H3 node has no inputs");
  return { id, node };
}

function referenceTypeFromField(field: string): ZealmanReference["type"] | undefined {
  if (/^ref_images\.ref_image_\d+$/.test(field)) return "image";
  if (/^ref_videos\.ref_video_\d+$/.test(field)) return "video";
  if (/^ref_audios\.ref_audio_\d+$/.test(field)) return "audio";
  return undefined;
}

function expectedLoader(type: ZealmanReference["type"], node: WorkflowNode) {
  const classType = String(node.class_type || "");
  const inputName = type === "image" ? "image" : type === "video" ? "video" : "audio";
  const pattern = type === "image" ? /LoadImage/i : type === "video" ? /LoadVideo/i : /LoadAudio/i;
  if (!pattern.test(classType) || !(inputName in (node.inputs || {}))) throw new Error(`Zealman ${type} reference source is not a compatible loader node`);
  return inputName;
}

function resolveBindings(template: WorkflowTemplate, h3Node: WorkflowNode): ReferenceBinding[] {
  const grouped = { image: [] as ReferenceBinding[], video: [] as ReferenceBinding[], audio: [] as ReferenceBinding[] };
  for (const [field, value] of Object.entries(h3Node.inputs || {})) {
    const type = referenceTypeFromField(field);
    if (!type) continue;
    const link = asLink(value);
    if (!link) throw new Error(`Zealman H3 reference input ${field} is not connected to a loader`);
    const source = template[link[0]];
    if (!source) throw new Error(`Zealman H3 reference input ${field} points to a missing node`);
    grouped[type].push({ type, index: -1, h3Field: field, nodeId: link[0], inputName: expectedLoader(type, source) });
  }
  const bindings: ReferenceBinding[] = [];
  for (const type of Object.keys(REFERENCE_LIMITS) as ZealmanReference["type"][]) {
    const sorted = grouped[type].sort((left, right) => left.h3Field.localeCompare(right.h3Field, undefined, { numeric: true }));
    if (sorted.length !== REFERENCE_LIMITS[type]) throw new Error(`Zealman H3 workflow must expose ${REFERENCE_LIMITS[type]} ${type} references; found ${sorted.length}`);
    sorted.forEach((binding, index) => bindings.push({ ...binding, index }));
  }
  return bindings;
}

function upstreamNodes(template: WorkflowTemplate, initial: unknown) {
  const pending = [asLink(initial)].filter((item): item is [string, number] => Boolean(item));
  const visited = new Set<string>();
  const nodes: Array<[string, WorkflowNode]> = [];
  while (pending.length) {
    const [id] = pending.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = template[id];
    if (!node) continue;
    nodes.push([id, node]);
    for (const value of Object.values(node.inputs || {})) {
      const link = asLink(value);
      if (link) pending.push(link);
    }
  }
  return nodes;
}

function resolveExecutionNodes(template: WorkflowTemplate, h3Node: WorkflowNode) {
  const promptLink = asLink(h3Node.inputs?.prompt);
  if (!promptLink || !("prompt" in (template[promptLink[0]]?.inputs || {}))) throw new Error("Zealman H3 prompt must resolve to a prompt node");
  const duration = upstreamNodes(template, h3Node.inputs?.length).find(([, node]) => /Primitive(Float|Int)/i.test(String(node.class_type)) && "value" in (node.inputs || {}));
  if (!duration) throw new Error("Zealman H3 duration must resolve to a primitive duration node");
  const dimensions = [...upstreamNodes(template, h3Node.inputs?.width), ...upstreamNodes(template, h3Node.inputs?.height)]
    .find(([, node]) => CUSTOM_WIDTH in (node.inputs || {}) && CUSTOM_HEIGHT in (node.inputs || {}));
  if (!dimensions) throw new Error("Zealman H3 dimensions must resolve to a custom width/height node");
  return { promptNodeId: promptLink[0], durationNodeId: duration[0], latentNodeId: dimensions[0] };
}

function asExecutionValue(value: unknown): ZealmanExecutionValue | undefined {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ? value : undefined;
}

function connectedNodes(template: WorkflowTemplate, startId: string) {
  const adjacent = new Map<string, Set<string>>();
  const connect = (left: string, right: string) => {
    adjacent.set(left, new Set([...(adjacent.get(left) || []), right]));
    adjacent.set(right, new Set([...(adjacent.get(right) || []), left]));
  };
  for (const [nodeId, node] of Object.entries(template)) {
    for (const value of Object.values(node.inputs || {})) {
      const link = asLink(value);
      if (link) connect(nodeId, link[0]);
    }
  }
  const pending = [startId];
  const visited = new Set<string>();
  while (pending.length) {
    const nodeId = pending.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    for (const next of adjacent.get(nodeId) || []) pending.push(next);
  }
  return [...visited].map((nodeId) => [nodeId, template[nodeId]] as [string, WorkflowNode]).filter(([, node]) => Boolean(node));
}

function onlyQualityNode(nodes: Array<[string, WorkflowNode]>, label: string, predicate: (node: WorkflowNode) => boolean) {
  const matches = nodes.filter(([, node]) => predicate(node));
  if (matches.length !== 1) throw new Error(`Zealman workflow must contain exactly one ${label} on the H3 execution path; found ${matches.length}`);
  return matches[0];
}

function resolveRtxSuperResolutionBinding(template: WorkflowTemplate, graph: Array<[string, WorkflowNode]>): RtxSuperResolutionBinding {
  const [nodeId, node] = onlyQualityNode(
    graph,
    "final RTX video super-resolution node",
    (candidate) => candidate.class_type === "RTXVideoSuperResolution" && "resize_type.scale" in (candidate.inputs || {}),
  );
  const source = asLink(node.inputs?.images);
  if (!source || !template[source[0]]) throw new Error("Zealman RTX super-resolution node must have one image input");
  const consumers: RtxSuperResolutionBinding["consumers"] = [];
  for (const [consumerId, consumer] of Object.entries(template)) {
    for (const [inputName, value] of Object.entries(consumer.inputs || {})) {
      const link = asLink(value);
      if (link?.[0] === nodeId) consumers.push({ nodeId: consumerId, inputName });
    }
  }
  if (!consumers.length) throw new Error("Zealman RTX super-resolution node must feed the output chain");
  return { nodeId, inputName: "resize_type.scale", source, consumers };
}

function disableRtxSuperResolution(template: WorkflowTemplate, binding: RtxSuperResolutionBinding) {
  const node = template[binding.nodeId];
  if (!node?.inputs) throw new Error("Zealman cloud workflow is missing RTX super-resolution node");
  const source = asLink(node.inputs.images);
  if (!source || source[0] !== binding.source[0] || source[1] !== binding.source[1]) {
    throw new Error("Zealman RTX super-resolution input changed before it could be disabled");
  }
  for (const consumer of binding.consumers) {
    const inputs = template[consumer.nodeId]?.inputs;
    const link = asLink(inputs?.[consumer.inputName]);
    if (!inputs || !link || link[0] !== binding.nodeId) {
      throw new Error("Zealman RTX super-resolution output chain changed before it could be disabled");
    }
    inputs[consumer.inputName] = [...source];
  }
  delete template[binding.nodeId];
}

export function resolveZealmanQualityBindings(templateValue: unknown): ZealmanQualityBindings {
  const template = asTemplate(templateValue);
  const { id: h3NodeId, node: h3 } = findH3Node(template);
  const graph = connectedNodes(template, h3NodeId);
  const clipBranch = upstreamNodes(template, h3.inputs?.clip);
  const [clipNodeId] = onlyQualityNode(clipBranch, "H3 text encoder", (node) => node.class_type === "CLIPLoader" && "clip_name" in (node.inputs || {}));
  const [unetNodeId] = onlyQualityNode(graph, "H3 base model", (node) => node.class_type === "UNETLoader" && "unet_name" in (node.inputs || {}));
  const [schedulerNodeId] = onlyQualityNode(graph, "H3 sampler steps", (node) => node.class_type === "BasicScheduler" && "steps" in (node.inputs || {}));
  const superResolution = resolveRtxSuperResolutionBinding(template, graph);
  return {
    baseModel: { nodeId: unetNodeId, inputName: "unet_name" },
    textEncoder: { nodeId: clipNodeId, inputName: "clip_name" },
    steps: { nodeId: schedulerNodeId, inputName: "steps" },
    superResolution: {
      nodeId: superResolution.nodeId,
      inputName: superResolution.inputName,
      rtxSuperResolution: superResolution,
    },
  };
}

export function listZealmanWorkflowExecutionParameters(
  templateValue: unknown,
  modelKey: string,
  definitions: Partial<ZealmanQualityParameterDefinitions> = {},
): ZealmanWorkflowExecutionParameter[] {
  const template = asTemplate(templateValue);
  modelFromKey(modelKey);
  const bindings = resolveZealmanQualityBindings(template);
  const display: Record<ZealmanQualityParameterKey, Pick<ZealmanWorkflowExecutionParameter, "label" | "ui" | "help">> = {
    baseModel: { label: "底模", ui: "select", help: "主 H3 生成链底模" },
    textEncoder: { label: "文本编码器", ui: "select", help: "主 H3 提示词编码器" },
    steps: { label: "迭代步数", ui: "number", help: "主 H3 采样步数" },
    superResolution: {
      label: "超清 2×",
      ui: "toggle",
      help: "启用 RTX Video Super Resolution 2×；关闭后保留插帧，不执行 RTX 超清放大。",
    },
  };
  return (Object.keys(bindings) as ZealmanQualityParameterKey[]).map((key) => {
    const binding = bindings[key];
    const currentValue = key === "superResolution"
      ? true
      : asExecutionValue(template[binding.nodeId]?.inputs?.[binding.inputName]);
    if (currentValue === undefined) throw new Error(`Zealman workflow quality parameter ${key} is not a scalar value`);
    const options = definitions[key]?.options;
    return {
      key,
      ...display[key],
      currentValue,
      ...(options?.length ? { options: [...new Set([...options, String(currentValue)])] } : {}),
    };
  });
}

function scanModelFileNames(value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const nested = source.data && typeof source.data === "object" && !Array.isArray(source.data) ? source.data as Record<string, unknown> : source;
  const downloaded = Array.isArray(nested.downloaded) ? nested.downloaded : [];
  return [...new Set(downloaded.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))];
}

function candidatesForCurrentModel(currentValue: string, files: string[], family: RegExp, supported?: (fileName: string) => boolean) {
  const fileName = currentValue.replace(/^.*\//, "");
  const familyMatch = fileName.match(family);
  if (!familyMatch) return [];
  const familyPrefix = familyMatch[1]
    ? `minimax_h3_${familyMatch[1]}_`
    : familyMatch[0];
  const prefix = currentValue.slice(0, Math.max(0, currentValue.length - fileName.length));
  return files
    .filter((item) => item.toLowerCase().startsWith(familyPrefix.toLowerCase()))
    .filter((item) => !supported || supported(item))
    .map((item) => `${prefix}${item}`)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

/**
 * Zealman's API workflow config does not contain the quick-panel model options.
 * The panel's model scan is the portable source of installed selectable files;
 * bindings still come from the current workflow graph, never from fixed node IDs.
 */
export function deriveZealmanQualityParameterDefinitions(
  templateValue: unknown,
  modelScanValue: unknown,
): Partial<ZealmanQualityParameterDefinitions> {
  const template = asTemplate(templateValue);
  const bindings = resolveZealmanQualityBindings(template);
  const files = scanModelFileNames(modelScanValue);
  const baseCurrent = String(template[bindings.baseModel.nodeId]?.inputs?.[bindings.baseModel.inputName] || "");
  const encoderCurrent = String(template[bindings.textEncoder.nodeId]?.inputs?.[bindings.textEncoder.inputName] || "");
  const baseOptions = candidatesForCurrentModel(baseCurrent, files, /^minimax_h3_(ref2va|fl2va)_/i);
  const encoderOptions = candidatesForCurrentModel(
    encoderCurrent,
    files,
    /^qwen3vl_32b_minimax_h3_/i,
    (fileName) => /_(?:bf16|int8_convrot|nvfp4_awq)\.safetensors$/i.test(fileName),
  );
  return {
    ...(baseOptions.length ? { baseModel: { options: baseOptions } } : {}),
    ...(encoderOptions.length ? { textEncoder: { options: encoderOptions } } : {}),
  };
}

function applyZealmanExecutionOverrides(
  template: WorkflowTemplate,
  modelKey: ZealmanModelKey,
  overrides: ZealmanExecutionOverrides,
  definitions: Partial<ZealmanQualityParameterDefinitions> = {},
) {
  const allowed = new Map(listZealmanWorkflowExecutionParameters(template, modelKey, definitions).map((item) => [item.key, item]));
  const bindings = resolveZealmanQualityBindings(template);
  for (const [key, value] of Object.entries(overrides)) {
    const qualityKey = key as ZealmanQualityParameterKey;
    const parameter = allowed.get(qualityKey);
    const target = bindings[qualityKey];
    if (!parameter || !target || !template[target.nodeId]?.inputs || !(target.inputName in template[target.nodeId].inputs!)) {
      throw new Error(`Zealman cloud workflow is missing configured execution parameter: ${key}`);
    }
    if (parameter.ui === "select" && (!parameter.options?.includes(String(value)))) {
      throw new Error(`Zealman cloud workflow does not offer selected ${parameter.label}: ${value}`);
    }
    if (parameter.ui === "number" && typeof value !== "number") throw new Error(`Zealman ${parameter.label} must be a number`);
    if (parameter.ui === "toggle") {
      if (typeof value !== "boolean" || !target.rtxSuperResolution) throw new Error(`Zealman ${parameter.label} must be enabled or disabled`);
      if (!value) disableRtxSuperResolution(template, target.rtxSuperResolution);
      continue;
    }
    template[target.nodeId].inputs![target.inputName] = value;
  }
  return bindings;
}

function normalizedWorkflowHash(template: WorkflowTemplate, modelKey: string) {
  const copy = cloneTemplate(template);
  const { id: h3NodeId, node: h3 } = findH3Node(copy);
  const bindings = resolveBindings(copy, h3);
  for (const binding of bindings) copy[binding.nodeId].inputs![binding.inputName] = "__REFERENCE__";
  const nodes = resolveExecutionNodes(copy, h3);
  copy[nodes.promptNodeId].inputs!.prompt = "__PROMPT__";
  copy[nodes.durationNodeId].inputs!.value = 0;
  copy[nodes.latentNodeId].inputs![CUSTOM_WIDTH] = 0;
  copy[nodes.latentNodeId].inputs![CUSTOM_HEIGHT] = 0;
  for (const binding of Object.values(resolveZealmanQualityBindings(copy))) {
    copy[binding.nodeId].inputs![binding.inputName] = "__EXECUTION_PARAMETER__";
  }
  for (const node of Object.values(copy)) {
    if (node.inputs && "seed" in node.inputs) node.inputs.seed = "__SEED__";
    if (node.inputs && "noise_seed" in node.inputs) node.inputs.noise_seed = "__SEED__";
  }
  return crypto.createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

export function inspectZealmanWorkflow(templateValue: unknown, modelKey: string): Pick<ZealmanEndpoint, "modelKey" | "workflowHash"> {
  const template = asTemplate(templateValue);
  const typedKey = modelFromKey(modelKey);
  const { id: h3NodeId, node: h3 } = findH3Node(template);
  resolveBindings(template, h3);
  resolveExecutionNodes(template, h3);
  resolveZealmanQualityBindings(template);
  return { modelKey: typedKey, workflowHash: normalizedWorkflowHash(template, typedKey) };
}

export async function inspectZealmanEndpoint(baseUrl: string, modelKey: string, client: HttpGet = axios): Promise<ZealmanEndpoint> {
  const workflow = getZealmanWorkflow(modelKey);
  const [health, comfy, template] = await Promise.all([
    client.get(`${baseUrl}/api/health`, { timeout: 10_000 }),
    client.get(`${baseUrl}/api/comfy/status`, { timeout: 10_000 }),
    fetchZealmanExecutionTemplate(baseUrl, modelKey, client),
  ]);
  const status = Number(health.status || 200);
  if (status < 200 || status >= 300) throw new Error("Zealman health API is unavailable");
  const comfyData = comfy.data?.data || comfy.data || {};
  if (comfyData.running !== true && comfyData.status !== "running") throw new Error("Zealman instance ComfyUI is not running");
  const inspected = inspectZealmanWorkflow(template, modelKey);
  return { url: baseUrl, ...inspected };
}

function mimeFromPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  return ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac" }[ext] || "application/octet-stream");
}

export async function uploadZealmanReferences(baseUrl: string, references: ZealmanReference[], client: HttpPost = axios) {
  const uploaded: Record<string, string> = {};
  for (const item of references) {
    const buffer = await fs.readFile(item.filePath);
    const form = new FormData();
    form.append("file", buffer, { filename: path.basename(item.filePath), contentType: mimeFromPath(item.filePath) });
    const response = await client.post(`${baseUrl}/api/comfy/upload/file`, form, { headers: form.getHeaders(), timeout: 180_000 });
    const name = String(response.data?.name || response.data?.data?.name || "").trim();
    if (!name) throw new Error(`Zealman upload returned no file name for ${path.basename(item.filePath)}`);
    uploaded[item.filePath] = name;
  }
  return uploaded;
}

export function buildZealmanExecutionTemplate(
  templateValue: unknown,
  modelKey: string,
  input: ZealmanInput,
  uploaded: Record<string, string>,
  executionOverrides: ZealmanExecutionOverrides = {},
  qualityDefinitions: Partial<ZealmanQualityParameterDefinitions> = {},
) {
  const template = cloneTemplate(asTemplate(templateValue));
  const typedKey = modelFromKey(modelKey);
  const { prompt, byType, dimensions } = validateInput(input);
  const { id: h3NodeId, node: h3 } = findH3Node(template);
  const qualityBindings = applyZealmanExecutionOverrides(template, typedKey, executionOverrides, qualityDefinitions);
  const bindings = resolveBindings(template, h3);
  const execution = resolveExecutionNodes(template, h3);
  const uploadedNames: Record<string, string> = {};
  for (const binding of bindings) {
    const reference = byType[binding.type][binding.index];
    if (!reference) {
      delete h3.inputs![binding.h3Field];
      continue;
    }
    const uploadedName = String(uploaded[reference.filePath] || "").trim();
    if (!uploadedName) throw new Error(`Zealman ${binding.type} upload is missing for ${path.basename(reference.filePath)}`);
    template[binding.nodeId].inputs![binding.inputName] = uploadedName;
    uploadedNames[binding.h3Field] = uploadedName;
  }
  template[execution.promptNodeId].inputs!.prompt = prompt;
  template[execution.durationNodeId].inputs!.value = input.duration;
  template[execution.latentNodeId].inputs![CUSTOM_WIDTH] = dimensions.width;
  template[execution.latentNodeId].inputs![CUSTOM_HEIGHT] = dimensions.height;
  const contract: ExecutionContract = {
    modelKey: typedKey,
    h3NodeId,
    bindings,
    ...execution,
    uploadedNames,
    prompt,
    duration: input.duration,
    ...dimensions,
    executionOverrides: { ...executionOverrides },
    qualityBindings,
  };
  assertZealmanExecutionPrompt(template, contract);
  return { workflowTemplate: template, contract };
}

export function assertZealmanExecutionPrompt(promptValue: unknown, contract: ExecutionContract) {
  const prompt = asTemplate(promptValue);
  const h3 = prompt[contract.h3NodeId];
  if (!h3?.inputs) throw new Error("Zealman returned prompt without the expected H3 node");
  for (const binding of contract.bindings) {
    const expected = contract.uploadedNames[binding.h3Field];
    if (!expected) {
      if (binding.h3Field in h3.inputs) throw new Error(`Zealman execution prompt retained unused reference ${binding.h3Field}`);
      continue;
    }
    const link = asLink(h3.inputs[binding.h3Field]);
    if (!link || link[0] !== binding.nodeId) throw new Error(`Zealman execution prompt rewrote reference ${binding.h3Field}`);
    if (prompt[binding.nodeId]?.inputs?.[binding.inputName] !== expected) throw new Error(`Zealman execution prompt changed uploaded ${binding.type} reference ${binding.h3Field}`);
  }
  if (prompt[contract.promptNodeId]?.inputs?.prompt !== contract.prompt) throw new Error("Zealman execution prompt changed the video prompt");
  if (prompt[contract.durationNodeId]?.inputs?.value !== contract.duration) throw new Error("Zealman execution prompt changed the duration");
  if (prompt[contract.latentNodeId]?.inputs?.[CUSTOM_WIDTH] !== contract.width || prompt[contract.latentNodeId]?.inputs?.[CUSTOM_HEIGHT] !== contract.height) {
    throw new Error("Zealman execution prompt changed the dimensions");
  }
  for (const [key, expected] of Object.entries(contract.executionOverrides)) {
    const target = contract.qualityBindings[key as ZealmanQualityParameterKey];
    if (key === "superResolution" && target?.rtxSuperResolution) {
      const rtx = target.rtxSuperResolution;
      if (expected === true) {
        if (!prompt[rtx.nodeId]) throw new Error("Zealman execution prompt removed configured RTX super-resolution");
        for (const consumer of rtx.consumers) {
          if (asLink(prompt[consumer.nodeId]?.inputs?.[consumer.inputName])?.[0] !== rtx.nodeId) {
            throw new Error("Zealman execution prompt changed configured RTX super-resolution output chain");
          }
        }
      } else if (expected === false) {
        if (prompt[rtx.nodeId]) throw new Error("Zealman execution prompt retained disabled RTX super-resolution");
        for (const consumer of rtx.consumers) {
          const link = asLink(prompt[consumer.nodeId]?.inputs?.[consumer.inputName]);
          if (!link || link[0] !== rtx.source[0] || link[1] !== rtx.source[1]) {
            throw new Error("Zealman execution prompt did not restore the RTX super-resolution source");
          }
        }
      }
      continue;
    }
    if (!target || prompt[target.nodeId]?.inputs?.[target.inputName] !== expected) {
      throw new Error(`Zealman execution prompt changed configured execution parameter: ${key}`);
    }
  }
}

export async function submitZealmanVideo(
  baseUrl: string,
  modelKey: string,
  input: ZealmanInput,
  client: HttpClient = axios,
  executionOverrides: ZealmanExecutionOverrides = {},
  qualityDefinitions: Partial<ZealmanQualityParameterDefinitions> = {},
) {
  const workflow = getZealmanWorkflow(modelKey);
  const [sourceTemplate, modelScan] = await Promise.all([
    fetchZealmanExecutionTemplate(baseUrl, modelKey, client),
    client.get(`${baseUrl}/api/models/scan`, { timeout: 30_000 }),
  ]);
  const discoveredDefinitions = deriveZealmanQualityParameterDefinitions(sourceTemplate, modelScan.data?.data || modelScan.data);
  const uploaded = await uploadZealmanReferences(baseUrl, input.references, client);
  const built = buildZealmanExecutionTemplate(
    sourceTemplate,
    modelKey,
    input,
    uploaded,
    executionOverrides,
    { ...discoveredDefinitions, ...qualityDefinitions },
  );
  const response = await client.post(`${baseUrl}/api/workflow/generate`, {
    workflow_template: built.workflowTemplate,
    client_id: `toonflow-${crypto.randomUUID()}`,
  }, { timeout: 180_000 });
  const promptId = String(response.data?.prompt_id || response.data?.data?.prompt_id || "").trim();
  if (!promptId) throw new Error("Zealman workflow submission returned no prompt_id");
  const actualPrompt = response.data?.prompt || response.data?.data?.prompt;
  if (!actualPrompt) throw new Error("Zealman workflow submission returned no execution prompt for contract verification");
  assertZealmanExecutionPrompt(actualPrompt, built.contract);
  return { promptId, workflowId: workflow.workflowId, workflowHash: normalizedWorkflowHash(sourceTemplate, modelKey) };
}

type ZealmanPollOptions = { audio?: boolean };
export type ZealmanPendingTaskProbe = {
  queueIdle: boolean;
  historyHasPrompt: boolean;
  rawOutput: string;
};

export type ZealmanAvailabilityProbe = {
  unavailable: boolean;
  healthReachable: boolean;
  comfyReachable: boolean;
  rawOutput: string;
};

function isHttpGet(value: unknown): value is HttpGet {
  return Boolean(value && typeof (value as HttpGet).get === "function");
}

function hasPromptInHistory(value: unknown, promptId: string) {
  const data = (value as any)?.data ?? value;
  if (!data || typeof data !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(data, promptId)) return true;
  const nested = (data as any).history;
  return Boolean(nested && typeof nested === "object" && Object.prototype.hasOwnProperty.call(nested, promptId));
}

export async function inspectZealmanPendingTask(baseUrl: string, promptId: string, client: HttpGet = axios): Promise<ZealmanPendingTaskProbe> {
  const [queueResponse, historyResponse] = await Promise.all([
    client.get(`${baseUrl}/api/comfy/queue-status`, { timeout: 30_000 }),
    client.get(`${baseUrl}/api/comfy/proxy/history`, { params: { prompt_id: promptId }, timeout: 30_000 }),
  ]);
  const queue = queueResponse.data?.data || queueResponse.data || {};
  const history = historyResponse.data?.data ?? historyResponse.data;
  const queueIdle = queue.busy === false && Number(queue.running_count || 0) === 0 && Number(queue.pending_count || 0) === 0;
  const historyHasPrompt = hasPromptInHistory(history, promptId);
  return {
    queueIdle,
    historyHasPrompt,
    rawOutput: JSON.stringify({
      zealmanPendingProbe: {
        promptId,
        queue: { busy: queue.busy, running_count: queue.running_count, pending_count: queue.pending_count },
        historyHasPrompt,
      },
    }),
  };
}

function reportsComfyUnavailable(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") {
    return /comfyui.{0,24}(unreachable|offline|unavailable|not\s+running|stopped)|(?:unreachable|offline|unavailable).{0,24}comfyui/i.test(value);
  }
  if (Array.isArray(value)) return value.some(reportsComfyUnavailable);
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.comfyui === false || record.reachable === false || record.running === false || record.available === false) return true;
  const status = String(record.status || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["stopped", "offline", "unavailable", "not_running", "error", "failed"].includes(status)) return true;
  return Object.entries(record).some(([key, item]) =>
    /error|status|reason|message|comfy/i.test(key) && reportsComfyUnavailable(item),
  );
}

export async function inspectZealmanAvailability(
  baseUrl: string,
  client: HttpGet = axios,
): Promise<ZealmanAvailabilityProbe> {
  const [health, comfy] = await Promise.allSettled([
    client.get(`${baseUrl}/api/health`, { timeout: 10_000 }),
    client.get(`${baseUrl}/api/comfy/status`, { timeout: 10_000 }),
  ]);
  const healthReachable = health.status === "fulfilled";
  const comfyReachable = comfy.status === "fulfilled";
  const healthData = healthReachable ? health.value.data : undefined;
  const comfyData = comfyReachable ? comfy.value.data : undefined;
  const unavailable =
    (!healthReachable && !comfyReachable) ||
    reportsComfyUnavailable(healthData) ||
    reportsComfyUnavailable(comfyData);
  const diagnostic = {
    zealmanAvailabilityProbe: {
      healthReachable,
      comfyReachable,
      unavailable,
      health: healthReachable ? healthData : String((health as PromiseRejectedResult).reason?.message || (health as PromiseRejectedResult).reason),
      comfy: comfyReachable ? comfyData : String((comfy as PromiseRejectedResult).reason?.message || (comfy as PromiseRejectedResult).reason),
    },
  };
  return { unavailable, healthReachable, comfyReachable, rawOutput: JSON.stringify(diagnostic) };
}

export async function pollZealmanVideo(baseUrl: string, promptId: string, optionsOrClient: ZealmanPollOptions | HttpGet = {}, maybeClient?: HttpGet) {
  const client = isHttpGet(optionsOrClient) ? optionsOrClient : maybeClient || axios;
  const response = await client.get(`${baseUrl}/api/workflow/result`, { params: { prompt_id: promptId }, timeout: 30_000 });
  const data = response.data?.data || response.data || {};
  if (data.pending === true) return { state: "pending" as const, rawOutput: JSON.stringify(data) };
  if (data.success === false || data.error) return { state: "failed" as const, error: String(data.error?.message || data.error || data.message || "Zealman video generation failed"), rawOutput: JSON.stringify(data) };
  const isVideoResult = (item: any) => {
    if (!item?.url) return false;
    if (item.type === "video") return true;
    const source = String(item.url || item.raw?.filename || "");
    return /\.(mp4|mov|webm|mkv|avi)(?:[?#]|$)/i.test(source);
  };
  // Zealman may label a SaveVideo output as "image" even when its URL is an MP4.
  // The downloadable media URL is the transport contract; do not reject a completed video on that label alone.
  const videos = (Array.isArray(data.results) ? data.results : []).filter(isVideoResult);
  const urls = videos.map((item: any) => new URL(String(item.url), `${baseUrl}/`).toString());
  if (!urls.length) {
    return { state: "failed" as const, error: "Zealman completed without a downloadable video result", rawOutput: JSON.stringify(data) };
  }
  // A Zealman SaveVideo result can be a muxed MP4 without an `-audio` suffix.
  // Preserve every completed video candidate; the user selects the desired one in the workbench.
  return { state: "success" as const, urls, rawOutput: JSON.stringify(data) };
}

// Compatibility aliases used by existing queue callers during the migration.
export const pollZealmanU06 = pollZealmanVideo;
