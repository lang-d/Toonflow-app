import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { queueMusicLibraryGenerate } from "@/services/musicTaskQueue";

const router = express.Router();
export default router.post("/", validateFields({ projectId: z.number(), editionId: z.number(), promptVersionId: z.number(), lyricsVersionId: z.number().nullable().optional(), acknowledgeWarnings: z.boolean().optional() }), async (req, res) => {
  try { res.status(200).send(success(await queueMusicLibraryGenerate(req.body))); }
  catch (cause) { res.status(400).send(error(u.error(cause).message)); }
});
