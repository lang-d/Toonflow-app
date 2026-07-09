import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { getMusicStageState } from "@/services/musicStageState";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().nullable().optional(),
    mode: z.enum(["concept", "project", "episode"]).optional(),
  }),
  async (req, res) => {
    try {
      const state = await getMusicStageState(req.body);
      res.status(200).send(success(state));
    } catch (cause) {
      res.status(400).send(error(u.error(cause).message));
    }
  },
);
