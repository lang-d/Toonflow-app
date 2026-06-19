import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

function flowWorkspaceState(data: any) {
  return {
    scriptPlan: typeof data?.scriptPlan === "string" ? data.scriptPlan : "",
  };
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    episodesId: z.number(),
    data: z.any(),
  }),
  async (req, res) => {
    const { data, projectId, episodesId } = req.body;
    if (Array.isArray(data?.storyboard) && data.storyboard.length) {
      await u.db.transaction(async (trx: any) => {
        for (const [index, item] of data.storyboard.entries()) {
          if (item?.id) await trx("o_storyboard").where("id", item.id).update({ index });
        }
      });
    }
    const storageData = JSON.stringify(flowWorkspaceState(data));
    const existing = await u
      .db("o_agentWorkData")
      .where("projectId", String(projectId))
      .andWhere("episodesId", String(episodesId))
      .andWhere("key", "productionAgent")
      .first();
    if (existing) {
      await u
        .db("o_agentWorkData")
        .where("id", existing.id)
        .update({ data: storageData, updateTime: Date.now() });
    } else {
      await u.db("o_agentWorkData").insert({
        projectId,
        episodesId,
        key: "productionAgent",
        data: storageData,
        createTime: Date.now(),
        updateTime: Date.now(),
      });
    }
    return res.status(200).send(success({ warnings: [] }));
  },
);
