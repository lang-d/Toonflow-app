import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { saveMusicPromptVersion } from "@/services/musicLibrary";
import { MusicPromptConfigValidationError } from "@/services/musicPromptProfile";

const router = express.Router();
export default router.post("/", validateFields({
  projectId: z.number(), scriptId: z.number().nullable().optional(), cueId: z.number(), promptMode: z.enum(["generic", "modelSpecific"]), model: z.string().nullable().optional(), profileSource: z.string().nullable().optional(), prompt: z.string(),
  negativePrompt: z.string().optional(), generationConfig: z.any().optional(), basedOnId: z.number().nullable().optional(),
}), async (req, res) => {
  try { res.status(200).send(success({ promptVersion: await saveMusicPromptVersion({ ...req.body, targetType: "cue", source: "user" }) })); }
  catch (cause) {
    if (cause instanceof MusicPromptConfigValidationError) {
      return res.status(400).send(error(cause.message, {
        code: cause.code,
        missingRequiredConfigKeys: cause.missingRequiredConfigKeys,
      }));
    }
    res.status(400).send(error(u.error(cause).message));
  }
});
