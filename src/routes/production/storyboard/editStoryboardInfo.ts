import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  saveStoryboardEditor,
  StoryboardContractError,
} from "@/services/storyboardEditor";

const router = express.Router();
const referenceSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    source: z.enum(["local", "storyboard"]),
    sourceId: z.union([z.string(), z.number()]).nullable().optional(),
    url: z.string(),
    previewUrl: z.string().optional(),
    label: z.string().optional(),
    group: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    prompt: z.string(),
    videoDesc: z.string(),
    duration: z.number().nonnegative(),
    associateAssetsIds: z.array(z.number()).default([]),
    referenceImages: z.array(referenceSchema).default([]),
    scene: z.string().optional(),
    picture: z.string().optional(),
    action: z.string().optional(),
    shotSize: z.string().optional(),
    cameraMove: z.string().optional(),
    dialogue: z.string().optional(),
    sound: z.string().optional(),
    visibleEmotion: z.string().optional(),
    location: z.string().optional(),
    timeOfDay: z.string().optional(),
    sceneContinuityId: z.string().optional(),
    groupKey: z.string().optional(),
    groupName: z.string().optional(),
    groupIntent: z.string().optional(),
    beatId: z.string().optional(),
    characters: z.array(z.any()).optional(),
    dialogueItems: z.array(z.any()).optional(),
    soundEffects: z.array(z.string()).optional(),
    requiredAssets: z.array(z.any()).optional(),
    tableRowJson: z.any().optional(),
  }),
  async (req, res) => {
    try {
      const result = await saveStoryboardEditor(req.body);
      return res.status(200).send(success(result, "更新分镜成功"));
    } catch (cause) {
      if (cause instanceof StoryboardContractError) {
        return res.status(400).send(error(cause.message, { issues: cause.issues }));
      }
      throw cause;
    }
  },
);
