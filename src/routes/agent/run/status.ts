import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { getActiveAgentRun, getLatestAgentRun, interruptExpiredAgentRuns } from "@/services/agentRun";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    agentKey: z.string().min(1),
    projectId: z.number(),
    scriptId: z.number(),
  }),
  async (req, res) => {
    const { agentKey, projectId, scriptId } = req.body;
    await interruptExpiredAgentRuns();
    const scope = { agentKey, projectId, scriptId };
    const [activeRun, latestRun] = await Promise.all([getActiveAgentRun(scope), getLatestAgentRun(scope)]);
    res.status(200).send(
      success({
        serverTime: Date.now(),
        activeRun,
        latestRun,
      }),
    );
  },
);

