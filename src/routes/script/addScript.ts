import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { validateScriptAssetIds } from "@/services/scriptAssetBinding";
const router = express.Router();

// 新增剧本
export default router.post(
  "/",
  validateFields({
    name: z.string(),
    content: z.string(),
    projectId: z.number(),
    assets: z.array(z.number()),
  }),
  async (req, res) => {
    const { name, content, projectId, assets } = req.body;
    const { validAssetIds, invalidAssetIds } = await validateScriptAssetIds(u.db, projectId, assets);
    if (invalidAssetIds.length) {
      return res.status(400).send(error(`Invalid script asset ids: ${invalidAssetIds.join(", ")}`));
    }
    const [scriptId] = await u.db("o_script").insert({
      name,
      content,
      projectId,
      createTime: Date.now(),
    });
    if (validAssetIds.length) {
      await u.db("o_scriptAssets").insert(validAssetIds.map((assetId) => ({ scriptId, assetId })));
    }

    res.status(200).send(success({ message: "添加剧本成功" }));
  },
);
