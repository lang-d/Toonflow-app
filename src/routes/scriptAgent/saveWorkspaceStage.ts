import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { SCRIPT_AGENT_STAGES, saveScriptAgentStage } from "@/services/scriptAgentWorkspace";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ projectId: z.number().int().positive(), stage: z.enum(SCRIPT_AGENT_STAGES), content: z.string() }),
  async (req, res, next) => {
    try {
      res.status(200).send(success(await saveScriptAgentStage(req.body)));
    } catch (error) {
      next(error);
    }
  },
);
