import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    args: z.array(z.string()).optional(),
  }),
  async (req, res) => {
    try {
      res.status(200).send(success(await u.dreaminaCli.listTask(req.body.args || [])));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
