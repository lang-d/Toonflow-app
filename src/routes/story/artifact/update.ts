import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { STORY_ARTIFACT_STATUSES, updateArtifact } from "@/services/storyArtifacts";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    id: z.number(),
    title: z.string().optional(),
    content: z.string().optional(),
    contentJson: z.any().optional(),
    status: z.enum(STORY_ARTIFACT_STATUSES).optional(),
  }),
  async (req, res) => {
    try {
      res.status(200).send(success(await updateArtifact(req.body)));
    } catch (cause) {
      res.status(400).send(error((cause as Error).message));
    }
  },
);
