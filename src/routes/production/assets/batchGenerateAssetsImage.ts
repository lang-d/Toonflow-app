import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { DERIVE_ASSET_DEFAULT_RATIO } from "@/services/imageFlow";
import { createImageFlowTask } from "@/services/imageFlowTask";
import u from "@/utils";

const router = express.Router();

export async function createBatchDeriveAssetImageTasks(input: {
  projectId: number;
  scriptId: number;
  assetIds: number[];
  model: string;
  quality: string;
  ratio: string;
}) {
  const tasks = [];
  const errors: Array<{ assetId: number; error: string }> = [];
  for (const assetId of [...new Set<number>(input.assetIds)]) {
    try {
      const task = await createImageFlowTask({
        projectId: input.projectId,
        scriptId: input.scriptId,
        targetType: "deriveAsset",
        targetId: assetId,
        deriveAssetId: assetId,
        references: [],
        model: input.model,
        quality: input.quality,
        ratio: DERIVE_ASSET_DEFAULT_RATIO,
        prompt: "",
      });
      tasks.push({ assetId, ...task });
    } catch (error) {
      errors.push({ assetId, error: u.error(error).message });
    }
  }
  return {
    total: tasks.length + errors.length,
    tasks,
    successCount: tasks.length,
    failedCount: errors.length,
    errors,
  };
}

export default router.post(
  "/",
  validateFields({
    projectId: z.union([z.string(), z.number()]).transform(Number),
    scriptId: z.number(),
    assetIds: z.array(z.number()).min(1),
    model: z.string().min(1),
    quality: z.string().min(1),
    ratio: z.string().min(1),
    concurrentCount: z.number().int().min(1).optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId, assetIds, model, quality, ratio } = req.body;
    return res.status(200).send(success(await createBatchDeriveAssetImageTasks({ projectId, scriptId, assetIds, model, quality, ratio })));
  },
);
