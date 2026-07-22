import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { queueMusicLibraryTrim } from "@/services/musicTaskQueue";

const router = express.Router();
export default router.post("/", validateFields({
  projectId: z.number(), sourceLibraryVersionId: z.number(), startMs: z.number(), endMs: z.number(),
  fadeInMs: z.number().optional(), fadeOutMs: z.number().optional(), title: z.string(), bindCueId: z.number().nullable().optional(), select: z.boolean().optional(),
}), async (req, res) => {
  try { res.status(200).send(success(await queueMusicLibraryTrim(req.body))); }
  catch (cause) { res.status(400).send(error(u.error(cause).message)); }
});
