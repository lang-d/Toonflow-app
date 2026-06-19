import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { acceptReviewSuggestion } from "@/services/productionReview";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    suggestionIds: z.array(z.number()).default([]),
  }),
  async (req, res) => {
    const results = [];
    for (const id of req.body.suggestionIds) results.push(await acceptReviewSuggestion(id));
    res.status(200).send(success(results));
  },
);
