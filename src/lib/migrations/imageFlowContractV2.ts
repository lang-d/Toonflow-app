import fs from "node:fs/promises";
import path from "node:path";
import type { Knex } from "knex";
import { toLegacyTaskState, toTaskStatus, type TaskStatus } from "@/lib/taskStatus";

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

async function taskFailurePatch(knex: Knex, reason: string) {
  const now = Date.now();
  const update: Record<string, unknown> = {
    state: "生成失败",
    reason,
  };
  if (await knex.schema.hasColumn("o_tasks", "status")) update.status = "failed";
  if (await knex.schema.hasColumn("o_tasks", "phase")) update.phase = "failed";
  if (await knex.schema.hasColumn("o_tasks", "finishTime")) update.finishTime = now;
  if (await knex.schema.hasColumn("o_tasks", "updateTime")) update.updateTime = now;
  if (await knex.schema.hasColumn("o_tasks", "leaseOwner")) update.leaseOwner = null;
  if (await knex.schema.hasColumn("o_tasks", "leaseExpiresAt")) update.leaseExpiresAt = null;
  return update;
}

async function hasTaskEventTable(knex: Knex) {
  return knex.schema.hasTable("o_taskEvent");
}

async function insertTaskEvent(trx: Knex.Transaction, task: any, hasEvents: boolean) {
  if (!hasEvents || !task?.taskId) return;
  await trx("o_taskEvent").insert({
    taskId: task.taskId,
    legacyTaskId: task.id,
    version: Number(task.version || 1),
    taskType: task.taskType || "image",
    projectId: task.projectId ?? null,
    scriptId: task.scriptId ?? task.episode ?? null,
    targetType: task.targetType || null,
    targetId: task.targetId == null ? null : String(task.targetId),
    nodeId: task.nodeId || null,
    status: task.status || toTaskStatus(task.state) || "pending",
    phase: task.phase || null,
    progress: task.progress ?? null,
    resultJson: task.resultJson ?? null,
    reason: task.reason || null,
    createdAt: Date.now(),
  });
}

