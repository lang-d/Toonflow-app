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
    uploadData: z.array(
      z.object({
        id: z.number(),
        sources: z.enum(["storyboard", "assets", "merged", "directorAsset"]),
      }),
    ),
    prompt: z.string(),
    model: z.string(),
    mode: z.string(),
    resolution: z.string(),
    duration: z.number(),
    audio: z.boolean().optional(),
    trackId: z.number(),
  }),
  async (req, res) => {
    const { scriptId, projectId, prompt, uploadData, model, duration, resolution, audio, mode, trackId } = req.body;
    let modeData = [];
    if (Array.isArray(mode)) {
    } else if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
      try {
        modeData = JSON.parse(mode);
      } catch (e) {}
    }
    //获取生成视频比例
    const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
    const videoPath = `/${projectId}/video/${uuidv4()}.mp4`; //视频保存路径
    const references = await resolveWorkbenchReferences(uploadData, { projectId, scriptId, trackId });
    validateReferenceLimits(references, modeData.length > 0 ? modeData : mode);
    //新增
    const [videoId] = await u.db("o_video").insert({
      filePath: videoPath,
      time: Date.now(),
      state: "生成中",
      scriptId,
      projectId,
      videoTrackId: trackId,
    });
    const relatedObjects = {
      projectId,
      videoId,
      scriptId,
      trackId,
      type: "视频",
    };
    const queued = await enqueueVideoGeneration({
      videoId,
      videoPath,
      projectId,
      scriptId,
      model,
      input: {
        prompt,
        references: uploadData.map((item: { id: number; sources: "storyboard" | "assets" | "merged" | "directorAsset" }, order: number) => ({
          ...item,
          order,
        })),
        mode: modeData.length > 0 ? modeData : mode,
        duration,
        aspectRatio: (ratio?.videoRatio as "16:9" | "9:16") || "16:9",
        resolution,
        audio,
      },
      relatedObjects,
    });
    res.status(200).send(success({ videoId, taskId: queued.taskId, queueTaskId: queued.queueTaskId }));
  },
);
