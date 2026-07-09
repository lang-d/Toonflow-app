import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    taskId: z.string().min(1),
  }),
  async (req, res) => {
    const { taskId } = req.body;
    const data = await u.db("o_tasks").where("taskId", taskId).select("*").first();
    res.status(200).send(success(data));
  }
);
