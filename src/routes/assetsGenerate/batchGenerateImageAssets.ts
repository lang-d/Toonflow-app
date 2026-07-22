import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { enqueueAssetImageGeneration } from "@/services/assetImageGeneration";

const router = express.Router();

const requestSchema = {
  projectId: z.number(),
  model: z.string().optional(),
  resolution: z.string().optional(),
  concurrentCount: z.number().int().min(1).optional(),
  items: z.array(
    z.object({
      id: z.number(),
      type: z.string(),
      name: z.string(),
      prompt: z.string(),
      base64: z.string().optional().nullable(),
    }),
  ),
};

export default router.post("/", validateFields(requestSchema), async (req, res) => {
  try {
    const result = await enqueueAssetImageGeneration({
      projectId: req.body.projectId,
      model: req.body.model,
      resolution: req.body.resolution,
      items: req.body.items,
    });
    return res.status(200).send(success(result));
  } catch (cause) {
    return res.status(400).send(error(cause instanceof Error ? cause.message : String(cause)));
  }
});
