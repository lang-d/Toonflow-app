import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readProjectMaterial } from "@/services/projectMaterial";

const router = express.Router();

export default router.get(
  "/",
  validateFields({
    id: z.coerce.number(),
    projectId: z.coerce.number().optional(),
    offset: z.coerce.number().optional(),
    limit: z.coerce.number().optional(),
  }, "query"),
  async (req, res) => {
    try {
      const material = await readProjectMaterial(((req as any).validatedQuery || req.query) as any);
      res.status(200).send(success(material));
    } catch (err: any) {
      res.status(404).send(error(err?.message || "Project material text not found"));
    }
  },
);
