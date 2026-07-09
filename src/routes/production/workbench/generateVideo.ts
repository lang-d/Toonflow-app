import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { enqueueVideoGeneration } from "@/utils/videoGenerationQueue";
import { resolveWorkbenchReferences, validateReferenceLimits } from "@/services/workbenchReference";
import { inspectVideoPromptEngineering } from "@/services/videoPromptSafetyGuard";
import {
  assertVideoDurationSupported,
  assertVideoModelAvailable,
  getVideoModelPolicy,
} from "@/services/videoModelPolicy";
import { assertTrackStoryboardsReady } from "@/services/storyboardFacts";

const router = express.Router();
type VideoReferenceSource = "storyboard" | "assets" | "merged" | "directorAsset" | "local";
const referenceSchema = z.object({
  id: z.union([z.number(), z.string()]),
  sources: z.enum(["storyboard", "assets", "merged", "directorAsset", "local"]),
});

function parseMode(mode: unknown) {
  if (Array.isArray(mode)) return mode;
  if (typeof mode === "string" && mode.trim().startsWith("[")) {
    try {
      return JSON.parse(mode);
    } catch {}
  }
  return mode;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    uploadData: z.array(referenceSchema),
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
    const trackReview = await u.db("o_videoTrack").where({ id: trackId, projectId }).first();
    if (!trackReview || Number(trackReview.scriptId) !== Number(scriptId)) {
      return res.status(400).send(error("Video track does not exist or does not belong to the current script"));
    }
    try {
      await assertTrackStoryboardsReady({ projectId, scriptId, trackIds: [trackId] });
    } catch (cause) {
      return res.status(400).send(error(u.error(cause).message));
    }

    const promptInspection = inspectVideoPromptEngineering(prompt);
    const blockingPromptIssue = promptInspection.issues.find((issue) => issue.severity === "blocking");
    if (blockingPromptIssue) {
      return res.status(400).send(error(blockingPromptIssue.message, { issue: blockingPromptIssue }));
    }

    const durationPolicy = await getVideoModelPolicy(model, { resolution });
    try {
      assertVideoModelAvailable(durationPolicy);
      assertVideoDurationSupported(durationPolicy, duration);
    } catch (cause) {
      return res.status(400).send(error(u.error(cause).message, { durationPolicy }));
    }

    const modeData = parseMode(mode);
    const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
    const videoPath = `/${projectId}/video/${uuidv4()}.mp4`;
    const references = await resolveWorkbenchReferences(uploadData, { projectId, scriptId, trackId });
    validateReferenceLimits(references, modeData);

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
        references: uploadData.map((item: { id: number | string; sources: VideoReferenceSource }, order: number) => ({
          ...item,
          order,
        })),
        mode: modeData,
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
