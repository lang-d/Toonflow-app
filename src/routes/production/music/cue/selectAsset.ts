import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { selectMusicCueAsset } from "@/services/musicAsset";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    cueId: z.number(),
    musicCueAssetId: z.number(),
  }),
  async (req, res) => {
    try {
      const result = await selectMusicCueAsset(req.body);
      res.status(200).send(success({ musicCueAsset: result }));
    } catch (cause) {
      res.status(400).send(error(u.error(cause).message));
    }
  },
);
