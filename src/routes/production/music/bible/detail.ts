import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { parseJsonValue } from "@/services/musicDirector";

const router = express.Router();

function normalizeBible(row: any) {
  return {
    ...row,
    styleProfile: parseJsonValue(row.styleProfileJson, {}),
    sourceSummary: parseJsonValue(row.sourceSummaryJson, {}),
  };
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    bibleId: z.number(),
  }),
  async (req, res) => {
    try {
      const bible = await u.db("o_musicBible").where({ projectId: req.body.projectId, id: req.body.bibleId }).first();
      if (!bible) throw new Error("Music bible does not exist");
      res.status(200).send(success({ bible: normalizeBible(bible) }));
    } catch (cause) {
      res.status(400).send(error(u.error(cause).message));
    }
  },
);
