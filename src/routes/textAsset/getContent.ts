import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";
import { getTextAssetContent } from "@/services/textAsset";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.coerce.number(),
    id: z.coerce.number(),
    offset: z.coerce.number().optional(),
    limit: z.coerce.number().optional(),
  }),
  async (req, res) => {
    try {
      const content = await getTextAssetContent(req.body);
      res.status(200).send(success(content));
    } catch (err: any) {
      res.status(404).send(error(err?.message || "Text asset not found"));
    }
  },
);
