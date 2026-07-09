import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import * as fs from "fs";
import { resolveSkillFile } from "@/services/skillResolver";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    path: z.string(),
  }),
  async (req, res) => {
    const { path } = req.body;
    if (!path || path.includes("..")) {
      return res.status(400).send(error("无效的路径"));
    }
    const filePath = resolveSkillFile(path);
    if (!filePath) return res.status(404).send(error("文件不存在"));

    const raw = await fs.promises.readFile(filePath, "utf-8");

    res.status(200).send(success({ content: raw, source: filePath }));
  },
);
