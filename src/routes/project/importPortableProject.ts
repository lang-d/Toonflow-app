import express from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";
import { createUnifiedTask } from "@/services/taskCoordinator";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ sourceDirectory: z.string().min(1) }),
  async (req, res) => {
    const sourceDirectory = path.resolve(req.body.sourceDirectory);
    const sourceStat = fs.existsSync(sourceDirectory) ? fs.lstatSync(sourceDirectory) : null;
    if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
      return res.status(400).send(error("The selected project directory is invalid"));
    }
    if (!fs.existsSync(path.join(sourceDirectory, "project.toonflow"))) {
      return res.status(400).send(error("The selected directory does not contain project.toonflow"));
    }
    const task = await createUnifiedTask({
      projectId: 0,
      taskClass: "Import portable project",
      taskType: "maintenance",
      businessType: "project-import",
      handler: "project-import",
      payload: { sourceDirectory },
      priority: 50,
    });
    res.status(200).send(success({ taskId: task.taskId, status: task.status }));
  },
);
