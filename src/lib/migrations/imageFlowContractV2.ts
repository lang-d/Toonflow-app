import fs from "node:fs/promises";
import path from "node:path";
import type { Knex } from "knex";
import { toTaskStatus, type TaskStatus } from "@/lib/taskStatus";

const MIGRATION_KEY = "migration:image-flow-contract-v2";
const ACTIVE_STATUSES = new Set<TaskStatus>(["queued", "submitting", "processing"]);
const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled"]);
const ORPHAN_REASON = "历史任务对应的画布节点不存在";
const MISSING_TASK_REASON = "活动状态缺少有效任务记录";

interface MigrationOptions {
  createBackup?: boolean;
}

function parseFlow(value: unknown) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

function statusOf(value: any): TaskStatus | undefined {
  return value?.status || toTaskStatus(value?.state);
}

function hasImage(data: any): boolean {
  return Boolean(data?.generatedImage || data?.selectedResult?.url);
}

function taskSnapshot(task: any, preferredUrl?: string) {
  const status = statusOf(task) || "processing";
  const active = ACTIVE_STATUSES.has(status);
  const completed = status === "completed";
  const url = preferredUrl || task.url || "";
  const data: Record<string, unknown> = {
    taskId: active ? task.id : null,
    status,
    state: active ? "generating" : completed ? "success" : status === "pending" ? "idle" : "failed",
    reason: task.reason || "",
  };
  if (completed && url) {
    data.generatedImage = url;
    data.historyId = task.id;
    data.selectedResult = {
      id: task.id,
      url,
      prompt: task.prompt || "",
      model: task.model || "",
      ratio: task.ratio || "",
      quality: task.quality || "",
      createTime: task.createTime,
    };
  }
  return data;
}

function repairGeneratedNode(node: any, tasks: any[]): boolean {
  node.data ||= {};
  const data = node.data;
  const before = JSON.stringify(data);
  const exactTask = data.taskId != null ? tasks.find((task) => Number(task.id) === Number(data.taskId)) : null;

  if (data.taskId != null) {
    if (exactTask) {
      Object.assign(data, taskSnapshot(exactTask, data.generatedImage || data.selectedResult?.url));
    } else if (hasImage(data)) {
      Object.assign(data, { taskId: null, status: "completed", state: "success", reason: "" });
    } else {
      Object.assign(data, { taskId: null, status: "failed", state: "failed", reason: MISSING_TASK_REASON });
    }
    return before !== JSON.stringify(data);
  }

  const status = statusOf(data);
  if (hasImage(data) && (!status || status === "pending" || ACTIVE_STATUSES.has(status))) {
    Object.assign(data, { taskId: null, status: "completed", state: "success", reason: "" });
  } else if (status && ACTIVE_STATUSES.has(status)) {
    Object.assign(data, { taskId: null, status: "failed", state: "failed", reason: MISSING_TASK_REASON });
  } else if (status && TERMINAL_STATUSES.has(status)) {
    data.taskId = null;
    data.state = status === "completed" ? "success" : "failed";
  } else if (!status) {
    data.taskId = null;
    data.status = hasImage(data) ? "completed" : "pending";
    data.state = hasImage(data) ? "success" : "idle";
    data.reason ||= "";
  }
  return before !== JSON.stringify(data);
}

function buildRecoveredFlow(flowId: number, target: any, latestTask: any) {
  const nodes: any[] = [];
  const edges: any[] = [];
  const targetImage = target.targetImagePath || latestTask?.url || "";

  if (target.kind === "deriveAsset" && target.parentImagePath) {
    nodes.push({
      id: `migration:${flowId}:upload`,
      type: "upload",
      position: { x: 100, y: 100 },
      data: {
        image: target.parentImagePath,
        previewImage: target.parentImagePath,
      },
    });
  }

  if (targetImage) {
    const generatedId = latestTask?.nodeId || `migration:${flowId}:generated`;
    const selectedResult = latestTask
      ? {
          id: latestTask.id,
          url: targetImage,
          prompt: latestTask.prompt || "",
          model: latestTask.model || "",
          ratio: latestTask.ratio || "",
          quality: latestTask.quality || "",
          createTime: latestTask.createTime,
        }
      : null;
    nodes.push({
      id: generatedId,
      type: "generated",
      position: { x: 600, y: 100 },
      data: {
        generatedImage: targetImage,
        references:
          target.kind === "deriveAsset" && target.parentImagePath
            ? [{ image: target.parentImagePath, previewImage: target.parentImagePath }]
            : [],
        prompt: latestTask?.prompt || "",
        model: latestTask?.model || "",
        ratio: latestTask?.ratio || "",
        quality: latestTask?.quality || "",
        taskId: null,
        status: "completed",
        state: "success",
        reason: "",
        historyId: latestTask?.id || null,
        selectedResult,
      },
    });
    if (target.kind === "deriveAsset" && target.parentImagePath) {
      edges.push({
        id: `migration:${flowId}:edge`,
        source: `migration:${flowId}:upload`,
        target: generatedId,
      });
    }
  }

  return { nodes, edges };
}

async function createSqliteBackup(knex: Knex): Promise<string> {
  const filename = (knex.client.config.connection as any)?.filename;
  if (!filename || filename === ":memory:") return "";
  const backupDir = path.join(path.dirname(filename), "backups");
  await fs.mkdir(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `db2-before-image-flow-v2-${timestamp}.sqlite`);
  const connection: any = await knex.client.acquireConnection();
  try {
    await connection.backup(backupPath);
  } finally {
    await knex.client.releaseConnection(connection);
  }
  return backupPath;
}

