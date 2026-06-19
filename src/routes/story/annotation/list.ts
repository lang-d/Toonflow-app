import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { listAnnotations, STORY_ANNOTATION_STATUSES } from "@/services/storyArtifacts";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    artifactId: z.number(),
    status: z.enum(STORY_ANNOTATION_STATUSES).optional(),
  }),
  async (req, res) => {
    try {
      res.status(200).send(success(await listAnnotations(req.body)));
    } catch (cause) {
      res.status(400).send(error((cause as Error).message));
    }
  },
);
