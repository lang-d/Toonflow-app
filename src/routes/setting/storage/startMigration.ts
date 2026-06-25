import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";
import {
  activeMigrationBlockers,
  assertCanStartStorageMigration,
  validateWorkspaceTarget,
} from "@/services/storageMigration";
import { createUnifiedTask } from "@/services/taskCoordinator";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    targetPath: z.string().min(1),
    sourcePath: z.string().min(1).optional(),
  }),
  async (req, res) => {
    try {
      assertCanStartStorageMigration({ sourcePath: req.body.sourcePath });
      const target = await validateWorkspaceTarget(req.body.targetPath);
      const blockers = await activeMigrationBlockers();
      if (blockers.count) {
        return res.status(409).send(error("Active provider tasks must finish before workspace migration", blockers));
      }
      const task = await createUnifiedTask({
        projectId: 0,
        taskClass: "Workspace migration",
        taskType: "maintenance",
        businessType: "storage-migration",
        handler: "storage-migration",
        payload: { sourcePath: req.body.sourcePath, targetPath: target.targetPath },
        priority: 100,
      });
      res.status(200).send(success({ taskId: task.taskId, status: task.status, restartRequired: true }));
    } catch (cause: any) {
      res.status(400).send(error(String(cause?.message || cause)));
    }
  },
);
