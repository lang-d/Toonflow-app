import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { ImageFlowValidationError, saveImageFlow } from "@/services/imageFlow";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    flowId: z.number().nullable().optional(),
    projectId: z.number().optional(),
    scriptId: z.number().optional(),
    targetType: z.enum(["deriveAsset", "storyboard"]).optional(),
    targetId: z.number().optional(),
    nodes: z.array(z.any()),
    edges: z.array(z.any()),
    selectedImageUrl: z.string().optional(),
    selectedMediaPath: z.string().optional(),
  }),
  async (req, res) => {
    if (req.body.projectId == null || req.body.scriptId == null || !req.body.targetType || req.body.targetId == null) {
      console.warn("[deprecated] saveImageFlow should include projectId, scriptId, targetType and targetId");
    }
    try {
      const flowId = await saveImageFlow(req.body);
      res.status(200).send(success({ flowId, id: flowId }));
    } catch (cause) {
      if (cause instanceof ImageFlowValidationError) {
        return res.status(400).send(error(cause.message, { issues: cause.issues }));
      }
      throw cause;
    }
  },
);
