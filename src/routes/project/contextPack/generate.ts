import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { queueProjectContextPackGenerate } from "@/services/musicTaskQueue";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    instruction: z.string().optional(),
    previousContent: z.string().optional(),
  }),
  async (req, res) => {
    try {
      const task = await queueProjectContextPackGenerate({
        projectId: req.body.projectId,
        instruction: req.body.instruction,
        previousContent: req.body.previousContent,
      });
      res.status(200).send(success(task));
    } catch (err: any) {
      res.status(400).send(error(err?.message || "Project context pack generation failed"));
    }
  },
);
