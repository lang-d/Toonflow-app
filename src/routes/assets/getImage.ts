import express from "express";
import { error, success } from "@/lib/responseFormat";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { getAssetImageHistory } from "@/services/assetImageHistory";
const router = express.Router();

// 获取生成图片
export default router.post(
  "/",
  validateFields({
    assetsId: z.number(),
  }),
  async (req, res) => {
    const { assetsId } = req.body;
    const data = await getAssetImageHistory(assetsId);
    if (!data) return res.status(404).send(error("资产不存在"));
    return res.status(200).send(success(data));
  },
);
