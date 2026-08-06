import { z } from "zod";
import { queueConfigSchema } from "@/lib/videoQueueConfig";

export const vendorModelSchema = z.discriminatedUnion("type", [
  z.object({
    name: z.string(),
    modelName: z.string(),
    type: z.literal("text"),
    think: z.boolean(),
    supportsTemperature: z.boolean().optional(),
    contextWindowTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  }),
  z.object({
    name: z.string(),
    modelName: z.string(),
    type: z.literal("image"),
    mode: z.array(z.enum(["text", "singleImage", "multiReference"])),
    queueConfig: queueConfigSchema,
  }),
  z.object({
    name: z.string(),
    modelName: z.string(),
    type: z.literal("video"),
    mode: z.array(
      z.union([
        z.enum(["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", "text", "audioReference", "videoReference"]),
        z.array(z.string().regex(/^(videoReference|imageReference|audioReference):\d+$/)),
      ]),
    ),
    audio: z.union([z.literal("optional"), z.boolean()]),
    durationResolutionMap: z.array(
      z.object({
        duration: z.array(z.number()),
        resolution: z.array(z.string()),
      }),
    ),
    queueConfig: queueConfigSchema,
  }),
  z
    .object({
      name: z.string(),
      modelName: z.string(),
      type: z.literal("music"),
      durationRange: z
        .object({
          min: z.number().optional(),
          max: z.number().optional(),
        })
        .optional(),
      durationParameter: z.boolean().optional(),
      outputFormats: z.array(z.string()).optional(),
      vocal: z.union([z.literal("optional"), z.boolean()]).optional(),
      lyrics: z.union([z.literal("optional"), z.boolean()]).optional(),
      referenceAudio: z.union([z.literal("optional"), z.boolean()]).optional(),
      loop: z.union([z.literal("optional"), z.boolean()]).optional(),
    })
    .passthrough(),
]);

export const vendorConfigSchemaBase = z.object({
  id: z.string(),
  author: z.string(),
  description: z.string().optional(),
  name: z.string(),
  icon: z.string().optional(),
  inputs: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(["text", "password", "url"]),
      required: z.boolean(),
      placeholder: z.string().optional(),
    }),
  ),
  inputValues: z.record(z.string(), z.string()),
  models: z.array(vendorModelSchema),
});
