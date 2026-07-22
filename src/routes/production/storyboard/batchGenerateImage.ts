import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { enqueueStoryboardImageGeneration } from "@/services/storyboardImageGeneration";

const router = express.Router();

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
    try {
      const result = await enqueueStoryboardImageGeneration({
        projectId: req.body.projectId,
        scriptId: req.body.scriptId,
        storyboardIds: req.body.storyboardIds,
        compulsory: req.body.compulsory,
      });
      if (result.errors.length) console.warn("[storyboard] batchGenerateImage partial failures", result.errors);
      console.info("[storyboard] batchGenerateImage created tasks", {
        projectId: req.body.projectId,
        scriptId: req.body.scriptId,
        storyboardIds: req.body.storyboardIds,
        compulsory: Boolean(req.body.compulsory),
        createdCount: result.successCount,
        failedCount: result.failedCount,
      });
      return res.status(200).send(success(result.rows));
    } catch (cause) {
      return res.status(400).send(error(cause instanceof Error ? cause.message : String(cause)));
    }
  },
);
