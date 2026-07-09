import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { getTaskSnapshot } from "@/services/taskCoordinator";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().optional(),
    taskIds: z.array(z.string().min(1)).max(500).optional(),
  }),
  async (req, res) => {
    const tasks = await getTaskSnapshot(req.body);
    res.status(200).send(success({ serverTime: Date.now(), tasks }));
  },
);
