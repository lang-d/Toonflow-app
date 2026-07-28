import express from "express";
import fs from "node:fs";
import { z } from "zod";
import { error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { musicDownloadContentDisposition, resolveMusicDownloadAsset } from "@/services/musicDownload";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    targetType: z.enum(["libraryVersion", "cueAsset"]),
    targetId: z.number(),
  }),
  async (req, res) => {
    try {
      const asset = await resolveMusicDownloadAsset(req.body);
      res.setHeader("Content-Type", asset.mimeType);
      res.setHeader("Content-Length", asset.size);
      res.setHeader("Content-Disposition", musicDownloadContentDisposition(asset.filename));
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, Content-Type");
      const stream = fs.createReadStream(asset.localPath);
      stream.once("error", (cause) => {
        if (!res.headersSent) res.status(500).send(error("Music audio file could not be read"));
        else res.destroy(cause);
      });
      stream.pipe(res);
    } catch (cause) {
      res.status(400).send(error(u.error(cause).message));
    }
  },
);
