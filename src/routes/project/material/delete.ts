import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { archiveProjectMaterial } from "@/services/projectMaterial";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    id: z.number(),
  }),
  async (req, res) => {
    try {
      const result = await archiveProjectMaterial(req.body);
      res.status(200).send(success(result));
    } catch (err: any) {
      res.status(404).send(error(err?.message || "Project material not found"));
    }
  },
);
