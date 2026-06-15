import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getImageFlow } from "@/services/imageFlow";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number().optional(),
    flowId: z.number().optional(),
  }),
  async (req, res) => {
    const flowId = req.body.flowId ?? req.body.id;
    if (!flowId) return res.status(400).send(error("flowId 不能为空"));
    res.status(200).send(success(await getImageFlow(flowId)));
  },
);
