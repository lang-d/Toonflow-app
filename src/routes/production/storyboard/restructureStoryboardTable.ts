import express from "express";
import { z } from "zod";
import { error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

/**
 * Historical restructuring is intentionally handled by the production Agent
 * through begin_storyboard_table -> append_storyboard_rows -> commit_storyboard_table.
 * This endpoint no longer asks a model for prose/JSON and then extracts it in backend code.
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    textAssetId: z.number().optional(),
    instruction: z.string().optional(),
  }),
  async (_req, res) =>
    res.status(409).send(
      error(
        "请在生产 Agent 中发起“结构化整理分镜表”。整理过程必须通过结构化分批工具提交，后端不再解析 AI 文本。",
      ),
    ),
);
