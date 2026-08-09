import type { VideoProviderExecutor } from "./contracts";
import { dreaminaVideoExecutor } from "./executors/dreamina";
import { legacyVideoExecutor } from "./executors/legacy";
import { zealmanVideoExecutor } from "./executors/zealman";

const executors = new Map<string, VideoProviderExecutor>([
  [dreaminaVideoExecutor.vendorId, dreaminaVideoExecutor],
  [zealmanVideoExecutor.vendorId, zealmanVideoExecutor],
]);

export function getVideoProviderExecutor(vendorId: string) {
  return executors.get(vendorId) || legacyVideoExecutor;
}

export function getVideoProviderModelKey(model: string) {
  const [vendorId, modelName] = model.split(/:(.+)/);
  return getVideoProviderExecutor(vendorId).getProviderModelKey(modelName);
}

export function listVideoProviderExecutors() {
  return [...executors.values(), legacyVideoExecutor];
}

