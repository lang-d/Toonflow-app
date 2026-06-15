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
    deriveAssetId: z.number(),
  }),
  async (req, res) => {
    console.warn("[deprecated] use /production/editImage/getImageHistory");
    res.status(200).send(
      success(
        await getImageHistory({
          projectId: req.body.projectId,
          scriptId: req.body.scriptId,
          targetType: "deriveAsset",
          targetId: req.body.deriveAssetId,
          deriveAssetId: req.body.deriveAssetId,
        }),
      ),
    );
  },
);
