import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createUnifiedTask, formatUnifiedTaskEnvelope } from "@/services/taskCoordinator";
import {
  selectAssetFoundationTargets,
  type AssetFoundationMode,
  type AssetFoundationType,
} from "@/services/assetFoundation";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    assetIds: z.array(z.number()).optional(),
    type: z.enum(["role", "scene", "tool"]).optional(),
    mode: z.enum(["selected", "missingOnly", "all"]).optional(),
    instruction: z.string().optional(),
    overwrite: z.boolean().optional(),
    generatePrompt: z.boolean().optional(),
  }),
  async (req, res) => {
    const {
      projectId,
      assetIds,
      type,
      mode,
      instruction = "",
      overwrite = false,
      generatePrompt = true,
    } = req.body as {
      projectId: number;
      assetIds?: number[];
      type?: AssetFoundationType;
      mode?: AssetFoundationMode;
      instruction?: string;
      overwrite?: boolean;
      generatePrompt?: boolean;
    };
    if (mode === "selected" && !assetIds?.length) {
      return res.status(400).send(error("selected 模式必须传入 assetIds"));
    }
    const { rows, skipped } = await selectAssetFoundationTargets({
      projectId,
      assetIds,
      type,
      mode,
      overwrite,
      generatePrompt,
    });
    if (!rows.length) return res.status(200).send(success({ total: 0, tasks: [], skipped }));

    const assetIdsToQueue = rows.map((row: any) => Number(row.id));
    await u.db("o_assets").whereIn("id", assetIdsToQueue).update({
      foundationStatus: "processing",
      foundationErrorReason: null,
      ...(generatePrompt ? { promptState: "生成中", promptErrorReason: null } : {}),
    });

    const tasks = [];
    for (const asset of rows) {
      const task = await createUnifiedTask({
        projectId,
        taskClass: "资产基础设定生成",
        taskType: "prompt",
        status: "queued",
        targetType: "asset",
        targetId: asset.id,
        businessType: "asset",
        businessId: Number(asset.id),
        handler: "asset-foundation",
        describe: `生成资产基础设定：${asset.name}`,
        payload: {
          projectId,
          assetId: Number(asset.id),
          instruction,
          overwrite,
          generatePrompt,
        },
      });
      tasks.push({ assetId: Number(asset.id), ...formatUnifiedTaskEnvelope(task, "asset", asset.id) });
    }
    return res.status(200).send(success({ total: tasks.length, tasks, skipped }));
  },
);
