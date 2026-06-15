import { z } from "zod";

export const queueConfigSchema = z
  .object({
    maxConcurrent: z.coerce.number().int().min(1).max(20).optional(),
    pollInitialDelaySec: z.coerce.number().int().min(0).max(3600).optional(),
    pollMinIntervalSec: z.coerce.number().int().min(15).max(3600).optional(),
    pollMaxIntervalSec: z.coerce.number().int().min(30).max(7200).optional(),
    maxWorkHours: z.coerce.number().min(1).max(72).optional(),
    maxWaitHours: z.coerce.number().min(1).max(72).optional(),
  })
  .transform((config) => {
    const { maxWaitHours, ...rest } = config;
    return {
      ...rest,
      maxWorkHours: config.maxWorkHours ?? maxWaitHours,
    };
  })
  .optional();

export function normalizeQueueConfigForStorage(config: any) {
  if (!config || typeof config !== "object") return config;
  const { maxWaitHours, ...rest } = config;
  return {
    ...rest,
    maxWorkHours: config.maxWorkHours ?? maxWaitHours ?? 6,
  };
}

export function addQueueConfigCompatibility(model: any) {
  if (!model?.queueConfig || typeof model.queueConfig !== "object") return model;
  const maxWorkHours = Number(model.queueConfig.maxWorkHours ?? model.queueConfig.maxWaitHours ?? 6);
  return {
    ...model,
    queueConfig: {
      ...model.queueConfig,
      maxWorkHours,
      maxWaitHours: maxWorkHours,
    },
  };
}
