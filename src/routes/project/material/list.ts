import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  PROJECT_MATERIAL_CATEGORIES,
  listProjectMaterials,
} from "@/services/projectMaterial";

const router = express.Router();

export default router.get(
  "/",
  validateFields({
    projectId: z.coerce.number(),
    category: z.enum(PROJECT_MATERIAL_CATEGORIES).optional(),
    includeArchived: z.enum(["true", "false"]).optional(),
  }, "query"),
  async (req, res) => {
    try {
      const query = (req as any).validatedQuery || req.query;
      const materials = await listProjectMaterials({
        projectId: Number(query.projectId),
        category: query.category as any,
        includeArchived: query.includeArchived === "true",
      });
      res.status(200).send(success({ materials }));
    } catch (err: any) {
      res.status(400).send(error(err?.message || "Project material list failed"));
    }
  },
);
