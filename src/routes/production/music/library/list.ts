import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { listMusicLibrary } from "@/services/musicLibrary";

const router = express.Router();
export default router.post("/", validateFields({ projectId: z.number(), state: z.string().optional(), workType: z.string().optional() }), async (req, res) => {
  try { res.status(200).send(success({ libraryItems: await listMusicLibrary(req.body) })); }
  catch (cause) { res.status(400).send(error(u.error(cause).message)); }
});
