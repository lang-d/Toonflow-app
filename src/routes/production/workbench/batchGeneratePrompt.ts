import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createUnifiedTask } from "@/services/taskCoordinator";

const router = express.Router();
const referenceSchema = z.object({
  id: z.union([z.number(), z.string()]),
  sources: z.enum(["storyboard", "assets", "merged", "directorAsset", "local"]),
});

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    trackData: z.array(
      z.object({
        trackId: z.number(),
        info: z.array(referenceSchema),
      }),
    ),
    mode: z.string(),
    model: z.string(),
    promptPrefix: z.string().optional(),
    promptSuffix: z.string().optional(),
    concurrentCount: z.number().int().min(1).max(20).optional().default(5),
  }),
  async (req, res) => {
    const { trackData, projectId, mode, model, promptPrefix, promptSuffix, concurrentCount } = req.body;
    try {
      const requestedIds = trackData.map((item: any) => item.trackId);
      const tracks = await u.db("o_videoTrack").where({ projectId }).whereIn("id", requestedIds).select("id", "scriptId");
      const validIds = new Set(tracks.map((item: any) => Number(item.id)));
      const trackMap = new Map(tracks.map((item: any) => [Number(item.id), item]));
      const invalidId = requestedIds.find((id: number) => !validIds.has(id));
      if (invalidId != null) throw new Error(`轨道不存在或不属于当前项目：${invalidId}`);

      await u.db("o_videoTrack").whereIn("id", requestedIds).update({ state: "生成中", reason: "" });
      const tasks = [];
      for (const track of trackData as any[]) {
        const task = await createUnifiedTask({
          projectId,
          scriptId: trackMap.get(Number(track.trackId))?.scriptId ?? undefined,
          taskClass: "视频提示词生成",
          taskType: "prompt",
          status: "queued",
          phase: "queued",
          targetType: "videoTrack",
          targetId: track.trackId,
          businessType: "video-track-prompt",
          businessId: track.trackId,
          handler: "workbench-prompt",
          payload: {
            projectId,
            scriptId: trackMap.get(Number(track.trackId))?.scriptId ?? undefined,
            trackId: track.trackId,
            references: track.info,
            model,
            mode,
            promptPrefix,
            promptSuffix,
          },
          priority: 20,
          maxAttempts: 1,
          model,
          describe: "视频工作台批量提示词生成",
        });
        tasks.push({ trackId: track.trackId, taskId: task.taskId, legacyTaskId: task.legacyTaskId });
      }
      res.status(200).send(success({ message: "开始生成提示词", tasks, requestedConcurrency: concurrentCount }));
    } catch (e) {
      res.status(400).send(error(u.error(e).message));
    }
  },
);
