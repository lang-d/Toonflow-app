import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { archiveArtifact } from "@/services/storyArtifacts";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    id: z.number(),
  }),
  async (req, res) => {
    try {
      res.status(200).send(success(await archiveArtifact(req.body.projectId, req.body.id)));
    } catch (cause) {
      res.status(400).send(error((cause as Error).message));
    }
  },
);
