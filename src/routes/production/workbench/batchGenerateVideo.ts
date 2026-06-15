import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { enqueueVideoGeneration } from "@/utils/videoGenerationQueue";
import { resolveWorkbenchReferences, validateReferenceLimits } from "@/services/workbenchReference";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackData: z.array(
      z.object({
        uploadData: z.array(
          z.object({
            id: z.number(),
            sources: z.enum(["storyboard", "assets", "merged", "directorAsset"]),
          }),
        ),
        trackId: z.number(),
        prompt: z.string(),
        duration: z.number(),
      }),
    ),
    model: z.string(),
    mode: z.string(),
    resolution: z.string(),
    audio: z.boolean().optional(),
  }),
  async (req, res) => {
    const { scriptId, projectId, trackData, model, resolution, audio, mode } = req.body;

    let modeData = [];
    if (Array.isArray(mode)) {
    } else if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
      try {
        modeData = JSON.parse(mode);
      } catch (e) {}
    }

    // 获取生成视频比例
    const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();

    // 为每个 track 预处理数据并插入数据库，返回任务列表
    const tasks = await Promise.all(
      (trackData as { uploadData: { id: number; sources: "storyboard" | "assets" | "merged" | "directorAsset" }[]; trackId: number; prompt: string; duration: number }[]).map(async (track) => {
        const { uploadData, trackId, prompt, duration } = track;
        const references = await resolveWorkbenchReferences(uploadData, { projectId, scriptId, trackId });
        validateReferenceLimits(references, modeData.length > 0 ? modeData : mode);

        const videoPath = `/${projectId}/video/${uuidv4()}.mp4`;
        const [videoId] = await u.db("o_video").insert({
          filePath: videoPath,
          time: Date.now(),
          state: "生成中",
          scriptId,
          projectId,
          videoTrackId: trackId,
        });

        return {
          videoId,
          videoPath,
          prompt,
          duration,
          trackId,
          queuedReferences: uploadData.map((item, order) => ({ ...item, order })),
        };
      }),
    );

    const queuedTasks = [];
    for (const { videoId, videoPath, prompt, duration, queuedReferences, trackId } of tasks) {
      const relatedObjects = { projectId, videoId, scriptId, type: "视频" };
      (relatedObjects as any).trackId = trackId;
      const queued = await enqueueVideoGeneration({
        videoId,
        videoPath,
        projectId,
        scriptId,
        model,
        input: {
          prompt,
          references: queuedReferences,
          mode: modeData.length > 0 ? modeData : mode,
          duration,
          aspectRatio: (ratio?.videoRatio as "16:9" | "9:16") || "16:9",
          resolution,
          audio,
        },
        relatedObjects,
      });
      queuedTasks.push({ videoId, trackId, taskId: queued.taskId, queueTaskId: queued.queueTaskId });
    }
    res.status(200).send(success(queuedTasks));
  },
);
