import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { rollbackReviewSuggestion } from "@/services/productionReview";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ id: z.number() }),
  async (req, res) => {
    res.status(200).send(success(await rollbackReviewSuggestion(req.body.id)));
  },
);
