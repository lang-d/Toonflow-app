import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { resolveReviewBatch } from "@/services/productionReviewResolution";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().optional(),
    targetType: z.enum(["videoPrompt", "storyboard", "storyboardGroup"]),
    targetId: z.union([z.string(), z.number()]),
    acceptSuggestionIds: z.array(z.number()).default([]),
    ignoreSuggestionIds: z.array(z.number()).default([]),
    userInstruction: z.string().optional(),
    actions: z
      .array(
        z.object({
          suggestionId: z.number(),
          action: z.enum(["accept", "ignore", "revise"]),
          instruction: z.string().optional(),
        }),
      )
      .optional(),
  }),
  async (req, res) => {
    res.status(200).send(success(await resolveReviewBatch(req.body)));
  },
);
