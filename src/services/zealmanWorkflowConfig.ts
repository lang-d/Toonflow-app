import axios from "axios";
import {
  getZealmanWorkflow,
  fetchZealmanExecutionTemplate,
  deriveZealmanQualityParameterDefinitions,
  listZealmanWorkflowExecutionParameters,
  parseZealmanInstanceUrls,
  type ZealmanModelKey,
  type ZealmanWorkflowExecutionParameter,
} from "@/services/zealmanVideo";
import type { ZealmanExecutionOverrides, ZealmanQualityParameterKey } from "@/services/zealmanWorkflowSettings";

type HttpGet = { get: (url: string, config?: any) => Promise<{ data: any }> };

export const ZEALMAN_EXECUTION_RECOMMENDATIONS = [
  {
    hardware: "H800 80G / PRO6000 96G",
    unet: "ref2va_bf16",
    textEncoder: "qwen3vl_bf16",
  },
  {
    hardware: "4090 48G / 3090 48G",
    unet: "ref2va_pruned_bf16",
    textEncoder: "qwen3vl_bf16",
  },
  {
    hardware: "5090 32G / 4080(S) 32G",
    unet: "ref2va_pruned_int8 or ref2va_pruned_fp8",
    textEncoder: "qwen3vl_int8 or qwen3vl_nvfp4",
  },
] as const;

export type ZealmanWorkflowConfiguration = {
  modelKey: ZealmanModelKey;
  workflowId: string;
  instanceUrl: string;
  parameters: ZealmanWorkflowExecutionParameter[];
  qualityDefinitions: ReturnType<typeof deriveZealmanQualityParameterDefinitions>;
};

export async function readZealmanWorkflowConfiguration(
  instanceUrls: unknown,
  modelKey: string,
  client: HttpGet = axios,
): Promise<ZealmanWorkflowConfiguration> {
  const workflow = getZealmanWorkflow(modelKey);
  const urls = parseZealmanInstanceUrls(instanceUrls);
  const errors: string[] = [];
  for (const instanceUrl of urls) {
    try {
      const [template, modelScan] = await Promise.all([
        fetchZealmanExecutionTemplate(instanceUrl, workflow.modelKey, client),
        client.get(`${instanceUrl}/api/models/scan`, { timeout: 20_000 }),
      ]);
      const qualityDefinitions = deriveZealmanQualityParameterDefinitions(template, modelScan.data?.data || modelScan.data);
      return {
        modelKey: workflow.modelKey,
        workflowId: workflow.workflowId,
        instanceUrl,
        parameters: listZealmanWorkflowExecutionParameters(template, workflow.modelKey, qualityDefinitions),
        qualityDefinitions,
      };
    } catch (cause: any) {
      errors.push(`${instanceUrl}: ${cause?.message || String(cause)}`);
    }
  }
  throw new Error(`Unable to read Zealman workflow configuration. ${errors.join("; ")}`);
}

export function validateZealmanWorkflowExecutionOverrides(
  configuration: Pick<ZealmanWorkflowConfiguration, "parameters">,
  overrides: ZealmanExecutionOverrides,
) {
  const allowed = new Map(configuration.parameters.map((parameter) => [parameter.key, parameter]));
  for (const [key, value] of Object.entries(overrides)) {
    const parameter = allowed.get(key as ZealmanQualityParameterKey);
    if (!parameter) throw new Error(`Zealman workflow does not expose execution parameter: ${key}`);
    if (parameter.ui === "number" && typeof value !== "number") throw new Error(`Zealman ${parameter.label} must be a number`);
    if (parameter.ui === "toggle" && typeof value !== "boolean") throw new Error(`Zealman ${parameter.label} must be enabled or disabled`);
    if (parameter.ui === "select" && parameter.options?.length && !parameter.options.includes(String(value))) {
      throw new Error(`Zealman workflow does not offer selected ${parameter.label}: ${value}`);
    }
  }
}
