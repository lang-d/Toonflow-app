import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import {
  getProjectDefaultMusicModel,
  musicModelSelectionErrorData,
  setProjectDefaultMusicModel,
} from "@/services/musicModelSelection";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    model: z.string().min(1).nullable().optional(),
  }),
  async (req, res) => {
    try {
      const hasModel = Object.prototype.hasOwnProperty.call(req.body, "model");
      const musicModel = hasModel
        ? await setProjectDefaultMusicModel(req.body.projectId, req.body.model ?? null)
        : await getProjectDefaultMusicModel(req.body.projectId);
      res.status(200).send(success({ musicModel }));
    } catch (cause) {
      res.status(400).send(error(u.error(cause).message, musicModelSelectionErrorData(cause)));
    }
  },
);
