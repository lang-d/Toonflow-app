import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { createReviewFeedback } from "@/services/productionReview";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    suggestionId: z.number(),
    comment: z.string(),
    mode: z.enum(["note", "recalculate"]).default("note"),
  }),
  async (req, res) => {
    res.status(200).send(success(await createReviewFeedback(req.body)));
  },
);
