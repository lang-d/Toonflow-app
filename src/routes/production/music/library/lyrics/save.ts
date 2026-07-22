import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { saveMusicLyricsVersion } from "@/services/musicLibrary";

const router = express.Router();
export default router.post("/", validateFields({
  projectId: z.number(), editionId: z.number(), title: z.string().optional(), language: z.string().optional(), content: z.string(), basedOnId: z.number().nullable().optional(),
}), async (req, res) => {
  try { res.status(200).send(success({ lyricsVersion: await saveMusicLyricsVersion({ ...req.body, source: "user" }) })); }
  catch (cause) { res.status(400).send(error(u.error(cause).message)); }
});
