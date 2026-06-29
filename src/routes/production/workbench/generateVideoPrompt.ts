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
    trackId: z.number(),
    projectId: z.number(),
    info: z.array(referenceSchema),
    model: z.string(),
    mode: z.string(),
    promptPrefix: z.string().optional(),
    promptSuffix: z.string().optional(),
  }),
  async (req, res) => {
    const { trackId, projectId, info, model, mode, promptPrefix, promptSuffix } = req.body;
    try {
      const track = await u.db("o_videoTrack").where({ id: trackId, projectId }).first();
      if (!track) throw new Error("轨道不存在或不属于当前项目");
      await u.db("o_videoTrack").where({ id: trackId }).update({ state: "生成中", reason: "" });
      const task = await createUnifiedTask({
        projectId,
        scriptId: track.scriptId ?? undefined,
        taskClass: "视频提示词生成",
        taskType: "prompt",
        status: "queued",
        phase: "queued",
        targetType: "videoTrack",
        targetId: trackId,
        businessType: "video-track-prompt",
        businessId: trackId,
        handler: "workbench-prompt",
        payload: {
          projectId,
          scriptId: track.scriptId ?? undefined,
          trackId,
          references: info,
          model,
          mode,
          promptPrefix,
          promptSuffix,
        },
        priority: 100,
        maxAttempts: 1,
        model,
        describe: "视频工作台提示词生成",
      });
      res.status(200).send(success({ taskId: task.taskId, legacyTaskId: task.legacyTaskId, trackId, status: "queued" }));
    } catch (e) {
      await u.db("o_videoTrack").where({ id: trackId }).update({ state: "生成失败", reason: u.error(e).message });
      res.status(400).send(error(u.error(e).message));
    }
  },
);
