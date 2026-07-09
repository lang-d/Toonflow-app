import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createUnifiedTask, formatUnifiedTaskEnvelope } from "@/services/taskCoordinator";
import {
  chunkScriptAssetExtractionIds,
  listActiveScriptAssetExtractionScriptIds,
} from "@/services/scriptAssetExtraction";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    scriptIds: z.array(z.number()),
    projectId: z.number(),
    groupSize: z.number().int().min(1).max(5).optional(),
  }),
  async (req, res) => {
    const { scriptIds, projectId, groupSize = 5 } = req.body as {
      scriptIds: number[];
      projectId: number;
      groupSize?: number;
    };
    if (!scriptIds.length) return res.status(400).send(error("请先选择剧本"));

    const requestedIds = [...new Set(scriptIds.map(Number).filter(Number.isFinite))];
    const scripts = await u.db("o_script").where("projectId", projectId).whereIn("id", requestedIds).select("id");
    const validIds = scripts.map((script: any) => Number(script.id)).filter(Number.isFinite);
    const validSet = new Set(validIds);
    const invalidIds = requestedIds.filter((scriptId) => !validSet.has(scriptId));
    if (invalidIds.length) return res.status(400).send(error(`剧本不属于当前项目或不存在: ${invalidIds.join(",")}`));

    const activeIds = await listActiveScriptAssetExtractionScriptIds(projectId);
    const pendingIds = validIds.filter((scriptId) => !activeIds.has(scriptId));
    const skipped = validIds.filter((scriptId) => activeIds.has(scriptId)).map((scriptId) => ({ scriptId, reason: "active_task_exists" }));
    if (pendingIds.length) {
      await u.db("o_script").where("projectId", projectId).whereIn("id", pendingIds).update({
        extractState: 2,
        errorReason: null,
      });
    }

    const tasks = [];
    for (const ids of chunkScriptAssetExtractionIds(pendingIds, groupSize)) {
      const targetId = ids.join(",");
      const task = await createUnifiedTask({
        projectId,
        scriptId: ids[0],
        taskClass: "剧本资产提取",
        taskType: "prompt",
        status: "queued",
        phase: "queued",
        progress: 0,
        targetType: "scriptAssetExtraction",
        targetId,
        businessType: "script-asset-extract",
        handler: "script-asset-extract",
        describe: `提取剧本资产：${targetId}`,
        payload: {
          projectId,
          scriptIds: ids,
          groupSize: Math.max(1, Math.min(5, Math.floor(Number(groupSize) || 5))),
        },
      });
      tasks.push({ scriptIds: ids, ...formatUnifiedTaskEnvelope(task, "scriptAssetExtraction", targetId) });
    }

    return res.status(200).send(success({ total: tasks.length, tasks, skipped }));
  },
);
