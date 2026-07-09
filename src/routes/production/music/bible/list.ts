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
    state: z.string().optional(),
  }),
  async (req, res) => {
    try {
      const rows = await u
        .db("o_musicBible")
        .where({ projectId: req.body.projectId })
        .modify((qb: any) => {
          if (req.body.state) qb.where("state", req.body.state);
        })
        .orderBy("version", "desc")
        .orderBy("id", "desc");
      res.status(200).send(success({ bibles: rows.map(normalizeBible) }));
    } catch (cause) {
      res.status(400).send(error(u.error(cause).message));
    }
  },
);
