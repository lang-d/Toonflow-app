import u from "@/utils";
import { toTaskStatus, type TaskStatus } from "@/lib/taskStatus";

export type ImageFlowTargetType = "deriveAsset" | "storyboard";

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

function pathsEqual(left: unknown, right: unknown): boolean {
  const a = stripUrl(left);
  const b = stripUrl(right);
  return Boolean(a && b && a === b);
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

async function normalizePrimaryNode(
  trx: any,
  flowId: number | null,
  nodes: any[],
  selectedImageUrl: string,
) {
  const generatedNodes = nodes.filter((node) => node.type === "generated");
  const marked = generatedNodes.filter((node) => node.data?.isPrimary === true);
  if (marked.length > 1) {
    throw new ImageFlowValidationError([
      { path: "nodes", message: "同一画布最多只能有一个主生成节点" },
    ]);
  }

  let selectedNode: any = null;
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
    if (!selectedNode && generatedNodes.length) {
      throw new ImageFlowValidationError([
        { path: "selectedImageUrl", message: "最终图片无法唯一对应到生成节点" },
      ]);
    }
  }

  const primary = selectedNode || marked[0] || (generatedNodes.length === 1 ? generatedNodes[0] : null);
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
      const selectedImageUrl =
        input.selectedMediaPath === undefined && input.selectedImageUrl === undefined
          ? stripUrl(existingFlow.selectedImageUrl)
          : selectedInputPath(input);
      await normalizePrimaryNode(trx, flowId, merged.nodes, selectedImageUrl);
      const flowData = JSON.stringify({
        ...existingFlow,
        projectId: input.projectId ?? existingFlow.projectId ?? null,
        scriptId: input.scriptId ?? existingFlow.scriptId ?? null,
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
      await normalizePrimaryNode(trx, null, nodes, selectedImageUrl);
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

export async function getImageHistory(input: ImageFlowTarget & { deriveAssetId?: number }) {
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
    tasks.map(async (task: any) => ({
      id: task.id,
      historyId: task.id,
      url: task.url ? await u.oss.getSmallImageUrl(task.url) : "",
      prompt: task.prompt || "",
      model: task.model || "",
      ratio: task.ratio || "",
      quality: task.quality || "",
      createTime: task.createTime,
    })),
  );
}
