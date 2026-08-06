import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { queueMusicLibraryCompilePrompt } from "@/services/musicTaskQueue";
import { musicModelSelectionErrorData } from "@/services/musicModelSelection";

const router = express.Router();
export default router.post("/", validateFields({
  projectId: z.number(), editionId: z.number(), model: z.string().min(1).optional(), instruction: z.string().optional(),
  effectiveMusicDurationSec: z.number().optional(), requestedDurationSec: z.number().optional(), lyricsVersionId: z.number().nullable().optional(),
}), async (req, res) => {
  try { res.status(200).send(success(await queueMusicLibraryCompilePrompt(req.body))); }
  catch (cause) { res.status(400).send(error(u.error(cause).message, musicModelSelectionErrorData(cause))); }
});
