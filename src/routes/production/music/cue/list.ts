import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { listMusicCues } from "@/services/musicDirector";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().nullable().optional(),
    planId: z.number().optional(),
  }),
  async (req, res) => {
    try {
      const cues = await listMusicCues(req.body);
      res.status(200).send(success({ cues }));
    } catch (cause) {
      res.status(400).send(error(u.error(cause).message));
    }
  },
);
