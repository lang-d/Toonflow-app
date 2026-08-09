import u from "@/utils";
import type { VideoProviderExecutor } from "../contracts";
import { scopedVideoProviderCapacityKey, toLegacyVideoReferences } from "../shared";

export const legacyVideoExecutor: VideoProviderExecutor = {
  vendorId: "*",

  getProviderModelKey(modelName) {
    return modelName;
  },

  async reserveSubmission(context) {
    const config = context.modelConfig?.queueConfig || {};
    return {
      kind: "ready",
      candidates: [{
        key: scopedVideoProviderCapacityKey(context.row.vendorId, context.row.providerModelKey || context.row.model),
        limit: Math.max(1, Number(config.maxConcurrent || 2)),
      }],
    };
  },

  async submit(context) {
    const references = await toLegacyVideoReferences(await context.references());
    const aiVideo = u.Ai.Video(context.row.model as `${string}:${string}`);
    await aiVideo.run({ ...context.request.input, referenceList: references } as any);
    await aiVideo.save(context.request.videoPath);
    return { kind: "completed", data: context.request.videoPath, dataType: "file" };
  },

  async poll() {
    return { kind: "failed", reason: "Legacy video execution does not expose a remote polling task." };
  },
};
