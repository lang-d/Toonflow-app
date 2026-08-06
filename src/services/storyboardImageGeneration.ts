import u from "@/utils";
import { toLegacyTaskState, toTaskStatus } from "@/lib/taskStatus";
import { createImageFlowTask } from "@/services/imageFlowTask";
import { resolveStoryboardFactStatus } from "@/services/storyboardFacts";

function normalizeQuality(value: unknown) {
  const quality = String(value || "").trim();
  return ["1K", "2K", "4K"].includes(quality) ? quality : "1K";
}

export async function enqueueStoryboardImageGeneration(input: {
  projectId: number;
  scriptId: number;
  storyboardIds: number[];
  compulsory?: boolean;
}) {
  const { projectId, scriptId, storyboardIds, compulsory = false } = input;
  if (!storyboardIds.length) throw new Error("storyboardIds cannot be empty");

  const storyboardData = await u
    .db("o_storyboard")
    .where({ scriptId, projectId })
    .whereIn("id", storyboardIds)
    .orderBy("index", "asc")
    .orderBy("id", "asc");
  if (!storyboardData.length) throw new Error("No storyboard data found for this project and script");
  const generateList = compulsory ? storyboardData : storyboardData.filter((item: any) => item.shouldGenerateImage !== 0);
  const nonReady = generateList.filter((item: any) => resolveStoryboardFactStatus(item) !== "ready");
  if (nonReady.length) {
    throw new Error(`Storyboard facts are not ready for image generation: ${nonReady.map((item: any) => Number(item.index) + 1).join(", ")}`);
  }

  const project = await u.db("o_project").where("id", projectId).select("imageModel", "imageQuality", "videoRatio").first();
  if (!project?.imageModel) throw new Error("Project image model is not configured");

  const storyIds = storyboardData.map((item: any) => Number(item.id));
  if (compulsory) {
    await u.db("o_storyboard").whereIn("id", storyIds).where({ scriptId, projectId }).update({
      state: toLegacyTaskState("processing"),
      shouldGenerateImage: 1,
    });
  } else {
    await u.db("o_storyboard").whereIn("id", storyIds).where({ scriptId, projectId }).where("shouldGenerateImage", 0).update({
      state: toLegacyTaskState("pending"),
    });
    await u.db("o_storyboard").whereIn("id", storyIds).where({ scriptId, projectId }).where("shouldGenerateImage", 1).update({
      state: toLegacyTaskState("processing"),
    });
  }

  const bindings = await u.db("o_assets2Storyboard").whereIn("storyboardId", storyIds).orderBy("rowid").select("storyboardId", "assetId");
  const assetRecord = new Map<number, number[]>();
  for (const binding of bindings) {
    const storyboardId = Number(binding.storyboardId);
    const ids = assetRecord.get(storyboardId) || [];
    ids.push(Number(binding.assetId));
    assetRecord.set(storyboardId, ids);
  }

  const taskByStoryboard = new Map<number, Awaited<ReturnType<typeof createImageFlowTask>>>();
  const errors: Array<{ storyboardId: number; error: string }> = [];
  for (const item of generateList) {
    try {
      const task = await createImageFlowTask({
        projectId,
        scriptId,
        targetType: "storyboard",
        targetId: Number(item.id),
        references: [],
        referenceMediaPaths: [],
        model: project.imageModel,
        quality: normalizeQuality(project.imageQuality),
        ratio: project.videoRatio || "16:9",
        prompt: "",
      });
      taskByStoryboard.set(Number(item.id), task);
    } catch (cause) {
      const message = u.error(cause).message;
      errors.push({ storyboardId: Number(item.id), error: message });
      await u.db("o_storyboard").where({ id: item.id, projectId, scriptId }).update({
        state: toLegacyTaskState("failed"),
        reason: message,
      });
    }
  }

  const rows = await u.db("o_storyboard").where({ scriptId, projectId }).whereIn("id", storyIds);
  const tasks = await Promise.all(
    rows.map(async (item: any) => {
      const task = taskByStoryboard.get(Number(item.id));
      const status = task?.status || toTaskStatus(item.state) || "pending";
      return {
        storyboardId: Number(item.id),
        id: Number(item.id),
        taskId: task?.unifiedTaskId,
        unifiedTaskId: task?.unifiedTaskId,
        legacyTaskId: task?.legacyTaskId,
        nodeId: task?.nodeId,
        flowId: task?.flowId,
        status,
        state: item.state,
        shouldGenerateImage: item.shouldGenerateImage,
        associateAssetsIds: assetRecord.get(Number(item.id)) || [],
        reason: item.reason || "",
      };
    }),
  );
  return {
    total: tasks.length,
    tasks: tasks.filter((item: any) => item.taskId),
    successCount: taskByStoryboard.size,
    failedCount: errors.length,
    errors,
    rows: tasks,
  };
}
