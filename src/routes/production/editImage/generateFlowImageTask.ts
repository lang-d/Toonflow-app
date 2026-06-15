import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createImageFlowTask } from "@/services/imageFlowTask";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.union([z.string(), z.number()]).transform(Number),
    scriptId: z.number(),
    targetType: z.enum(["deriveAsset", "storyboard"]).optional(),
    targetId: z.number().optional(),
    deriveAssetId: z.number().optional(),
    flowId: z.number().nullable().optional(),
    nodeId: z.string().min(1).optional(),
    references: z.array(z.string()).default([]),
    referenceMediaPaths: z.array(z.string()).optional(),
    model: z.string().min(1),
    quality: z.string().min(1),
    ratio: z.string().min(1),
    prompt: z.string(),
  }),
  async (req, res) => {
    const task = await createImageFlowTask(req.body);
    res.status(200).send(success(task));
  },
);
