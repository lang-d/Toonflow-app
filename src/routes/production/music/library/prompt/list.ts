import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { listMusicPromptVersions } from "@/services/musicLibrary";

const router = express.Router();
export default router.post("/", validateFields({ projectId: z.number(), editionId: z.number() }), async (req, res) => {
  try { res.status(200).send(success({ promptVersions: await listMusicPromptVersions(req.body) })); }
  catch (cause) { res.status(400).send(error(u.error(cause).message)); }
});
