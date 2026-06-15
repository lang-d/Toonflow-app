import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createDirectorAsset, DirectorAssetError } from "@/services/directorAsset";

const router = express.Router();

const sourceRefSchema = z.object({
  source: z.enum(["asset", "storyboard", "local", "generated", "directorAsset"]).optional(),
  sourceId: z.union([z.number(), z.string()]).optional(),
  mediaPath: z.string().optional(),
  order: z.number(),
  label: z.string().optional(),
});

export default router.post(
  "/",
  validateFields({
    base64Data: z.string(),
    projectId: z.number(),
    scriptId: z.number().optional().nullable(),
    flowId: z.number().optional().nullable(),
    nodeId: z.string(),
    targetType: z.enum(["deriveAsset", "storyboard"]).optional(),
    targetId: z.number().optional().nullable(),
    assetType: z.enum(["sceneShot", "blockingShot", "cameraShot", "compositionRef"]),
    name: z.string().min(1),
    promptFragment: z.string().optional(),
    sourceRefs: z.array(sourceRefSchema).default([]),
    camera: z.unknown().optional(),
    stageDraft: z.unknown().optional(),
  }),
  async (req, res) => {
    try {
      const data = await createDirectorAsset(req.body);
      res.status(200).send(success(data));
    } catch (err: any) {
      const status = err instanceof DirectorAssetError ? err.statusCode : 400;
      res.status(status).send(error(err?.message || "Failed to create director asset"));
    }
  },
);
