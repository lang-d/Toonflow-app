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
    modelName: z.string(),
    model: vendorModelSchema,
  }),
  async (req, res) => {
    const { id, modelName, model } = req.body;
    if (model.queueConfig) model.queueConfig = normalizeQueueConfigForStorage(model.queueConfig);

    const models = await u.db("o_vendorConfig").where("id", id).first("models");
    if (models?.models) {
      const existingModels = JSON.parse(models.models);
      const modelIndex = existingModels.findIndex((m: any) => m.modelName === modelName);
      if (modelIndex === -1) {
        existingModels.push(model);
      } else {
        existingModels[modelIndex] = model;
      }
      if (id === "dreamina" && model.type === "video" && model.queueConfig) {
        const providerModelKey = u.dreaminaCli.getDreaminaProviderModelKey(model.modelName);
        for (const item of existingModels) {
          if (
            item?.type === "video" &&
            u.dreaminaCli.getDreaminaProviderModelKey(item.modelName) === providerModelKey
          ) {
            item.queueConfig = model.queueConfig;
          }
        }
      }
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