async function resumeProviderTaskPatch(knex: Knex, task: any) {
  const now = Date.now();
  const update: Record<string, unknown> = {
    state: toLegacyTaskState("queued"),
    reason: null,
  };
  if (await knex.schema.hasColumn("o_tasks", "status")) update.status = "queued";
  if (await knex.schema.hasColumn("o_tasks", "phase")) update.phase = "resume-provider-query";
  if (await knex.schema.hasColumn("o_tasks", "availableAt")) update.availableAt = now;
  if (await knex.schema.hasColumn("o_tasks", "finishTime")) update.finishTime = null;
  if (await knex.schema.hasColumn("o_tasks", "updateTime")) update.updateTime = now;
  if (await knex.schema.hasColumn("o_tasks", "leaseOwner")) update.leaseOwner = null;
  if (await knex.schema.hasColumn("o_tasks", "leaseExpiresAt")) update.leaseExpiresAt = null;
  if (await knex.schema.hasColumn("o_tasks", "version")) update.version = Number(task?.version || 1) + 1;
  return update;
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
    const orphanTaskPatch = await taskFailurePatch(trx, ORPHAN_REASON);
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
        await trx("o_tasks").where("id", task.taskCenterId).update(orphanTaskPatch);
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
  const normalizedReason = "\u8f6f\u4ef6\u91cd\u542f\u5bfc\u81f4\u4efb\u52a1\u4e2d\u65ad";
  const hasEvents = await hasTaskEventTable(knex);
  const tasks = await knex("o_editImageTask as task")
    .leftJoin("o_tasks as unified", "unified.id", "task.taskCenterId")
    .where((builder) =>
      builder
        .whereIn("task.status", ["queued", "submitting", "processing"])
        .orWhereIn("task.state", [
          toLegacyTaskState("queued"),
          toLegacyTaskState("submitting"),
          toLegacyTaskState("processing"),
        ]),
    )
    .select(
      "task.*",
      "unified.id as unifiedId",
      "unified.taskId as unifiedTaskId",
      "unified.version as unifiedVersion",
      "unified.taskType as unifiedTaskType",
      "unified.projectId as unifiedProjectId",
      "unified.scriptId as unifiedScriptId",
      "unified.episode as unifiedEpisode",
      "unified.targetType as unifiedTargetType",
      "unified.targetId as unifiedTargetId",
      "unified.nodeId as unifiedNodeId",
      "unified.status as unifiedStatus",
      "unified.phase as unifiedPhase",
      "unified.progress as unifiedProgress",
      "unified.resultJson as unifiedResultJson",
      "unified.reason as unifiedReason",
      "unified.providerTaskId as unifiedProviderTaskId",
      "unified.providerSubmittedAt as unifiedProviderSubmittedAt",
    );
  const terminalTasksMissingEvents = hasEvents
    ? await knex("o_tasks as task")
        .where("task.businessType", "image-flow")
        .where("task.status", "failed")
        .where("task.reason", normalizedReason)
        .whereNotExists(function () {
          this.select(1)
            .from("o_taskEvent as event")
            .whereRaw("event.legacyTaskId = task.id")
            .where("event.status", "failed");
        })
        .select("task.*")
        .limit(500)
    : [];
  if (!tasks.length && !terminalTasksMissingEvents.length) return 0;

  await knex.transaction(async (trx) => {
    const interruptedTaskPatch = await taskFailurePatch(trx, normalizedReason);
    const providerResumePatches = new Map<number, Record<string, unknown>>();

    for (const task of terminalTasksMissingEvents) {
      await insertTaskEvent(trx, task, hasEvents);
    }

    for (const task of tasks) {
      const unifiedTask =
        task.unifiedId == null
          ? null
          : {
              id: task.unifiedId,
              taskId: task.unifiedTaskId,
              version: task.unifiedVersion,
              taskType: task.unifiedTaskType,
              projectId: task.unifiedProjectId,
              scriptId: task.unifiedScriptId,
              episode: task.unifiedEpisode,
              targetType: task.unifiedTargetType,
              targetId: task.unifiedTargetId,
              nodeId: task.unifiedNodeId,
              status: task.unifiedStatus,
              phase: task.unifiedPhase,
              progress: task.unifiedProgress,
              resultJson: task.unifiedResultJson,
              reason: task.unifiedReason,
              providerTaskId: task.unifiedProviderTaskId,
              providerSubmittedAt: task.unifiedProviderSubmittedAt,
            };

      if (unifiedTask?.providerTaskId) {
        let resumePatch = providerResumePatches.get(Number(unifiedTask.id));
        if (!resumePatch) {
          resumePatch = await resumeProviderTaskPatch(trx, unifiedTask);
          providerResumePatches.set(Number(unifiedTask.id), resumePatch);
        }
        await trx("o_tasks").where("id", unifiedTask.id).update(resumePatch);
        await insertTaskEvent(trx, { ...unifiedTask, ...resumePatch }, hasEvents);

        if (task.flowId && task.nodeId) {
          const row = await trx("o_imageFlow").where("id", task.flowId).first();
          if (row?.flowData) {
            const flow = parseFlow(row.flowData);
            const node = flow.nodes.find((item: any) => item.id === task.nodeId && item.type === "generated");
            if (node) {
              node.data = {
                ...(node.data || {}),
                taskId: task.id,
                status: "queued",
                state: "generating",
                phase: "resume-provider-query",
                reason: "",
              };
              await trx("o_imageFlow").where("id", task.flowId).update({ flowData: JSON.stringify(flow) });
            }
          }
        }
        continue;
      }

      await trx("o_editImageTask").where("id", task.id).update({
        status: "failed",
        state: toLegacyTaskState("failed"),
        reason: normalizedReason,
        updateTime: Date.now(),
      });
      if (task.taskCenterId != null) {
        await trx("o_tasks").where("id", task.taskCenterId).update(interruptedTaskPatch);
        await insertTaskEvent(
          trx,
          {
            ...unifiedTask,
            ...interruptedTaskPatch,
            id: task.taskCenterId,
            taskId: unifiedTask?.taskId,
            taskType: unifiedTask?.taskType || "image",
            projectId: unifiedTask?.projectId ?? task.projectId,
            scriptId: unifiedTask?.scriptId ?? task.scriptId,
            targetType: unifiedTask?.targetType ?? task.targetType,
            targetId: unifiedTask?.targetId ?? task.targetId,
            nodeId: unifiedTask?.nodeId ?? task.nodeId,
            progress: unifiedTask?.progress ?? null,
          },
          hasEvents,
        );
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
        reason: normalizedReason,
      };
      await trx("o_imageFlow").where("id", task.flowId).update({ flowData: JSON.stringify(flow) });
    }
  });
  return tasks.length + terminalTasksMissingEvents.length;
}
