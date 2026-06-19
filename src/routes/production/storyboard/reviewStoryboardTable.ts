import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { reviewStoryboardTable } from "@/services/storyboardTableReviewer";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
  }),
  async (req, res) => {
    res.status(200).send(success(await reviewStoryboardTable(req.body.projectId, req.body.scriptId)));
  },
);
