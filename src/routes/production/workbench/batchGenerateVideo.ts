import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { enqueueVideoGeneration } from "@/utils/videoGenerationQueue";
import { resolveWorkbenchReferences, validateReferenceLimits } from "@/services/workbenchReference";
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
    trackData: z.array(
      z.object({
        uploadData: z.array(referenceSchema),
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
    const modeData = parseMode(mode);
    const durationPolicy = await getVideoModelPolicy(model, { resolution });

    for (const track of trackData) {
      try {
        assertVideoDurationSupported(durationPolicy, track.duration);
      } catch (cause) {
        return res.status(400).send(error(u.error(cause).message, { trackId: track.trackId, durationPolicy }));
      }
    }

    const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
    const trackIds = trackData.map((track: any) => Number(track.trackId));
    const tracks = await u.db("o_videoTrack").where({ projectId, scriptId }).whereIn("id", trackIds);
    const validTrackIds = new Set(tracks.map((track: any) => Number(track.id)));
    const invalidTrackId = trackIds.find((trackId: number) => !validTrackIds.has(trackId));
    if (invalidTrackId != null) {
      return res.status(400).send(error("Video track does not exist or does not belong to the current script", { trackId: invalidTrackId }));
    }
    try {
      await assertTrackStoryboardsReady({ projectId, scriptId, trackIds });
    } catch (cause) {
      return res.status(400).send(error(u.error(cause).message));
    }
    try {
      assertVideoModelAvailable(durationPolicy);
    } catch (cause) {
      return res.status(400).send(error(u.error(cause).message, { durationPolicy }));
    }

    const tasks = await Promise.all(
      (trackData as { uploadData: { id: number | string; sources: VideoReferenceSource }[]; trackId: number; prompt: string; duration: number }[]).map(async (track) => {
        const { uploadData, trackId, prompt, duration } = track;
        const references = await resolveWorkbenchReferences(uploadData, { projectId, scriptId, trackId });
        validateReferenceLimits(references, modeData);

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
      const relatedObjects = { projectId, videoId, scriptId, type: "视频", trackId };
      const queued = await enqueueVideoGeneration({
        videoId,
        videoPath,
        projectId,
        scriptId,
        model,
        input: {
          prompt,
          references: queuedReferences,
          mode: modeData,
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
