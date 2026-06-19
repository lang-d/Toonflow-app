import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { createReviewFeedback, getReviewSuggestion } from "@/services/productionReview";
import { reviewVideoTracks } from "@/services/workbenchVideoReviewer";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    suggestionId: z.number(),
    comment: z.string().default("Recalculate this suggestion."),
  }),
  async (req, res) => {
    const feedback = await createReviewFeedback({
      suggestionId: req.body.suggestionId,
      comment: req.body.comment,
      mode: "recalculate",
    });
    const suggestion = await getReviewSuggestion(req.body.suggestionId);
    let recalculated: unknown = null;
    if (suggestion?.targetType === "videoPrompt") {
      recalculated = await reviewVideoTracks({
        projectId: suggestion.projectId,
        scriptId: suggestion.scriptId ?? undefined,
        trackIds: [Number(suggestion.targetId)],
      });
    }
    res.status(200).send(success({ feedback, recalculated }));
  },
);
