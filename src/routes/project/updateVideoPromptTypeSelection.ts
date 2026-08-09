import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { updateProjectVideoPromptTypeSelection } from "@/services/videoPromptTypeSelection";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    model: z.string().trim().min(3),
    videoPromptType: z.string().trim().max(80).nullable(),
  }),
  async (req, res) => {
    const { projectId, model, videoPromptType } = req.body;
    try {
      const selectedVideoPromptType = await updateProjectVideoPromptTypeSelection(projectId, model, videoPromptType);
      res.status(200).send(success({ selectedVideoPromptType }));
    } catch (cause) {
      res.status(400).send(error(u.error(cause).message));
    }
  },
);
