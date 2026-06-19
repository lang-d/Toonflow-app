import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { STORY_ANNOTATION_STATUSES, updateAnnotationStatus } from "@/services/storyArtifacts";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    id: z.number(),
    status: z.enum(STORY_ANNOTATION_STATUSES),
  }),
  async (req, res) => {
    try {
      res.status(200).send(success(await updateAnnotationStatus({ projectId: req.body.projectId, ids: [req.body.id], status: req.body.status })));
    } catch (cause) {
      res.status(400).send(error((cause as Error).message));
    }
  },
);
