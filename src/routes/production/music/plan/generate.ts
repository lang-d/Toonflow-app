import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { queueMusicPlanGenerate } from "@/services/musicTaskQueue";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().nullable().optional(),
    mode: z.enum(["concept", "project", "episode"]),
    bibleId: z.number().optional(),
    instruction: z.string().optional(),
  }),
  async (req, res) => {
    try {
      const task = await queueMusicPlanGenerate(req.body);
      res.status(200).send(success(task));
    } catch (cause) {
      res.status(400).send(error(u.error(cause).message));
    }
  },
);
