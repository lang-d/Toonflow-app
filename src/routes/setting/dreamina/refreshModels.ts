import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import rawVendorData from "@/lib/vendor.json";
import {
  addQueueConfigCompatibility,
  normalizeQueueConfigForStorage,
} from "@/lib/videoQueueConfig";
import { createLogger } from "@/logger";

const router = express.Router();
const vendorData = rawVendorData as Record<string, string>;
const log = createLogger("dreamina-models", { provider: "dreamina" });

export default router.post("/", async (req, res) => {
  try {
    if (vendorData["dreamina.ts"]) {
      u.vendor.writeCode("dreamina", vendorData["dreamina.ts"]);
    }
    const models = await u.dreaminaCli.refreshModels();
    if (!Array.isArray(models) || models.length === 0) {
      log.warn("Dreamina model refresh returned no models; preserving the existing catalog", {
        event: "models.refresh.empty",
      });
      throw new Error("即梦模型探测未返回任何模型，已保留上一次有效列表，请稍后重试");
    }
    const exists = await u.db("o_vendorConfig").where("id", "dreamina").first();
    const existingModels = JSON.parse(exists?.models || "[]");
    const queueConfigMap = new Map(
      existingModels
        .filter((item: any) => item?.type === "video" && item?.modelName && item?.queueConfig)
        .map((item: any) => [u.dreaminaCli.getDreaminaProviderModelKey(item.modelName), item.queueConfig]),
    );
    const mergedModels = models.map((item: any) => {
      const queueConfig =
        item.type === "video"
          ? queueConfigMap.get(u.dreaminaCli.getDreaminaProviderModelKey(item.modelName)) || item.queueConfig
          : item.queueConfig;
      return {
        ...item,
        queueConfig: item.type === "video" ? normalizeQueueConfigForStorage(queueConfig) : queueConfig,
      };
    });
    if (!exists) {
      await u.db("o_vendorConfig").insert({
        id: "dreamina",
        inputValues: "{}",
        models: JSON.stringify(mergedModels),
        enable: 0,
      });
    } else {
      await u.db("o_vendorConfig").where("id", "dreamina").update({ models: JSON.stringify(mergedModels) });
    }
    u.vendor.invalidateCache("dreamina");
    log.info("Dreamina model catalog refreshed", {
      event: "models.refresh.completed",
      modelCount: mergedModels.length,
    });
    res.status(200).send(success(mergedModels.map(addQueueConfigCompatibility)));
  } catch (err) {
    res.status(500).send(error(u.error(err).message));
  }
});
