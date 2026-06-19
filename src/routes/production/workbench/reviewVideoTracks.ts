import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { reviewVideoTracks } from "@/services/workbenchVideoReviewer";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().optional(),
    trackIds: z.array(z.number()).optional(),
  }),
  async (req, res) => {
    res.status(200).send(success(await reviewVideoTracks(req.body)));
  },
);
