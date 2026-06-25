import u from "@/utils";
import { toTaskStatus, type TaskStatus } from "@/lib/taskStatus";

export type ImageFlowTargetType = "deriveAsset" | "storyboard";
type HistorySource = "image-flow" | "storyboard" | "asset";
export const DERIVE_ASSET_DEFAULT_RATIO = "16:9";

export interface ImageFlowTarget {
  projectId?: number;
  scriptId?: number;
  targetType?: ImageFlowTargetType;
  targetId?: number;
}

export interface SaveImageFlowInput extends ImageFlowTarget {
  flowId?: number | null;
  nodes: any[];
  edges: any[];
  selectedImageUrl?: string;
  selectedMediaPath?: string;
}

export interface EnsureDeriveAssetImageFlowInput {
  projectId: number;
  scriptId: number;
  targetId: number;
  model?: string;
  quality?: string;
  ratio?: string;
}

export interface EnsuredDeriveAssetImageFlow {
  flowId: number;
  nodeId: string;
  prompt: string;
  model: string;
  quality: string;
  ratio: string;
  referenceMediaPaths: string[];
}

export class ImageFlowValidationError extends Error {
  issues: Array<{ path: string; message: string }>;

  constructor(issues: Array<{ path: string; message: string }>) {
    super("图片画布数据校验失败");
    this.name = "ImageFlowValidationError";
    this.issues = issues;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function stripUrl(url: unknown): string {
  return typeof url === "string" && url ? u.replaceUrl(url.split(/[?#]/, 1)[0]) : "";
}

function stripMediaRef(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return stripUrl(value);
  return stripUrl(value.path || value.url || value.previewUrl);
}

function selectedInputPath(input: SaveImageFlowInput): string {
  return stripUrl(input.selectedMediaPath ?? input.selectedImageUrl);
}

function hasExplicitSelection(input: SaveImageFlowInput): boolean {
  return input.selectedMediaPath !== undefined || input.selectedImageUrl !== undefined;
}

function parseStoredFlow(value: unknown): any {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return {
      ...parsed,
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

function normalizePrompt(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRatio(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function selectPrimaryGeneratedNode(nodes: any[]): any | null {
  const generatedNodes = nodes.filter((node) => node?.type === "generated");
  if (!generatedNodes.length) return null;
  const primary = generatedNodes.find((node) => node?.data?.isPrimary === true) || generatedNodes.at(-1);
  for (const node of generatedNodes) {
    node.data = { ...(node.data || {}), isPrimary: node.id === primary.id };
  }
  return primary;
}

function collectPrimaryReferences(flow: any, primary: any): string[] {
  const paths = new Set<string>();
  const append = (value: unknown) => {
    const path = stripMediaRef(value) || stripUrl(value);
    if (path) paths.add(path);
  };
  for (const item of primary?.data?.references || []) append(item?.media || item?.image || item?.previewImage);
  const nodeMap = new Map((flow.nodes || []).map((node: any) => [node.id, node]));
  for (const edge of flow.edges || []) {
    if (edge?.target !== primary?.id) continue;
    const source: any = nodeMap.get(edge.source);
    if (source?.type === "upload") append(source.data?.media || source.data?.image || source.data?.previewImage);
    if (source?.type === "directorStage") {
      for (const item of source.data?.references || source.data?.assets || []) {
        append(item?.media || item?.image || item?.previewImage || item?.filePath);
      }
    }
  }
  return [...paths];
}

function pathsEqual(left: unknown, right: unknown): boolean {
  const a = stripUrl(left);
  const b = stripUrl(right);
  return Boolean(a && b && a === b);
}

function parseJsonObject(value: unknown): any {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractMediaPath(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return stripUrl(value);
  for (const key of ["media", "resultMedia", "selectedMedia", "image", "result", "data"]) {
    const nested = extractMediaPath(value[key]);
    if (nested) return nested;
  }
  for (const key of ["path", "filePath", "url", "src", "imageUrl", "previewUrl"]) {
    const path = stripUrl(value[key]);
    if (path) return path;
  }
  return "";
}

function historySortValue(item: any): number {
  return Number(item.sortTime ?? item.createTime ?? item.updateTime ?? item.id ?? 0) || 0;
}

async function toHistoryItem(input: {
  id: string | number;
  source: HistorySource;
  sourceId?: string | number;
  path: string;
  prompt?: string;
  model?: string;
  ratio?: string;
  quality?: string;
  createTime?: number;
  updateTime?: number;
  status?: TaskStatus;
  taskId?: string;
  legacyTaskId?: number;
}) {
  const media = await u.mediaRef.toMediaRef(input.path, {
    id: input.id,
    source: input.source === "asset" ? "assets" : input.source === "storyboard" ? "storyboard" : "generated",
    sourceId: input.sourceId ?? input.id,
  });
  if (!media) return null;
  return {
    id: input.id,
    historyId: input.id,
    source: input.source,
    media,
    url: media.url || "",
    previewUrl: media.previewUrl || "",
    prompt: input.prompt || "",
    model: input.model || "",
    ratio: input.ratio || "",
    quality: input.quality || "",
    createTime: input.createTime ?? input.updateTime ?? null,
    updateTime: input.updateTime ?? input.createTime ?? null,
    status: input.status,
    taskId: input.taskId,
    legacyTaskId: input.legacyTaskId,
    sortTime: input.updateTime ?? input.createTime ?? 0,
  };
}

function dedupeAndSortHistory(items: any[]) {
  const byPath = new Map<string, any>();
  for (const item of items) {
    const path = stripMediaRef(item.media) || stripUrl(item.url);
    if (!path) continue;
    const existing = byPath.get(path);
    if (!existing || historySortValue(item) > historySortValue(existing)) byPath.set(path, item);
  }
  return [...byPath.values()]
    .sort((a, b) => historySortValue(b) - historySortValue(a) || String(b.id).localeCompare(String(a.id)))
    .map(({ sortTime, ...item }) => item);
}

function cleanFlowNodes(nodes: any[]): any[] {
  return clone(nodes).map((node: any) => {
    if (node.type === "upload") {
      const mediaPath = stripMediaRef(node.data?.media) || stripUrl(node.data?.image);
      node.data.image = mediaPath;
      node.data.previewImage = stripUrl(node.data?.previewImage) || mediaPath;
      return node;
    }
    if (node.type !== "generated") return node;

    node.data.generatedImage = stripMediaRef(node.data?.resultMedia) || stripUrl(node.data?.generatedImage);
    node.data.references = (node.data?.references || []).map((item: any) => ({
      ...item,
      image: stripMediaRef(item.media) || stripUrl(item.image),
      previewImage: stripUrl(item.previewImage) || stripMediaRef(item.media) || stripUrl(item.image),
    }));
    if (node.data?.selectedResult?.media || node.data?.selectedResult?.url) {
      node.data.selectedResult.url = stripMediaRef(node.data.selectedResult.media) || stripUrl(node.data.selectedResult.url);
      delete node.data.selectedResult.media;
    }
    return node;
  });
}

const ACTIVE_STATUSES = new Set<TaskStatus>(["queued", "submitting", "processing"]);
const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled"]);
const TASK_OWNED_FIELDS = ["taskId", "status", "state", "reason", "generatedImage", "historyId", "selectedResult"] as const;

function hasGeneratedImage(data: any): boolean {
  return Boolean(data?.resultMedia || data?.generatedImage || data?.selectedResult?.media || data?.selectedResult?.url);
}

function nodeStatus(data: any): TaskStatus | undefined {
  return data?.status || toTaskStatus(data?.state);
}

function taskStatus(task: any): TaskStatus {
  return task?.status || toTaskStatus(task?.state) || "processing";
}

function taskOwnedSnapshot(task: any): Record<string, unknown> {
  const status = taskStatus(task);
  const active = ACTIVE_STATUSES.has(status);
  const completed = status === "completed";
  const snapshot: Record<string, unknown> = {
    taskId: active ? task.id : null,
    status,
    state: active ? "generating" : completed ? "success" : status === "pending" ? "idle" : "failed",
    reason: task.reason || "",
  };
  if (completed && task.url) {
    snapshot.generatedImage = task.url;
    snapshot.historyId = task.id;
    snapshot.selectedResult = {
      id: task.id,
      url: task.url,
      prompt: task.prompt || "",
      model: task.model || "",
      ratio: task.ratio || "",
      quality: task.quality || "",
      createTime: task.createTime,
    };
  }
  return snapshot;
}

function copyTaskOwnedFields(target: any, source: any) {
  for (const field of TASK_OWNED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source || {}, field)) target[field] = clone(source[field]);
  }
}

function mergeGeneratedNode(submittedNode: any, storedNode: any, tasks: any[]) {
  const merged = clone(submittedNode);
  merged.data = { ...(submittedNode.data || {}) };
  const submittedData = submittedNode.data || {};
  const storedData = storedNode?.data || {};
  const exactTaskId = submittedData.taskId ?? storedData.taskId;
  const exactTask = exactTaskId != null ? tasks.find((task) => Number(task.id) === Number(exactTaskId)) : null;
  const activeTask = tasks.find((task) => ACTIVE_STATUSES.has(taskStatus(task)));

  if (activeTask) {
    copyTaskOwnedFields(merged.data, storedData);
    Object.assign(merged.data, taskOwnedSnapshot(activeTask));
    return merged;
  }

  const storedStatus = nodeStatus(storedData);
  const submittedStatus = nodeStatus(submittedData);
  const storedTerminal = storedStatus && TERMINAL_STATUSES.has(storedStatus);
  const submittedLooksStale =
    submittedStatus === "pending" || (submittedStatus != null && ACTIVE_STATUSES.has(submittedStatus)) || !hasGeneratedImage(submittedData);

  if (storedNode && storedTerminal && submittedLooksStale) {
    copyTaskOwnedFields(merged.data, storedData);
    return merged;
  }

  if (exactTask) {
    Object.assign(merged.data, taskOwnedSnapshot(exactTask));
    return merged;
  }

  if (submittedStatus && TERMINAL_STATUSES.has(submittedStatus)) merged.data.taskId = null;
  return merged;
}

async function mergeFlowForSave(trx: any, flowId: number, submittedNodes: any[], submittedEdges: any[]) {
  const row = await trx("o_imageFlow").where("id", flowId).first();
  if (!row?.flowData) throw new Error("图片画布不存在");

  const storedFlow = parseStoredFlow(row.flowData);
  const storedNodes: any[] = Array.isArray(storedFlow.nodes) ? storedFlow.nodes : [];
  const storedEdges: any[] = Array.isArray(storedFlow.edges) ? storedFlow.edges : [];
  const tasks = await trx("o_editImageTask").where("flowId", flowId).orderBy("createTime", "desc");
  const tasksByNode = new Map<string, any[]>();
  for (const task of tasks) {
    if (!task.nodeId) continue;
    const list = tasksByNode.get(task.nodeId) || [];
    list.push(task);
    tasksByNode.set(task.nodeId, list);
  }

  const storedById = new Map(storedNodes.map((node) => [node.id, node]));
  const mergedNodes = submittedNodes.map((node) =>
    node.type === "generated" ? mergeGeneratedNode(node, storedById.get(node.id), tasksByNode.get(node.id) || []) : clone(node),
  );
  const mergedIds = new Set(mergedNodes.map((node) => node.id));
  const activeOmittedIds = new Set<string>();

  for (const storedNode of storedNodes) {
    if (storedNode.type !== "generated" || mergedIds.has(storedNode.id)) continue;
    const tasksForNode = tasksByNode.get(storedNode.id) || [];
    const activeTask = tasksForNode.find((task) => ACTIVE_STATUSES.has(taskStatus(task)));
    const storedActive = ACTIVE_STATUSES.has(nodeStatus(storedNode.data) || "pending") && storedNode.data?.taskId;
    if (activeTask || storedActive) activeOmittedIds.add(storedNode.id);
  }

  if (activeOmittedIds.size) {
    const relatedIds = new Set(activeOmittedIds);
    for (const edge of storedEdges) {
      if (activeOmittedIds.has(edge.source) || activeOmittedIds.has(edge.target)) {
        relatedIds.add(edge.source);
        relatedIds.add(edge.target);
      }
    }
    for (const storedNode of storedNodes) {
      if (!relatedIds.has(storedNode.id) || mergedIds.has(storedNode.id)) continue;
      const tasksForNode = tasksByNode.get(storedNode.id) || [];
      mergedNodes.push(
        storedNode.type === "generated"
          ? mergeGeneratedNode(storedNode, storedNode, tasksForNode)
          : clone(storedNode),
      );
      mergedIds.add(storedNode.id);
    }
  }

  const edgeKeys = new Set<string>();
  const mergedEdges: any[] = [];
  const appendEdge = (edge: any) => {
    if (!mergedIds.has(edge.source) || !mergedIds.has(edge.target)) return;
    const key = edge.id || `${edge.source}->${edge.target}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    mergedEdges.push(clone(edge));
  };
  submittedEdges.forEach(appendEdge);
  storedEdges
    .filter((edge) => activeOmittedIds.has(edge.source) || activeOmittedIds.has(edge.target))
    .forEach(appendEdge);

  return { nodes: mergedNodes, edges: mergedEdges };
}

async function originalUrl(value: unknown): Promise<string> {
  const filePath = stripUrl(value);
  return filePath ? u.oss.getFileUrl(filePath) : "";
}

async function previewUrl(value: unknown): Promise<string> {
  const filePath = stripUrl(value);
  return filePath ? u.oss.getSmallImageUrl(filePath) : "";
}

async function resolveFlowNodes(nodes: any[]): Promise<any[]> {
  return Promise.all(
    clone(nodes).map(async (node: any) => {
      if (node.type === "upload") {
        const sourcePath = node.data?.image || node.data?.previewImage;
        node.data.image = await originalUrl(sourcePath);
        node.data.previewImage = await previewUrl(node.data?.previewImage || sourcePath);
        return node;
      }
      if (node.type !== "generated") return node;

      node.data.generatedImage = await originalUrl(node.data?.generatedImage);
      node.data.references = await Promise.all(
        (node.data?.references || []).map(async (item: any) => ({
          ...item,
          image: await originalUrl(item.image || item.previewImage),
          previewImage: await previewUrl(item.previewImage || item.image),
        })),
      );
      if (node.data?.selectedResult?.url) {
        node.data.selectedResult.url = await originalUrl(node.data.selectedResult.url);
      }
      return node;
    }),
  );
}

async function findFlowTarget(trx: any, flowId: number): Promise<ImageFlowTarget | null> {
  const storyboard = await trx("o_storyboard")
    .where("flowId", flowId)
    .first("id as targetId", "projectId", "scriptId");
  if (storyboard) return { ...storyboard, targetType: "storyboard" };
  const asset = await trx("o_assets").where("flowId", flowId).first("id as targetId", "projectId");
  if (asset) return { ...asset, targetType: "deriveAsset" };
  return null;
}

function assertSameTarget(current: ImageFlowTarget | null, requested: ImageFlowTarget) {
  if (!current?.targetType || current.targetId == null || !requested.targetType || requested.targetId == null) return;
  if (current.targetType !== requested.targetType || Number(current.targetId) !== Number(requested.targetId)) {
    throw new ImageFlowValidationError([
      { path: "flowId", message: "该画布已绑定到其他资产或分镜，禁止跨目标覆盖" },
    ]);
  }
}

async function validateTargetOwnership(trx: any, target: ImageFlowTarget) {
  if (!target.targetType || target.targetId == null) return;
  if (target.targetType === "storyboard") {
    const row = await trx("o_storyboard").where("id", target.targetId).first("id", "projectId", "scriptId");
    if (!row) {
      throw new ImageFlowValidationError([{ path: "targetId", message: "目标分镜不存在" }]);
    }
    const issues: Array<{ path: string; message: string }> = [];
    if (target.projectId != null && Number(row.projectId) !== Number(target.projectId)) {
      issues.push({ path: "projectId", message: "目标分镜不属于当前项目" });
    }
    if (target.scriptId != null && Number(row.scriptId) !== Number(target.scriptId)) {
      issues.push({ path: "scriptId", message: "目标分镜不属于当前剧集" });
    }
    if (issues.length) throw new ImageFlowValidationError(issues);
    return;
  }
  const row = await trx("o_assets").where("id", target.targetId).first("id", "projectId");
  if (!row) throw new ImageFlowValidationError([{ path: "targetId", message: "目标衍生资产不存在" }]);
  if (target.projectId != null && Number(row.projectId) !== Number(target.projectId)) {
    throw new ImageFlowValidationError([{ path: "projectId", message: "目标衍生资产不属于当前项目" }]);
  }
}

async function validateDeriveAssetScope(
  db: any,
  input: Pick<EnsureDeriveAssetImageFlowInput, "projectId" | "scriptId" | "targetId">,
) {
  const script = await db("o_script").where({ id: input.scriptId, projectId: input.projectId }).first("id");
  if (!script) {
    throw new ImageFlowValidationError([{ path: "scriptId", message: "当前剧集不属于该项目" }]);
  }
  const asset = await db("o_assets")
    .where({ "o_assets.id": input.targetId, "o_assets.projectId": input.projectId })
    .leftJoin("o_assets as parent", "parent.id", "o_assets.assetsId")
    .leftJoin("o_image as assetImage", "assetImage.id", "o_assets.imageId")
    .leftJoin("o_image as parentImage", "parentImage.id", "parent.imageId")
    .first(
      "o_assets.id",
      "o_assets.assetsId",
      "o_assets.type",
      "o_assets.prompt",
      "o_assets.flowId",
      "assetImage.filePath as assetImagePath",
      "parent.id as parentId",
      "parent.projectId as parentProjectId",
      "parentImage.filePath as parentImagePath",
    );
  if (!asset || asset.assetsId == null) {
    throw new ImageFlowValidationError([{ path: "targetId", message: "目标衍生资产不存在" }]);
  }
  if (!asset.parentId || Number(asset.parentProjectId) !== Number(input.projectId)) {
    throw new ImageFlowValidationError([{ path: "targetId", message: "父资产不属于当前项目" }]);
  }
  return asset;
}

function createDefaultGeneratedNode(input: EnsureDeriveAssetImageFlowInput, asset: any) {
  return {
    id: `derive-generated:${u.uuid()}`,
    type: "generated",
    position: { x: 700, y: 100 },
    data: {
      generatedImage: asset.assetImagePath || "",
      references: [],
      prompt: normalizePrompt(asset.prompt),
      model: input.model || "",
      ratio: normalizeRatio(input.ratio) || DERIVE_ASSET_DEFAULT_RATIO,
      quality: input.quality || "",
      status: asset.assetImagePath ? "completed" : "pending",
      state: asset.assetImagePath ? "success" : "idle",
      reason: "",
      isPrimary: true,
    },
  };
}

export async function ensureDeriveAssetImageFlow(
  input: EnsureDeriveAssetImageFlowInput,
): Promise<EnsuredDeriveAssetImageFlow> {
  return u.db.transaction(async (trx: any) => {
    const asset = await validateDeriveAssetScope(trx, input);
    let flowId = asset.flowId ? Number(asset.flowId) : null;
    const shouldInitializeParentReference = !flowId;
    let flow: any;
    if (flowId) {
      const row = await trx("o_imageFlow").where("id", flowId).first("flowData");
      if (!row?.flowData) {
        throw new ImageFlowValidationError([{ path: "flowId", message: "衍生资产绑定的图片画布不存在" }]);
      }
      flow = parseStoredFlow(row.flowData);
      const requested = { projectId: input.projectId, targetType: "deriveAsset" as const, targetId: input.targetId };
      assertSameTarget(
        { projectId: flow.projectId, targetType: flow.targetType, targetId: flow.targetId },
        requested,
      );
      assertSameTarget(await findFlowTarget(trx, flowId), requested);
      if (flow.projectId != null && Number(flow.projectId) !== Number(input.projectId)) {
        throw new ImageFlowValidationError([{ path: "projectId", message: "图片画布不属于当前项目" }]);
      }
    } else {
      flow = {
        projectId: input.projectId,
        scriptId: input.scriptId,
        targetType: "deriveAsset",
        targetId: input.targetId,
        selectedImageUrl: asset.assetImagePath || "",
        nodes: [],
        edges: [],
      };
    }

    let primary = selectPrimaryGeneratedNode(flow.nodes);
    if (!primary) {
      primary = createDefaultGeneratedNode(input, asset);
      flow.nodes.push(primary);
    }
    const parentImagePath = stripMediaRef(asset.parentImagePath);
    const hasParentUpload = (flow.nodes || []).some((node: any) => {
      if (node?.type !== "upload") return false;
      if (Number(node.data?.sourceId) === Number(asset.parentId)) return true;
      const nodePath = stripMediaRef(node.data?.media || node.data?.image || node.data?.previewImage);
      return Boolean(parentImagePath && nodePath && nodePath === parentImagePath);
    });
    if (shouldInitializeParentReference && asset.parentImagePath && !hasParentUpload) {
      const upload = {
        id: `derive-upload:${u.uuid()}`,
        type: "upload",
        position: { x: 100, y: 100 },
        data: {
          image: asset.parentImagePath,
          previewImage: asset.parentImagePath,
          source: "asset",
          sourceId: asset.parentId,
        },
      };
      flow.nodes.push(upload);
      flow.edges.push({
        id: `derive-edge:${u.uuid()}`,
        source: upload.id,
        target: primary.id,
        type: "removeLine",
        animated: true,
        style: { stroke: "#00000" },
      });
    }

    primary.data = {
      ...(primary.data || {}),
      prompt: normalizePrompt(primary.data?.prompt) || normalizePrompt(asset.prompt),
      model: primary.data?.model || input.model || "",
      quality: primary.data?.quality || input.quality || "",
      ratio: normalizeRatio(primary.data?.ratio) || normalizeRatio(input.ratio) || DERIVE_ASSET_DEFAULT_RATIO,
      isPrimary: true,
    };
    if (!primary.data.prompt) throw new Error("请先填写生图提示语");
    if (!primary.data.model) throw new Error("请先配置图片模型");
    if (!primary.data.quality) throw new Error("请先配置图片清晰度");
    if (!primary.data.ratio) throw new Error("请先配置图片比例");

    flow.projectId = input.projectId;
    flow.targetType = "deriveAsset";
    flow.targetId = input.targetId;
    flow.nodes = cleanFlowNodes(flow.nodes);
    flow.edges = clone(flow.edges || []);
    if (flowId) {
      await trx("o_imageFlow").where("id", flowId).update({ flowData: JSON.stringify(flow) });
    } else {
      const [insertedId] = await trx("o_imageFlow").insert({ flowData: JSON.stringify(flow) });
      flowId = Number(insertedId);
      await trx("o_assets").where({ id: input.targetId, projectId: input.projectId }).update({ flowId });
    }

    return {
      flowId,
      nodeId: primary.id,
      prompt: primary.data.prompt,
      model: primary.data.model,
      quality: primary.data.quality,
      ratio: primary.data.ratio,
      referenceMediaPaths: collectPrimaryReferences(flow, primary),
    };
  });
}

export async function updateDeriveAssetPrompt(
  db: any,
  input: { projectId: number; targetId: number; prompt: string; mode: "preserve" | "replace" },
) {
  const asset = await db("o_assets").where({ id: input.targetId, projectId: input.projectId }).first("id", "assetsId", "flowId");
  if (!asset || asset.assetsId == null) throw new Error("目标衍生资产不存在");
  if (!asset.flowId) {
    await db("o_assets").where({ id: input.targetId, projectId: input.projectId }).update({ prompt: input.prompt });
    return { flowId: null, nodeId: null };
  }
  const row = await db("o_imageFlow").where("id", asset.flowId).first("flowData");
  if (!row?.flowData) throw new ImageFlowValidationError([{ path: "flowId", message: "衍生资产绑定的图片画布不存在" }]);
  const flow = parseStoredFlow(row.flowData);
  if (flow.projectId != null && Number(flow.projectId) !== Number(input.projectId)) {
    throw new ImageFlowValidationError([{ path: "projectId", message: "图片画布不属于当前项目" }]);
  }
  const requested = { projectId: input.projectId, targetType: "deriveAsset" as const, targetId: input.targetId };
  assertSameTarget(
    { projectId: flow.projectId, targetType: flow.targetType, targetId: flow.targetId },
    requested,
  );
  assertSameTarget(await findFlowTarget(db, Number(asset.flowId)), requested);
  await db("o_assets").where({ id: input.targetId, projectId: input.projectId }).update({ prompt: input.prompt });
  const primary = selectPrimaryGeneratedNode(flow.nodes);
  if (!primary) return { flowId: Number(asset.flowId), nodeId: null };
  if (input.mode === "replace" || !normalizePrompt(primary.data?.prompt)) primary.data.prompt = input.prompt;
  await db("o_imageFlow").where("id", asset.flowId).update({ flowData: JSON.stringify(flow) });
  return { flowId: Number(asset.flowId), nodeId: primary.id };
}

export async function getDeriveAssetPromptSnapshot(
  db: any,
  input: { projectId: number; targetId: number; flowId?: number | null; fallbackPrompt?: string | null },
) {
  const fallback = normalizePrompt(input.fallbackPrompt);
  if (!input.flowId) return { prompt: fallback, nodeId: null };
  const row = await db("o_imageFlow").where("id", input.flowId).first("flowData");
  if (!row?.flowData) return { prompt: fallback, nodeId: null };
  const flow = parseStoredFlow(row.flowData);
  if (
    (flow.projectId != null && Number(flow.projectId) !== Number(input.projectId)) ||
    (flow.targetType && flow.targetType !== "deriveAsset") ||
    (flow.targetId != null && Number(flow.targetId) !== Number(input.targetId))
  ) {
    return { prompt: fallback, nodeId: null };
  }
  const primary = selectPrimaryGeneratedNode(flow.nodes);
  return {
    prompt: normalizePrompt(primary?.data?.prompt) || fallback,
    nodeId: primary?.id || null,
  };
}

async function isTargetHistoryImage(trx: any, target: ImageFlowTarget, selectedImageUrl: string): Promise<boolean> {
  if (!selectedImageUrl || !target.targetType || target.targetId == null) return false;
  const targetId = Number(target.targetId);
  const flowTasks = await trx("o_editImageTask")
    .whereNotNull("url")
    .where((builder: any) => {
      builder.where({ targetType: target.targetType, targetId });
      if (target.targetType === "deriveAsset") builder.orWhere("deriveAssetId", targetId);
    })
    .select("url");
  if (flowTasks.some((task: any) => taskStatus(task) === "completed" && pathsEqual(task.url, selectedImageUrl))) return true;

  if (target.targetType === "deriveAsset") {
    const images = await trx("o_image").where("assetsId", targetId).whereNotNull("filePath").select("filePath");
    return images.some((image: any) => pathsEqual(image.filePath, selectedImageUrl));
  }

  const storyboard = await trx("o_storyboard").where("id", targetId).first("filePath");
  if (pathsEqual(storyboard?.filePath, selectedImageUrl)) return true;
  const tasks = await trx("o_tasks")
    .where("businessType", "storyboard")
    .where("businessId", targetId)
    .select("resultJson");
  return tasks.some(
    (task: any) => taskStatus(task) === "completed" && pathsEqual(extractMediaPath(parseJsonObject(task.resultJson)), selectedImageUrl),
  );
}

async function normalizePrimaryNode(
  trx: any,
  flowId: number | null,
  nodes: any[],
  selectedImageUrl: string,
  target: ImageFlowTarget = {},
) {
  const generatedNodes = nodes.filter((node) => node.type === "generated");
  if (target.targetType === "deriveAsset") {
    for (const node of generatedNodes) {
      node.data ||= {};
      node.data.ratio = normalizeRatio(node.data.ratio) || DERIVE_ASSET_DEFAULT_RATIO;
    }
  }
  const marked = generatedNodes.filter((node) => node.data?.isPrimary === true);
  if (marked.length > 1) {
    throw new ImageFlowValidationError([
      { path: "nodes", message: "同一画布最多只能有一个主生成节点" },
    ]);
  }

  let selectedNode: any = null;
  let externalSelected = false;
  if (selectedImageUrl) {
    const directMatches = generatedNodes.filter(
      (node) =>
        pathsEqual(node.data?.generatedImage, selectedImageUrl) ||
        pathsEqual(node.data?.resultMedia?.path || node.data?.resultMedia?.url, selectedImageUrl) ||
        pathsEqual(node.data?.selectedResult?.media?.path || node.data?.selectedResult?.media?.url, selectedImageUrl) ||
        pathsEqual(node.data?.selectedResult?.url, selectedImageUrl),
    );
    if (directMatches.length > 1) {
      throw new ImageFlowValidationError([
        { path: "selectedImageUrl", message: "最终图片匹配到多个生成节点" },
      ]);
    }
    selectedNode = directMatches[0] || null;

    if (!selectedNode && flowId) {
      const tasks = await trx("o_editImageTask")
        .where("flowId", flowId)
        .whereNotNull("nodeId")
        .whereNotNull("url")
        .orderBy("createTime", "desc");
      const matchingTasks = tasks.filter((task: any) => pathsEqual(task.url, selectedImageUrl));
      const matchingNodeIds = [...new Set(matchingTasks.map((task: any) => task.nodeId))];
      if (matchingNodeIds.length === 1) {
        selectedNode = generatedNodes.find((node) => node.id === matchingNodeIds[0]) || null;
        const task = matchingTasks.find((item: any) => item.nodeId === matchingNodeIds[0]);
        if (selectedNode && task) {
          selectedNode.data = {
            ...(selectedNode.data || {}),
            ...taskOwnedSnapshot({ ...task, status: "completed", url: stripUrl(selectedImageUrl) }),
          };
        }
      }
    }
    if (!selectedNode && (generatedNodes.length || (target.targetType && target.targetId != null))) {
      externalSelected = await isTargetHistoryImage(trx, target, selectedImageUrl);
    }
    if (!selectedNode && !externalSelected && generatedNodes.length) {
      throw new ImageFlowValidationError([
        { path: "selectedImageUrl", message: "最终图片无法唯一对应到生成节点" },
      ]);
    }
  }

  if (!selectedNode && !externalSelected && selectedImageUrl && target.targetType && target.targetId != null) {
    throw new ImageFlowValidationError([
      { path: "selectedImageUrl", message: "最终图片不属于当前目标历史" },
    ]);
  }

  const primary = externalSelected ? marked[0] || null : selectedNode || marked[0] || (generatedNodes.length === 1 ? generatedNodes[0] : null);
  if (primary) {
    for (const node of generatedNodes) {
      node.data ||= {};
      node.data.isPrimary = node.id === primary.id;
    }
  }
  return nodes;
}

export async function bindImageFlowToStoryboard(
  trx: any,
  flowId: number,
  target: { projectId: number; scriptId: number; targetId: number; selectedImageUrl?: string },
) {
  const row = await trx("o_imageFlow").where("id", flowId).first();
  if (!row?.flowData) {
    throw new ImageFlowValidationError([{ path: "flowId", message: "图片画布不存在" }]);
  }
  const flow = parseStoredFlow(row.flowData);
  const storedTarget: ImageFlowTarget = {
    projectId: flow.projectId,
    scriptId: flow.scriptId,
    targetType: flow.targetType,
    targetId: flow.targetId,
  };
  assertSameTarget(storedTarget, { ...target, targetType: "storyboard" });
  const reverseTarget = await findFlowTarget(trx, flowId);
  assertSameTarget(reverseTarget, { ...target, targetType: "storyboard" });
  flow.projectId = target.projectId;
  flow.scriptId = target.scriptId;
  flow.targetType = "storyboard";
  flow.targetId = target.targetId;
  if (target.selectedImageUrl) flow.selectedImageUrl = stripUrl(target.selectedImageUrl);
  await trx("o_imageFlow").where("id", flowId).update({ flowData: JSON.stringify(flow) });
}

export async function updateImageFlowTarget(
  trx: any,
  target: ImageFlowTarget & { flowId: number; selectedImageUrl?: string },
): Promise<void> {
  const { targetType, targetId, flowId, selectedImageUrl = "" } = target;
  if (!targetType || !targetId) return;

  if (targetType === "deriveAsset") {
    const asset = await trx("o_assets").where("id", targetId).first("id", "imageId");
    if (!asset) throw new Error("衍生资产不存在");
    if (!selectedImageUrl) {
      await trx("o_assets").where("id", targetId).update({ flowId });
      return;
    }
    let imageId = asset.imageId;
    if (imageId) {
      const updated = await trx("o_image").where("id", imageId).update({
        filePath: stripUrl(selectedImageUrl),
        state: "已完成",
        assetsId: targetId,
      });
      if (!updated) imageId = null;
    }
    if (!imageId) {
      [imageId] = await trx("o_image").insert({
        filePath: stripUrl(selectedImageUrl),
        state: "已完成",
        assetsId: targetId,
      });
    }
    await trx("o_assets").where("id", targetId).update({ flowId, imageId });
    return;
  }

  const storyboard = await trx("o_storyboard").where("id", targetId).first("id");
  if (!storyboard) throw new Error("分镜不存在");
  const updateData: Record<string, unknown> = { flowId };
  if (selectedImageUrl) {
    updateData.filePath = stripUrl(selectedImageUrl);
    updateData.state = "已完成";
    updateData.shouldGenerateImage = 1;
  }
  await trx("o_storyboard").where("id", targetId).update(updateData);
}

export async function saveImageFlow(input: SaveImageFlowInput): Promise<number> {
  return u.db.transaction(async (trx: any) => {
    let flowId = input.flowId || null;
    if (flowId) {
      const existingRow = await trx("o_imageFlow").where("id", flowId).first();
      if (!existingRow?.flowData) {
        throw new ImageFlowValidationError([{ path: "flowId", message: "图片画布不存在" }]);
      }
      const existingFlow = parseStoredFlow(existingRow.flowData);
      assertSameTarget(
        {
          projectId: existingFlow.projectId,
          scriptId: existingFlow.scriptId,
          targetType: existingFlow.targetType,
          targetId: existingFlow.targetId,
        },
        input,
      );
      assertSameTarget(await findFlowTarget(trx, flowId), input);
      await validateTargetOwnership(trx, input);
      const merged = await mergeFlowForSave(trx, flowId, input.nodes, input.edges);
      const explicitSelection = hasExplicitSelection(input);
      const selectedImageUrl = explicitSelection ? selectedInputPath(input) : stripUrl(existingFlow.selectedImageUrl);
      await normalizePrimaryNode(trx, flowId, merged.nodes, explicitSelection ? selectedImageUrl : "", input);
      const flowData = JSON.stringify({
        ...existingFlow,
        projectId: input.projectId ?? existingFlow.projectId ?? null,
        scriptId:
          (input.targetType ?? existingFlow.targetType) === "deriveAsset"
            ? existingFlow.scriptId ?? input.scriptId ?? null
            : input.scriptId ?? existingFlow.scriptId ?? null,
        targetType: input.targetType ?? existingFlow.targetType ?? null,
        targetId: input.targetId ?? existingFlow.targetId ?? null,
        selectedImageUrl,
        nodes: cleanFlowNodes(merged.nodes),
        edges: clone(merged.edges),
      });
      const updated = await trx("o_imageFlow").where("id", flowId).update({ flowData });
      if (!updated) throw new ImageFlowValidationError([{ path: "flowId", message: "图片画布不存在" }]);
    } else {
      await validateTargetOwnership(trx, input);
      const selectedImageUrl = selectedInputPath(input);
      const nodes = clone(input.nodes);
      await normalizePrimaryNode(trx, null, nodes, selectedImageUrl, input);
      const flowData = JSON.stringify({
        projectId: input.projectId ?? null,
        scriptId: input.scriptId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        selectedImageUrl,
        nodes: cleanFlowNodes(nodes),
        edges: clone(input.edges),
      });
      const [insertedId] = await trx("o_imageFlow").insert({ flowData });
      flowId = Number(insertedId);
    }

    await updateImageFlowTarget(trx, {
      projectId: input.projectId,
      scriptId: input.scriptId,
      targetType: input.targetType,
      targetId: input.targetId,
      flowId,
      selectedImageUrl: input.selectedMediaPath ?? input.selectedImageUrl,
    });
    return flowId;
  });
}

export async function getImageFlow(flowId: number) {
  const row = await u.db("o_imageFlow").where("id", flowId).first();
  if (!row?.flowData) return null;
  const flow = parseStoredFlow(row.flowData);
  const reverseTarget = await findFlowTarget(u.db, flowId);
  const projectId = flow.projectId ?? reverseTarget?.projectId ?? null;
  const scriptId = flow.scriptId ?? reverseTarget?.scriptId ?? null;
  const targetType = flow.targetType ?? reverseTarget?.targetType ?? null;
  const targetId = flow.targetId ?? reverseTarget?.targetId ?? null;
  let selectedImagePath = stripUrl(flow.selectedImageUrl);
  if (!selectedImagePath && targetType === "storyboard" && targetId != null) {
    selectedImagePath =
      (await u.db("o_storyboard").where("id", targetId).first("filePath"))?.filePath || "";
  } else if (!selectedImagePath && targetType === "deriveAsset" && targetId != null) {
    selectedImagePath =
      (
        await u
          .db("o_assets")
          .leftJoin("o_image", "o_image.id", "o_assets.imageId")
          .where("o_assets.id", targetId)
          .first("o_image.filePath")
      )?.filePath || "";
  }
  return {
    ...flow,
    id: row.id,
    flowId: row.id,
    projectId,
    scriptId,
    targetType,
    targetId,
    selectedImageUrl: selectedImagePath ? await u.oss.getFileUrl(stripUrl(selectedImagePath)) : "",
    nodes: await resolveFlowNodes(flow.nodes || []),
    edges: flow.edges || [],
  };
}

export async function updateImageFlowNodeWithDb(
  db: any,
  flowId: number | null | undefined,
  nodeId: string,
  patch: Record<string, unknown>,
) {
  if (!flowId) return false;
  const row = await db("o_imageFlow").where("id", flowId).first();
  if (!row?.flowData) return false;
  const flow = JSON.parse(row.flowData);
  const node = (flow.nodes || []).find((item: any) => item.id === nodeId && item.type === "generated");
  if (!node) return false;
  node.data = { ...(node.data || {}), ...patch };
  await db("o_imageFlow").where("id", flowId).update({ flowData: JSON.stringify(flow) });
  return true;
}

export async function updateImageFlowNode(flowId: number | null | undefined, nodeId: string, patch: Record<string, unknown>) {
  return u.db.transaction((trx: any) => updateImageFlowNodeWithDb(trx, flowId, nodeId, patch));
}

export async function getLegacyImageFlowHistory(input: ImageFlowTarget & { deriveAssetId?: number }) {
  const targetType = input.targetType || (input.deriveAssetId ? "deriveAsset" : undefined);
  const targetId = input.targetId ?? input.deriveAssetId ?? null;
  const query = u
    .db("o_editImageTask")
    .where("projectId", input.projectId!)
    .where("scriptId", input.scriptId!)
    .where("state", "已完成")
    .whereNotNull("url")
    .orderBy("createTime", "desc")
    .select("id", "url", "prompt", "model", "quality", "ratio", "createTime");

  if (targetType && targetId != null) {
    query.andWhere((builder) => {
      builder.where({ targetType, targetId });
      if (targetType === "deriveAsset") builder.orWhere("deriveAssetId", targetId);
    });
  }

  const tasks = await query;
  return Promise.all(
    tasks.map(async (task: any) => {
      const media = await u.mediaRef.toMediaRef(task.url, {
        id: task.id,
        source: "generated",
        sourceId: task.id,
      });
      return {
        id: task.id,
        historyId: task.id,
        media,
        url: media?.url || "",
        prompt: task.prompt || "",
        model: task.model || "",
        ratio: task.ratio || "",
        quality: task.quality || "",
        createTime: task.createTime,
      };
    }),
  );
}

export async function getImageHistory(input: ImageFlowTarget & { deriveAssetId?: number }) {
  const targetType = input.targetType || (input.deriveAssetId ? "deriveAsset" : undefined);
  const targetId = input.targetId ?? input.deriveAssetId ?? null;
  const query = u
    .db("o_editImageTask")
    .where("projectId", input.projectId!)
    .where("scriptId", input.scriptId!)
    .whereNotNull("url")
    .orderBy("createTime", "desc")
    .select("*");

  if (targetType && targetId != null) {
    query.andWhere((builder) => {
      builder.where({ targetType, targetId });
      if (targetType === "deriveAsset") builder.orWhere("deriveAssetId", targetId);
    });
  }

  const historyItems: any[] = [];
  const flowTasks = (await query).filter((task: any) => taskStatus(task) === "completed");
  for (const task of flowTasks) {
    const item = await toHistoryItem({
      id: `image-flow:${task.id}`,
      source: "image-flow",
      sourceId: task.id,
      path: task.url || "",
      prompt: task.prompt || undefined,
      model: task.model || undefined,
      ratio: task.ratio || undefined,
      quality: task.quality || undefined,
      createTime: task.createTime ?? undefined,
      updateTime: task.updateTime ?? undefined,
      status: "completed",
      legacyTaskId: task.id,
    });
    if (item) historyItems.push(item);
  }

  if (targetType === "storyboard" && targetId != null) {
    const storyboard = await u
      .db("o_storyboard")
      .where("id", targetId)
      .modify((builder: any) => {
        if (input.projectId != null) builder.where("projectId", input.projectId);
        if (input.scriptId != null) builder.where("scriptId", input.scriptId);
      })
      .first("*");
    const storyboardTasks = await u
      .db("o_tasks")
      .where("businessType", "storyboard")
      .where("businessId", targetId)
      .orderBy("updateTime", "desc")
      .orderBy("id", "desc")
      .select("*");
    for (const task of storyboardTasks.filter((item: any) => taskStatus(item) === "completed")) {
      const path = extractMediaPath(parseJsonObject(task.resultJson));
      const item = path
        ? await toHistoryItem({
            id: `storyboard-task:${task.id}`,
            source: "storyboard",
            sourceId: targetId,
            path,
            prompt: storyboard?.prompt || undefined,
            model: task.model || undefined,
            createTime: task.finishTime || task.updateTime || undefined,
            updateTime: task.updateTime ?? undefined,
            status: taskStatus(task),
            taskId: task.taskId || undefined,
            legacyTaskId: task.id,
          })
        : null;
      if (item) historyItems.push(item);
    }
    if (storyboard?.filePath) {
      const item = await toHistoryItem({
        id: `storyboard-current:${targetId}`,
        source: "storyboard",
        sourceId: targetId,
        path: storyboard.filePath,
        prompt: storyboard.prompt,
        createTime: storyboard.updateTime || storyboard.id,
        updateTime: storyboard.updateTime || storyboard.id,
        status: toTaskStatus(storyboard.state) || "completed",
      });
      if (item) historyItems.push(item);
    }
  }

  if (targetType === "deriveAsset" && targetId != null) {
    const images: any[] = await u.db("o_image").where("assetsId", targetId).whereNotNull("filePath").orderBy("id", "desc").select("*");
    const imageIds = images.map((item: any) => Number(item.id)).filter(Number.isFinite);
    const imageTasks = imageIds.length
      ? await u
          .db("o_tasks")
          .where("businessType", "image")
          .whereIn("businessId", imageIds)
          .orderBy("updateTime", "desc")
          .orderBy("id", "desc")
          .select("*")
      : [];
    const latestTaskByImageId = new Map<number, any>();
    for (const task of imageTasks) {
      const imageId = Number(task.businessId);
      if (!latestTaskByImageId.has(imageId)) latestTaskByImageId.set(imageId, task);
    }
    for (const image of images) {
      const task = latestTaskByImageId.get(Number(image.id));
      const item = await toHistoryItem({
        id: `asset-image:${image.id}`,
        source: "asset",
        sourceId: targetId,
        path: image.filePath || "",
        model: image.model || undefined,
        quality: image.resolution || undefined,
        createTime: image.createTime || image.id,
        updateTime: task?.updateTime || image.updateTime || image.id,
        status: task?.status || toTaskStatus(image.state) || "completed",
        taskId: task?.taskId || undefined,
        legacyTaskId: task?.id ?? undefined,
      });
      if (item) historyItems.push(item);
    }
  }

  return dedupeAndSortHistory(historyItems);
}
