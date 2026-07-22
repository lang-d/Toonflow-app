import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { listMusicCues, parseJsonValue } from "@/services/musicDirector";

const router = express.Router();

function normalizePlan(row: any) {
  return {
    ...row,
    cueSheet: parseJsonValue(row.cueSheetJson, []),
    libraryPlan: parseJsonValue(row.libraryPlanJson, []),
    recommendedProduction: parseJsonValue(row.recommendedProductionJson, null),
  };
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    planId: z.number(),
    includeCues: z.boolean().optional(),
  }),
  async (req, res) => {
    try {
      const plan = await u.db("o_musicPlan").where({ projectId: req.body.projectId, id: req.body.planId }).first();
      if (!plan) throw new Error("Music plan does not exist");
      const cues = req.body.includeCues ? await listMusicCues({ projectId: req.body.projectId, planId: req.body.planId }) : undefined;
      res.status(200).send(success({ plan: normalizePlan(plan), ...(cues ? { cues } : {}) }));
    } catch (cause) {
      res.status(400).send(error(u.error(cause).message));
    }
  },
);
