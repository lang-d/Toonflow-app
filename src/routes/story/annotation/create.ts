import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createAnnotation } from "@/services/storyArtifacts";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    artifactId: z.number(),
    blockId: z.string().nullable().optional(),
    startOffset: z.number().nullable().optional(),
    endOffset: z.number().nullable().optional(),
    selectedText: z.string(),
    comment: z.string(),
  }),
  async (req, res) => {
    try {
      res.status(200).send(success(await createAnnotation(req.body)));
    } catch (cause) {
      res.status(400).send(error((cause as Error).message));
    }
  },
);
