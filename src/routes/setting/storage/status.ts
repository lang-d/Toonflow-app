import express from "express";
import { success, error } from "@/lib/responseFormat";
import { getStorageStatus } from "@/services/storageMigration";

const router = express.Router();

export default router.post("/", async (_req, res) => {
  try {
    res.status(200).send(success(await getStorageStatus()));
  } catch (cause: any) {
    res.status(500).send(error(String(cause?.message || cause)));
  }
});
