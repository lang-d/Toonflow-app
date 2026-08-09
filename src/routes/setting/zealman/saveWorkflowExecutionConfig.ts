import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readZealmanWorkflowConfiguration, validateZealmanWorkflowExecutionOverrides } from "@/services/zealmanWorkflowConfig";
import { withZealmanWorkflowExecutionOverrides } from "@/services/zealmanWorkflowSettings";
import u from "@/utils";

const router = express.Router();
const modelName = z.enum(["minimax-h3-u06", "minimax-h3-u06-light2v"]);
const executionValue = z.union([z.string(), z.number().finite(), z.boolean()]);

export default router.post(
  "/",
  validateFields({ modelName, values: z.record(z.string(), executionValue) }),
  async (req, res) => {
    const vendor = await u.db("o_vendorConfig").where("id", "zealman").first("inputValues");
    if (!vendor) return res.status(404).send(error("Zealman supplier is not installed"));
    let inputValues: Record<string, unknown>;
    try { inputValues = JSON.parse(String(vendor.inputValues || "{}")); } catch { return res.status(400).send(error("Zealman supplier settings are invalid JSON")); }
    try {
      const configuration = await readZealmanWorkflowConfiguration(inputValues.instanceUrls, `zealman:${req.body.modelName}`);
      validateZealmanWorkflowExecutionOverrides(configuration, req.body.values);
      const nextInputValues = withZealmanWorkflowExecutionOverrides(inputValues, configuration.workflowId, req.body.values);
      await u.db("o_vendorConfig").where("id", "zealman").update({ inputValues: JSON.stringify(nextInputValues) });
      u.vendor.invalidateCache("zealman");
      return res.status(200).send(success({ modelName: req.body.modelName, workflowId: configuration.workflowId, values: req.body.values }));
    } catch (cause: any) {
      return res.status(400).send(error(cause?.message || "Unable to save Zealman workflow configuration"));
    }
  },
);

