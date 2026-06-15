import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getImageHistory } from "@/services/imageFlow";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.union([z.string(), z.number()]).transform(Number),
    scriptId: z.number(),
    targetType: z.enum(["deriveAsset", "storyboard"]).optional(),
    targetId: z.number().optional(),
    deriveAssetId: z.number().optional(),
  }),
  async (req, res) => {
    res.status(200).send(success(await getImageHistory(req.body)));
  },
);
