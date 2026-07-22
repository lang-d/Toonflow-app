import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { createMusicLibraryItem } from "@/services/musicLibrary";

const router = express.Router();
export default router.post("/", validateFields({
  projectId: z.number(), bibleId: z.number().nullable().optional(), workKey: z.string(),
  workType: z.enum(["theme_song", "opening_song", "ending_song", "insert_song", "score_theme", "source_music", "stinger"]),
  title: z.string().optional(), narrativeRole: z.string().optional(), reuseScope: z.enum(["project", "episode", "single_use"]).optional(),
  relatedItemId: z.number().nullable().optional(), relationType: z.enum(["evolves_from", "replaces", "companion"]).nullable().optional(),
}), async (req, res) => {
  try { res.status(200).send(success({ libraryItem: await createMusicLibraryItem(req.body) })); }
  catch (cause) { res.status(400).send(error(u.error(cause).message)); }
});
