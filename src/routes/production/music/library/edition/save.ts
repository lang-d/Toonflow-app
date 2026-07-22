import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { saveMusicLibraryEdition } from "@/services/musicLibrary";

const router = express.Router();
export default router.post("/", validateFields({
  projectId: z.number(), libraryItemId: z.number(), editionId: z.number().optional(), editionKey: z.string(),
  editionType: z.enum(["master", "narrative_variant", "arrangement", "vocal_variant", "instrumental", "short_edit", "custom"]),
  parentEditionId: z.number().nullable().optional(), title: z.string().optional(), narrativePhase: z.string().optional(),
  episodeStart: z.number().nullable().optional(), episodeEnd: z.number().nullable().optional(),
  vocalMode: z.enum(["instrumental", "vocal", "optional"]).optional(), language: z.string().optional(), musicSpec: z.any().optional(),
  state: z.enum(["planned", "ready", "archived"]).optional(),
}), async (req, res) => {
  try { res.status(200).send(success({ edition: await saveMusicLibraryEdition(req.body) })); }
  catch (cause) { res.status(400).send(error(u.error(cause).message)); }
});
