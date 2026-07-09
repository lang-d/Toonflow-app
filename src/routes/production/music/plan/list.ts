import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { parseJsonValue } from "@/services/musicDirector";

const router = express.Router();

function normalizePlan(row: any) {
  return {
    ...row,
    cueSheet: parseJsonValue(row.cueSheetJson, []),
  };
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().nullable().optional(),
    mode: z.enum(["concept", "project", "episode"]).optional(),
    state: z.string().optional(),
  }),
  async (req, res) => {
    try {
      const rows = await u
        .db("o_musicPlan")
        .where({ projectId: req.body.projectId })
        .modify((qb: any) => {
          if (req.body.scriptId !== undefined) {
            if (req.body.scriptId === null) qb.whereNull("scriptId");
            else qb.where("scriptId", req.body.scriptId);
          }
          if (req.body.mode) qb.where("mode", req.body.mode);
          if (req.body.state) qb.where("state", req.body.state);
        })
        .orderBy("version", "desc")
        .orderBy("id", "desc");
      res.status(200).send(success({ plans: rows.map(normalizePlan) }));
    } catch (cause) {
      res.status(400).send(error(u.error(cause).message));
    }
  },
);
