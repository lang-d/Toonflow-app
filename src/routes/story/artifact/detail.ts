import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getArtifact, listAnnotations } from "@/services/storyArtifacts";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    id: z.number(),
    includeAnnotations: z.boolean().optional(),
  }),
  async (req, res) => {
    try {
      const artifact = await getArtifact(req.body.projectId, req.body.id);
      const annotations = req.body.includeAnnotations
        ? await listAnnotations({ projectId: req.body.projectId, artifactId: req.body.id })
        : undefined;
      res.status(200).send(success({ artifact, annotations }));
    } catch (cause) {
      res.status(400).send(error((cause as Error).message));
    }
  },
);
