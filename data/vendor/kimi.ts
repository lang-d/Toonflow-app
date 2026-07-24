/**
 * Toonflow AI vendor: Kimi (Moonshot AI)
 * @version 1.0
 */

interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
  supportsTemperature?: boolean;
}

interface VendorConfig {
  id: string;
  version: string;
  name: string;
  author: string;
  description?: string;
  icon?: string;
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: TextModel[];
}

declare const createOpenAI: any;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => any;
};

const vendor: VendorConfig = {
  id: "kimi",
  version: "1.0",
  author: "Toonflow",
  name: "Kimi (Moonshot AI)",
  description: "## Kimi（Moonshot AI）\n\nOpenAI-compatible text API for Kimi K3.",
  inputs: [
    { key: "apiKey", label: "API Key", type: "password", required: true },
    { key: "baseUrl", label: "Base URL", type: "url", required: true, placeholder: "https://api.moonshot.cn/v1" },
  ],
  inputValues: { apiKey: "", baseUrl: "https://api.moonshot.cn/v1" },
  models: [{ name: "Kimi K3", modelName: "kimi-k3", type: "text", think: true, supportsTemperature: false }],
};

const getApiKey = (): string => {
  if (!vendor.inputValues.apiKey) throw new Error("Missing API Key");
  return vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
};

const getBaseUrl = (): string => {
  const baseUrl = (vendor.inputValues.baseUrl || "https://api.moonshot.cn/v1").replace(/\/+$/g, "");
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
};

const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  return createOpenAI({ baseURL: getBaseUrl(), apiKey: getApiKey() }).chat(model.modelName);
};

exports.vendor = vendor;
exports.textRequest = textRequest;

export {};
