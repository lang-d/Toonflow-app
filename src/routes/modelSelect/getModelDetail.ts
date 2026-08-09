import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getVideoPromptContentProfilesForModel, getVideoPromptTypeCapabilityForModel } from "@/services/videoPromptCompiler";
import { getProjectVideoPromptTypeSelection } from "@/services/videoPromptTypeSelection";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    modelId: z.string(),
    projectId: z.number().optional(),
  }),
  async (req, res) => {
    const { modelId, projectId } = req.body;
    const [id, name] = modelId.split(/:(.+)/);
    const models = await u.vendor.getModelList(id);
    const findData = models.find((i: any) => i.modelName == name);
    if (!findData) return res.status(404).send(error("未找到模型"));
    const videoPromptTypes = findData?.type === "video" ? await getVideoPromptContentProfilesForModel(modelId) : [];
    const videoPromptTypeCapability = findData.type === "video" ? await getVideoPromptTypeCapabilityForModel(modelId) : null;
    const selectedVideoPromptType = projectId == null || !videoPromptTypeCapability
      ? null
      : await getProjectVideoPromptTypeSelection(projectId, modelId);
    res.status(200).send(success({
      ...findData,
      model: modelId,
      videoPromptTypes,
      videoPromptTypeCapability,
      ...(projectId == null ? {} : { selectedVideoPromptType }),
    }));
  },
);
