import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { ZEALMAN_EXECUTION_RECOMMENDATIONS, readZealmanWorkflowConfiguration } from "@/services/zealmanWorkflowConfig";
import { getZealmanWorkflowExecutionOverrides } from "@/services/zealmanWorkflowSettings";
import u from "@/utils";

const router = express.Router();
const modelName = z.enum(["minimax-h3-u06", "minimax-h3-u06-light2v"]);

export default router.post(
  "/",
  validateFields({ modelName }),
  async (req, res) => {
    const vendor = await u.db("o_vendorConfig").where("id", "zealman").first("inputValues");
    if (!vendor) return res.status(404).send(error("Zealman supplier is not installed"));
    let inputValues: Record<string, unknown>;
    try { inputValues = JSON.parse(String(vendor.inputValues || "{}")); } catch { return res.status(400).send(error("Zealman supplier settings are invalid JSON")); }
    try {
      const configuration = await readZealmanWorkflowConfiguration(inputValues.instanceUrls, `zealman:${req.body.modelName}`);
      const savedValues = getZealmanWorkflowExecutionOverrides(inputValues, configuration.workflowId);
      const availableKeys = new Set<string>(configuration.parameters.map((parameter) => parameter.key));
      return res.status(200).send(success({
        modelName: req.body.modelName,
        workflowId: configuration.workflowId,
        instanceUrl: configuration.instanceUrl,
        parameters: configuration.parameters,
        savedValues,
        staleKeys: Object.keys(savedValues).filter((key) => !availableKeys.has(key)),
        recommendations: ZEALMAN_EXECUTION_RECOMMENDATIONS,
      }));
    } catch (cause: any) {
      return res.status(400).send(error(cause?.message || "Unable to read Zealman workflow configuration"));
    }
  },
);
