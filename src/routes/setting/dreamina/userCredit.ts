import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

const router = express.Router();

export default router.post("/", async (req, res) => {
  try {
    res.status(200).send(success(await u.dreaminaCli.userCredit()));
  } catch (err) {
    res.status(500).send(error(u.error(err).message));
  }
});
