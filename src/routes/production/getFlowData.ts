import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { buildProductionFlowData } from "@/services/productionFlowData";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    episodesId: z.number(),
  }),
  async (req, res) => {
    const { projectId, episodesId }: { projectId: number; episodesId: number } = req.body;
    try {
      return res.status(200).send(success(await buildProductionFlowData(projectId, episodesId)));
    } catch (cause) {
      return res.status(400).send(error(u.error(cause).message));
    }
  },
);
