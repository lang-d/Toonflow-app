import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { isVisualAssetType } from "@/services/assetTypes";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.union([z.string(), z.number()]).transform(Number),
    scriptId: z.number(),
    assetsId: z.number(),
    name: z.string(),
    desc: z.string(),
  }),
  async (req, res) => {
    const { projectId, scriptId, assetsId, name, desc } = req.body;

    const parent = await u.db("o_assets").where("id", assetsId).where("projectId", projectId).first();
    if (!parent) return res.status(400).send(error("父资产不存在"));
    if (!isVisualAssetType(parent.type)) return res.status(400).send(error("仅支持角色、场景、道具新增衍生资产"));

    const id = Date.now();
    await u.db("o_assets").insert({
      id,
      name,
      describe: desc,
      prompt: "",
      type: parent.type,
      scriptId,
      projectId,
      assetsId,
      promptState: "未生成",
      startTime: Date.now(),
    });

    res.status(200).send(success({
      id,
      assetsId,
      name,
      desc,
      prompt: "",
      src: "",
      state: "未生成",
      type: parent.type,
      flowId: null,
      errorReason: "",
    }));
  },
);
