import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { listArtifacts, STORY_ARTIFACT_STATUSES, STORY_ARTIFACT_TYPES } from "@/services/storyArtifacts";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    type: z.enum(STORY_ARTIFACT_TYPES).optional(),
    status: z.enum(STORY_ARTIFACT_STATUSES).optional(),
    includeArchived: z.boolean().optional(),
  }),
  async (req, res) => {
    try {
      res.status(200).send(success(await listArtifacts(req.body)));
    } catch (cause) {
      res.status(400).send(error((cause as Error).message));
    }
  },
);
