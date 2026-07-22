import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { upsertScriptAgentScript } from "@/services/scriptAgentWorkspace";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number().int().positive(),
    id: z.number().int().positive().optional(),
    name: z.string().trim().min(1),
    content: z.string(),
  }),
  async (req, res, next) => {
    try {
      res.status(200).send(success(await upsertScriptAgentScript(req.body)));
    } catch (error) {
      next(error);
    }
  },
);
