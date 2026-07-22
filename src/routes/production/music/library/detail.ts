import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { getMusicLibraryDetail } from "@/services/musicLibrary";

const router = express.Router();
export default router.post("/", validateFields({ projectId: z.number(), libraryItemId: z.number() }), async (req, res) => {
  try { res.status(200).send(success({ libraryItem: await getMusicLibraryDetail(req.body) })); }
  catch (cause) { res.status(400).send(error(u.error(cause).message)); }
});
