import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  PROJECT_MATERIAL_CATEGORIES,
  saveProjectMaterial,
} from "@/services/projectMaterial";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    category: z.enum(PROJECT_MATERIAL_CATEGORIES),
    name: z.string().min(1),
    base64Data: z.string().optional(),
    textContent: z.string().optional(),
    mime: z.string().optional(),
  }),
  async (req, res) => {
    try {
      const material = await saveProjectMaterial(req.body);
      res.status(200).send(success({ material }));
    } catch (err: any) {
      res.status(400).send(error(err?.message || "Project material upload failed"));
    }
  },
);
