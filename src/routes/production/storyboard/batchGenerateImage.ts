import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { toLegacyTaskState, toTaskStatus } from "@/lib/taskStatus";
import { validateFields } from "@/middleware/middleware";
import { createImageFlowTask } from "@/services/imageFlowTask";

const router = express.Router();

function normalizeQuality(value: unknown) {
  const quality = String(value || "").trim();
  return ["1K", "2K", "4K"].includes(quality) ? quality : "1K";
}

export default router.post(
  "/",
  validateFields({
    storyboardIds: z.array(z.number()),
    projectId: z.number(),
    scriptId: z.number(),
    concurrentCount: z.number().min(1).optional(),
    compulsory: z.boolean().optional(),
  }),
  async (req, res) => {
    const {
      storyboardIds,
      projectId,
      scriptId,
      compulsory = false,
    }: {
      storyboardIds: number[];
      projectId: number;
      scriptId: number;
      concurrentCount: number;
      compulsory: boolean;
    } = req.body;
    if (!storyboardIds?.length) return res.status(400).send(error("storyboardIds不能为空"));

    const storyboardData = await u
      .db("o_storyboard")
      .where({ scriptId, projectId })
      .whereIn("id", storyboardIds)
      .orderBy("index", "asc")
      .orderBy("id", "asc");
    if (!storyboardData.length) return res.status(500).send(error("未查到分镜数据"));

    const projectSettingData = await u
      .db("o_project")
      .where("id", projectId)
      .select("imageModel", "imageQuality", "videoRatio")
      .first();
    if (!projectSettingData?.imageModel) return res.status(400).send(error("请先配置图片模型"));

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

    const assets2StoryboardRows = await u
      .db("o_assets2Storyboard")
      .whereIn("storyboardId", storyIds)
      .orderBy("rowid")
      .select("storyboardId", "assetId");
    const assetRecord = new Map<number, number[]>();
    for (const item of assets2StoryboardRows) {
      const storyboardId = Number(item.storyboardId);
      if (!assetRecord.has(storyboardId)) assetRecord.set(storyboardId, []);
      assetRecord.get(storyboardId)!.push(Number(item.assetId));
    }

    const taskByStoryboard = new Map<number, Awaited<ReturnType<typeof createImageFlowTask>>>();
    const errors: Array<{ storyboardId: number; error: string }> = [];
    const generateList = compulsory ? storyboardData : storyboardData.filter((item: any) => item.shouldGenerateImage !== 0);
    console.info("[storyboard] batchGenerateImage request", {
      projectId,
      scriptId,
      storyboardIds,
      compulsory,
      requestedCount: storyboardIds.length,
      matchedCount: storyboardData.length,
      generateCount: generateList.length,
    });
    for (const item of generateList) {
      try {
        const task = await createImageFlowTask({
          projectId,
          scriptId,
          targetType: "storyboard",
          targetId: Number(item.id),
          references: [],
          referenceMediaPaths: [],
          model: projectSettingData.imageModel,
          quality: normalizeQuality(projectSettingData.imageQuality),
          ratio: projectSettingData.videoRatio || "16:9",
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

    const realStoryData = await u.db("o_storyboard").where({ scriptId, projectId }).whereIn("id", storyIds);
    const result = await Promise.all(
      realStoryData.map(async (item: any) => {
        const task = taskByStoryboard.get(Number(item.id));
        const status = task?.status || toTaskStatus(item.state) || "pending";
        return {
          id: item.id,
          prompt: item.prompt,
          associateAssetsIds: assetRecord.get(Number(item.id)) || [],
          src: item.filePath ? await u.oss.getSmallImageUrl(item.filePath) : null,
          state: item.state,
          status,
          shouldGenerateImage: item.shouldGenerateImage,
          taskId: task?.unifiedTaskId,
          unifiedTaskId: task?.unifiedTaskId,
          legacyTaskId: task?.legacyTaskId,
          nodeId: task?.nodeId,
          flowId: task?.flowId,
          reason: item.reason || "",
        };
      }),
    );

    if (errors.length) console.warn("[storyboard] batchGenerateImage partial failures", errors);
    console.info("[storyboard] batchGenerateImage created tasks", {
      projectId,
      scriptId,
      storyboardIds,
      compulsory,
      createdCount: taskByStoryboard.size,
      failedCount: errors.length,
      tasks: Array.from(taskByStoryboard.entries()).map(([storyboardId, task]) => ({
        storyboardId,
        unifiedTaskId: task.unifiedTaskId,
        legacyTaskId: task.legacyTaskId,
        flowId: task.flowId,
        nodeId: task.nodeId,
      })),
    });
    return res.status(200).send(success(result));
  },
);
