import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";
import { normalizeQueueConfigForStorage } from "@/lib/videoQueueConfig";
import { vendorModelSchema } from "@/lib/vendorModelSchema";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.string(),
    model: vendorModelSchema,
  }),
  async (req, res) => {
    const { id, model } = req.body;
    if (model.queueConfig) model.queueConfig = normalizeQueueConfigForStorage(model.queueConfig);

    const models = await u.db("o_vendorConfig").where("id", id).first("models");
    if (models?.models) {
      const existingModels = JSON.parse(models.models);
      existingModels.push(model);
      await u
        .db("o_vendorConfig")
        .where("id", id)
        .update({
          models: JSON.stringify(existingModels),
        });
      u.vendor.invalidateCache(id);
    }
    res.status(200).send(success("更新成功"));
  },
);
