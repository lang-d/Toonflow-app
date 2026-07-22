import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getAgentMemoryHistory } from "@/services/agentMemoryHistory";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    agentType: z.enum(["scriptAgent", "productionAgent", "musicProductionAgent"]),
    episodesId: z.number().optional(),
  }),
  async (req, res) => {
    const { projectId, agentType, episodesId } = req.body;
    const history = await getAgentMemoryHistory({ projectId, agentType, episodesId });
    res.status(200).send(success(history));
  },
);
