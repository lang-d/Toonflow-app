import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  StoryboardContractError,
  updateStoryboardFacts,
} from "@/services/storyboardEditor";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    storyboardId: z.number(),
    tableRowJson: z.unknown(),
  }),
  async (req, res) => {
    try {
      return res.status(200).send(success(await updateStoryboardFacts(req.body), "Storyboard facts updated"));
    } catch (cause) {
      if (cause instanceof StoryboardContractError) {
        return res.status(400).send(error(cause.message, { issues: cause.issues }));
      }
      throw cause;
    }
  },
);
