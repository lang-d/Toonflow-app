import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";
import { createUnifiedTask } from "@/services/taskCoordinator";
import { projectDirectory } from "@/services/storagePaths";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ projectId: z.number().int().positive() }),
  async (req, res) => {
    const project = await u.db("o_project").where("id", req.body.projectId).first();
    if (!project) return res.status(404).send(error("Project does not exist"));
    const existing = await (u.db as any)("o_tasks")
      .where({
        projectId: req.body.projectId,
        businessType: "project-snapshot",
      })
      .whereIn("status", ["queued", "submitting", "processing"])
      .first();
    if (existing) {
      return res.status(200).send(success({
        taskId: existing.taskId,
        status: existing.status,
        directory: projectDirectory(req.body.projectId),
      }));
    }
    const task = await createUnifiedTask({
      projectId: req.body.projectId,
      taskClass: "Prepare portable project",
      taskType: "maintenance",
      businessType: "project-snapshot",
      businessId: req.body.projectId,
      handler: "project-snapshot",
      payload: { projectId: req.body.projectId },
      priority: 50,
    });
    res.status(200).send(success({
      taskId: task.taskId,
      status: task.status,
      directory: projectDirectory(req.body.projectId),
    }));
  },
);
