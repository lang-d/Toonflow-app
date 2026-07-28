import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { getScriptAgentWorkspace } from "@/services/scriptAgentWorkspace";

const router = express.Router();

export default router.post("/", validateFields({ projectId: z.number().int().positive(), includeContent: z.boolean().optional() }), async (req, res, next) => {
  try {
    res.status(200).send(
      success(
        await getScriptAgentWorkspace(req.body.projectId, undefined, {
          includeContent: req.body.includeContent !== false,
          includeScriptContent: req.body.includeContent !== false,
        }),
      ),
    );
  } catch (error) {
    next(error);
  }
});
