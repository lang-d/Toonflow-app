import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  serializeStoryboardReferences,
  StoryboardContractError,
  updateTrackDuration,
  validateNewStoryboardRelations,
} from "@/services/storyboardEditor";
import { bindImageFlowToStoryboard } from "@/services/imageFlow";

const router = express.Router();
const referenceSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    source: z.enum(["local", "storyboard"]),
    sourceId: z.union([z.string(), z.number()]).nullable().optional(),
    url: z.string(),
    previewUrl: z.string().optional(),
    label: z.string().optional(),
    group: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

export default router.post(
  "/",
  validateFields({
    prompt: z.string(),
    duration: z.number().nonnegative(),
    state: z.string(),
    videoDesc: z.string(),
    shouldGenerateImage: z.number(),
    src: z.string().nullable(),
    scriptId: z.number(),
    projectId: z.number(),
    flowId: z.number().nullable().optional(),
    associateAssetsIds: z.array(z.number()).default([]),
    referenceImages: z.array(referenceSchema).default([]),
  }),
  async (req, res) => {
    try {
      const result = await u.db.transaction(async (trx: any) => {
        const trackId = Date.now();
        await trx("o_videoTrack").insert({
          id: trackId,
          scriptId: req.body.scriptId,
          projectId: req.body.projectId,
          duration: req.body.duration,
        });
        const [id] = await trx("o_storyboard").insert({
          prompt: req.body.prompt,
          duration: String(req.body.duration),
          state: req.body.state,
          filePath: req.body.src ? u.replaceUrl(req.body.src) : "",
          trackId,
          videoDesc: req.body.videoDesc,
          shouldGenerateImage: req.body.src ? 1 : req.body.shouldGenerateImage,
          scriptId: req.body.scriptId,
          projectId: req.body.projectId,
          flowId: req.body.flowId ?? null,
          referenceImages: serializeStoryboardReferences(req.body.referenceImages),
          createTime: Date.now(),
        });
        const assetIds = await validateNewStoryboardRelations(
          trx,
          { id: Number(id), projectId: req.body.projectId, scriptId: req.body.scriptId },
          req.body.associateAssetsIds,
          req.body.referenceImages,
        );
        if (assetIds.length) {
          await trx("o_assets2Storyboard").insert(assetIds.map((assetId) => ({ storyboardId: id, assetId })));
        }
        if (req.body.flowId) {
          await bindImageFlowToStoryboard(trx, req.body.flowId, {
            projectId: req.body.projectId,
            scriptId: req.body.scriptId,
            targetId: Number(id),
            selectedImageUrl: req.body.src || "",
          });
        }
        await updateTrackDuration(trx, trackId);
        return {
          id: Number(id),
          flowId: req.body.flowId ?? null,
          associateAssetsIds: assetIds,
          referenceImages: req.body.referenceImages,
          duration: req.body.duration,
        };
      });
      return res.status(200).send(success(result));
    } catch (cause) {
      if (cause instanceof StoryboardContractError) {
        return res.status(400).send(error(cause.message, { issues: cause.issues }));
      }
      throw cause;
    }
  },
);
