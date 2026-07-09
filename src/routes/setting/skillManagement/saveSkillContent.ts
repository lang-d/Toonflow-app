import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import isPathInside from "is-path-inside";
import path from "node:path";
import fs from "node:fs";
import { resolveSkillFile } from "@/services/skillResolver";
import getPath from "@/utils/getPath";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    path: z.string(),
    content: z.string(),
  }),
  async (req, res) => {
    const { path: relativePath, content } = req.body;
    const skillsRoot = path.resolve(getPath(["skills"]));
    const filePath = path.resolve(skillsRoot, relativePath);
    if (!(filePath === skillsRoot || isPathInside(filePath, skillsRoot))) {
      return res.status(400).send(error("无效的路径"));
    }

    if (!resolveSkillFile(relativePath)) {
      return res.status(400).send(error("文件不存在"));
    }

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content, "utf-8");

    res.status(200).send(success(null));
  },
);
