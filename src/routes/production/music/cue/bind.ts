import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { bindMusicCue } from "@/services/musicLibrary";

const router = express.Router();
export default router.post("/", validateFields({
  projectId: z.number(), cueId: z.number(), usageMode: z.enum(["reuse", "new", "silence"]),
  editionId: z.number().nullable().optional(), libraryVersionId: z.number().nullable().optional(), suggestedUseDurationSec: z.number().nullable().optional(),
}), async (req, res) => {
  try { res.status(200).send(success({ binding: await bindMusicCue(req.body) })); }
  catch (cause) { res.status(400).send(error(u.error(cause).message)); }
});
