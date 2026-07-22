import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { getScriptAgentWorkspace } from "@/services/scriptAgentWorkspace";

const router = express.Router();

export default router.post("/", validateFields({ projectId: z.number().int().positive() }), async (req, res, next) => {
  try {
    res.status(200).send(success(await getScriptAgentWorkspace(req.body.projectId)));
  } catch (error) {
    next(error);
  }
});
