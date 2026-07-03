import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getProjectContextPack } from "@/services/projectMaterial";

const router = express.Router();

export default router.get(
  "/",
  validateFields({
    projectId: z.coerce.number(),
  }, "query"),
  async (req, res) => {
    try {
      const query = (req as any).validatedQuery || req.query;
      const contextPack = await getProjectContextPack(Number(query.projectId));
      res.status(200).send(success({ contextPack }));
    } catch (err: any) {
      res.status(400).send(error(err?.message || "Project context pack read failed"));
    }
  },
);
