import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";
import { validateWorkspaceTarget } from "@/services/storageMigration";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ targetPath: z.string().min(1) }),
  async (req, res) => {
    try {
      res.status(200).send(success(await validateWorkspaceTarget(req.body.targetPath)));
    } catch (cause: any) {
      res.status(400).send(error(String(cause?.message || cause)));
    }
  },
);
