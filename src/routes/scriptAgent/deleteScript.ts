import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { deleteScriptAgentScript } from "@/services/scriptAgentWorkspace";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ projectId: z.number().int().positive(), id: z.number().int().positive() }),
  async (req, res, next) => {
    try {
      res.status(200).send(success(await deleteScriptAgentScript(req.body)));
    } catch (error) {
      next(error);
    }
  },
);
