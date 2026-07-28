import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createScriptWithContent, deleteScriptContentAssets } from "@/services/scriptWorkspaceText";
const router = express.Router();

// 新增剧本
export default router.post(
  "/",
  validateFields({
    data: z.array(
      z.object({
        scriptName: z.string(),
        scriptData: z.string(),
      }),
    ),
    projectId: z.number(),
  }),
  async (req, res) => {
    const { data, projectId } = req.body;
    const createdIds: number[] = [];
    try {
      for (const item of data as { scriptName: string; scriptData: string }[]) {
        const created = await createScriptWithContent({
          projectId,
          name: item.scriptName,
          content: item.scriptData,
        });
        createdIds.push(created.id);
      }
    } catch (cause) {
      if (createdIds.length) {
        await u.db("o_script").where({ projectId }).whereIn("id", createdIds).delete();
        await deleteScriptContentAssets({ projectId, scriptIds: createdIds });
      }
      throw cause;
    }

    res.status(200).send(success({ message: "添加剧本成功" }));
  },
);
