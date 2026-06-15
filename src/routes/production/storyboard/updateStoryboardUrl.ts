import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { updateImageFlowTarget } from "@/services/imageFlow";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    url: z.string(),
    flowId: z.number(),
  }),
  async (req, res) => {
    console.warn("[deprecated] save target through /production/editImage/saveImageFlow");
    await u.db.transaction((trx: any) =>
      updateImageFlowTarget(trx, {
        targetType: "storyboard",
        targetId: req.body.id,
        flowId: req.body.flowId,
        selectedImageUrl: req.body.url,
      }),
    );
    res.status(200).send(success({ flowId: req.body.flowId }, "更新分镜成功"));
  },
);
