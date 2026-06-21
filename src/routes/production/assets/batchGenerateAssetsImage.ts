import express from "express";
import { error } from "@/lib/responseFormat";

const router = express.Router();

export default router.post("/", (_req, res) => {
  return res
    .status(410)
    .send(error("production/assets/batchGenerateAssetsImage is deprecated. Use /api/assetsGenerate/batchGenerateImageAssets."));
});
