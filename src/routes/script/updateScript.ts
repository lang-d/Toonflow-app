import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { validateScriptAssetIds } from "@/services/scriptAssetBinding";
import { replaceScriptContent } from "@/services/scriptWorkspaceText";
const router = express.Router();

// 编辑剧本
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    name: z.string(),
    content: z.string(),
    assets: z.array(z.number()),
  }),
  async (req, res) => {
    const { id, name, content, assets } = req.body;
    const script = await u.db("o_script").where({ id }).first("id", "projectId");
    if (!script) return res.status(404).send(error("Script not found"));
    const { validAssetIds, invalidAssetIds } = await validateScriptAssetIds(u.db, Number(script.projectId), assets);
    if (invalidAssetIds.length) {
      return res.status(400).send(error(`Invalid script asset ids: ${invalidAssetIds.join(", ")}`));
    }
    await replaceScriptContent({ projectId: Number(script.projectId), scriptId: id, name, content });
    await u.db("o_scriptAssets").where({ scriptId: id }).delete();
    if (validAssetIds.length) {
      await u.db("o_scriptAssets").insert(validAssetIds.map((assetId) => ({ scriptId: id, assetId })));
    }

    res.status(200).send(success({ message: "编辑剧本成功" }));
  },
);
