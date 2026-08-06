import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  StoryboardContractError,
  updateStoryboardPanelFields,
} from "@/services/storyboardEditor";

const router = express.Router();

const referenceSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  source: z.enum(["local", "storyboard", "directorAsset"]),
  sourceId: z.union([z.string(), z.number()]).nullable().optional(),
  url: z.string(),
  previewUrl: z.string().optional(),
  label: z.string().optional(),
  group: z.string().optional(),
  type: z.string().optional(),
}).passthrough();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    storyboardId: z.number(),
    prompt: z.string(),
    shouldGenerateImage: z.boolean(),
    associateAssetsIds: z.array(z.number()).default([]),
    referenceImages: z.array(referenceSchema).default([]),
  }),
  async (req, res) => {
    try {
      return res.status(200).send(success(await updateStoryboardPanelFields(req.body), "Storyboard panel updated"));
    } catch (cause) {
      if (cause instanceof StoryboardContractError) {
        return res.status(400).send(error(cause.message, { issues: cause.issues }));
      }
      throw cause;
    }
  },
);
