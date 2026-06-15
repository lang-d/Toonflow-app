import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    submitId: z.string(),
    download: z.boolean().optional(),
  }),
  async (req, res) => {
    try {
      res.status(200).send(success(await u.dreaminaCli.queryTask(req.body.submitId, !!req.body.download)));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
