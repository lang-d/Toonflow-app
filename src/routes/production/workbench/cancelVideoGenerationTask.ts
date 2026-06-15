import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  cancelQueuedVideoGenerationTask,
  VideoQueueCancelError,
} from "@/utils/videoGenerationQueue";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    taskId: z.number(),
  }),
  async (req, res) => {
    try {
      return res.status(200).send(success(await cancelQueuedVideoGenerationTask(req.body.taskId)));
    } catch (cause) {
      if (cause instanceof VideoQueueCancelError) {
        return res.status(cause.statusCode).send(error(cause.message));
      }
      throw cause;
    }
  },
);
