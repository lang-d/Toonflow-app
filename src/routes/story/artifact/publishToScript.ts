import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { publishArtifactToScript } from "@/services/storyArtifacts";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    artifactId: z.number().optional(),
    id: z.number().optional(),
    scriptId: z.number().nullable().optional(),
    name: z.string().optional(),
    title: z.string().optional(),
    assets: z.array(z.number()).optional(),
  }),
  async (req, res) => {
    try {
      const artifactId = req.body.artifactId ?? req.body.id;
      if (!artifactId) {
        res.status(400).send(error("Missing artifact id"));
        return;
      }
      res.status(200).send(
        success(
          await publishArtifactToScript({
            ...req.body,
            artifactId,
            name: req.body.name ?? req.body.title,
          }),
        ),
      );
    } catch (cause) {
      res.status(400).send(error((cause as Error).message));
    }
  },
);