export async function migrateImageFlowContractV2(knex: Knex, options: MigrationOptions = {}) {
  const marker = await knex("o_setting").where("key", MIGRATION_KEY).first();
  if (marker) return { skipped: true, changedFlows: 0, failedTasks: 0, backupPath: "" };

  const [flows, tasks, assetTargets, storyboardTargets] = await Promise.all([
    knex("o_imageFlow").select("id", "flowData"),
    knex("o_editImageTask").orderBy("createTime", "desc"),
    knex("o_assets as asset")
      .leftJoin("o_image as targetImage", "targetImage.id", "asset.imageId")
      .leftJoin("o_assets as parent", "parent.id", "asset.assetsId")
      .leftJoin("o_image as parentImage", "parentImage.id", "parent.imageId")
      .whereNotNull("asset.flowId")
      .select(
        "asset.flowId",
        "asset.id as targetId",
        "targetImage.filePath as targetImagePath",
        "parentImage.filePath as parentImagePath",
      ),
    knex("o_storyboard")
      .whereNotNull("flowId")
      .select("flowId", "id as targetId", "filePath as targetImagePath"),
  ]);

  const targets = new Map<number, any>();
  for (const target of assetTargets) targets.set(Number(target.flowId), { ...target, kind: "deriveAsset" });
  for (const target of storyboardTargets) {
    if (!targets.has(Number(target.flowId))) targets.set(Number(target.flowId), { ...target, kind: "storyboard" });
  }
  const tasksByFlow = new Map<number, any[]>();
  for (const task of tasks) {
    if (task.flowId == null) continue;
    const list = tasksByFlow.get(Number(task.flowId)) || [];
    list.push(task);
    tasksByFlow.set(Number(task.flowId), list);
  }

  const changedFlows = new Map<number, string>();
  const finalNodeIds = new Map<number, Set<string>>();
  for (const row of flows) {
    const flowId = Number(row.id);
    const original = parseFlow(row.flowData);
    let flow = original;
    let changed = false;
    const target = targets.get(flowId);
    const flowTasks = tasksByFlow.get(flowId) || [];

    if (!flow.nodes.length && target?.targetImagePath) {
      const latestCompleted = flowTasks.find((task) => statusOf(task) === "completed");
      flow = buildRecoveredFlow(flowId, target, latestCompleted);
      changed = flow.nodes.length > 0;
    } else {
      for (const node of flow.nodes) {
        if (node.type !== "generated") continue;
        const nodeTasks = flowTasks.filter((task) => task.nodeId === node.id);
        if (repairGeneratedNode(node, nodeTasks)) changed = true;
      }
    }

    finalNodeIds.set(flowId, new Set(flow.nodes.map((node: any) => node.id)));
    if (changed) changedFlows.set(flowId, JSON.stringify(flow));
  }

  const orphanTasks = tasks.filter((task) => {
    const status = statusOf(task);
    if (!status || !ACTIVE_STATUSES.has(status)) return false;
    return !task.flowId || !task.nodeId || !finalNodeIds.get(Number(task.flowId))?.has(task.nodeId);
  });

  const hasChanges = changedFlows.size > 0 || orphanTasks.length > 0;
  const backupPath = hasChanges && options.createBackup !== false ? await createSqliteBackup(knex) : "";

  await knex.transaction(async (trx) => {
    for (const [flowId, flowData] of changedFlows) {
      await trx("o_imageFlow").where("id", flowId).update({ flowData });
    }
    for (const task of orphanTasks) {
      await trx("o_editImageTask").where("id", task.id).update({
        status: "failed",
        state: "生成失败",
        reason: ORPHAN_REASON,
        updateTime: Date.now(),
      });
      if (task.taskCenterId != null) {
        await trx("o_tasks").where("id", task.taskCenterId).update({ state: "生成失败", reason: ORPHAN_REASON });
      }
    }
    await trx("o_setting").insert({
      key: MIGRATION_KEY,
      value: JSON.stringify({
        completedAt: Date.now(),
        changedFlows: changedFlows.size,
        failedTasks: orphanTasks.length,
        backupPath,
      }),
    });
  });

  return { skipped: false, changedFlows: changedFlows.size, failedTasks: orphanTasks.length, backupPath };
}

export async function failInterruptedImageFlowTasks(knex: Knex) {
  const tasks = await knex("o_editImageTask")
    .whereIn("status", ["queued", "submitting", "processing"])
    .orWhereIn("state", ["排队中", "提交中", "生成中"]);
  if (!tasks.length) return 0;
  const reason = "软件重启导致任务中断";

  await knex.transaction(async (trx) => {
    for (const task of tasks) {
      await trx("o_editImageTask").where("id", task.id).update({
        status: "failed",
        state: "生成失败",
        reason,
        updateTime: Date.now(),
      });
      if (task.taskCenterId != null) {
        await trx("o_tasks").where("id", task.taskCenterId).update({ state: "生成失败", reason });
      }
      if (!task.flowId || !task.nodeId) continue;
      const row = await trx("o_imageFlow").where("id", task.flowId).first();
      if (!row?.flowData) continue;
      const flow = parseFlow(row.flowData);
      const node = flow.nodes.find((item: any) => item.id === task.nodeId && item.type === "generated");
      if (!node) continue;
      node.data = {
        ...(node.data || {}),
        taskId: null,
        status: "failed",
        state: "failed",
        reason,
      };
      await trx("o_imageFlow").where("id", task.flowId).update({ flowData: JSON.stringify(flow) });
    }
  });
  return tasks.length;
}

