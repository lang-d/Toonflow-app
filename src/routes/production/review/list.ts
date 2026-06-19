import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { listReviewSuggestions } from "@/services/productionReview";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().optional(),
    targetType: z.string().optional(),
    targetId: z.union([z.string(), z.number()]).optional(),
    status: z.string().optional(),
  }),
  async (req, res) => {
    res.status(200).send(success(await listReviewSuggestions(req.body)));
  },
);
