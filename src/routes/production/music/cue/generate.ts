import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { queueMusicCueGenerate } from "@/services/musicTaskQueue";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    cueId: z.number(),
    promptVersionId: z.number(),
    select: z.boolean().optional(),
    acknowledgeWarnings: z.boolean().optional(),
  }),
  async (req, res) => {
    try {
      const task = await queueMusicCueGenerate(req.body);
      res.status(200).send(success(task));
    } catch (cause) {
      res.status(400).send(error(u.error(cause).message));
    }
  },
);
