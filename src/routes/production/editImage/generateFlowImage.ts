import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createImageFlowTask } from "@/services/imageFlowTask";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().default(0),
    targetType: z.enum(["deriveAsset", "storyboard"]).optional(),
    targetId: z.number().optional(),
    deriveAssetId: z.number().optional(),
    flowId: z.number().nullable().optional(),
    nodeId: z.string().optional(),
    references: z.array(z.string()).default([]),
    model: z.string().min(1),
    quality: z.string().min(1),
    ratio: z.string().optional().default(""),
    prompt: z.string(),
  }),
  async (req, res) => {
    console.warn("[deprecated] use /production/editImage/generateFlowImageTask");
    const task = await createImageFlowTask(req.body);
    res.status(200).send(success(task, "任务已创建"));
  },
);
