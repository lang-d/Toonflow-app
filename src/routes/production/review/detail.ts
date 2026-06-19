import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getReviewSuggestion } from "@/services/productionReview";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ id: z.number() }),
  async (req, res) => {
    const suggestion = await getReviewSuggestion(req.body.id);
    if (!suggestion) return res.status(404).send(error("Review suggestion does not exist"));
    res.status(200).send(success(suggestion));
  },
);
