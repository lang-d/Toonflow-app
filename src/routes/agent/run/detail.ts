import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { getAgentRunDetail } from "@/services/agentRun";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    runId: z.string().min(1),
  }),
  async (req, res) => {
    const detail = await getAgentRunDetail(req.body.runId);
    res.status(200).send(success(detail));
  },
);

