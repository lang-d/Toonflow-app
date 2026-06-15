import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createMergedReference } from "@/services/workbenchMergedReference";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackId: z.number(),
    mergeType: z.enum(["storyboard", "assets"]),
    refs: z
      .array(
        z.object({
          id: z.number(),
          sources: z.enum(["storyboard", "assets", "directorAsset"]),
          src: z.string().optional(),
          order: z.number(),
          label: z.string().optional(),
          category: z.enum(["role", "scene", "tool", "clip", "directorAsset", "other"]).optional(),
          parentName: z.string().optional(),
          name: z.string().optional(),
          index: z.number().optional(),
        }),
      )
      .min(2)
      .max(30),
  }),
  async (req, res) => {
    try {
      const data = await createMergedReference(req.body);
      res.status(200).send(success(data));
    } catch (e) {
      res.status(400).send(error((e as Error).message));
    }
  },
);
