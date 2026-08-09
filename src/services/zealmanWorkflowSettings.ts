export const ZEALMAN_WORKFLOW_EXECUTION_SETTINGS_KEY = "zealmanWorkflowExecutionSettings";

export type ZealmanExecutionValue = string | number | boolean;
export const ZEALMAN_QUALITY_PARAMETER_KEYS = ["baseModel", "textEncoder", "steps", "superResolution"] as const;
export type ZealmanQualityParameterKey = typeof ZEALMAN_QUALITY_PARAMETER_KEYS[number];
export type ZealmanExecutionOverrides = Partial<Record<ZealmanQualityParameterKey, ZealmanExecutionValue>>;
export type ZealmanWorkflowExecutionSettings = Record<string, ZealmanExecutionOverrides>;

function isExecutionValue(value: unknown): value is ZealmanExecutionValue {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function normalizeQualityKey(key: string): ZealmanQualityParameterKey | undefined {
  if ((ZEALMAN_QUALITY_PARAMETER_KEYS as readonly string[]).includes(key)) return key as ZealmanQualityParameterKey;
  if (/:unet_name$/.test(key)) return "baseModel";
  if (/:clip_name$/.test(key)) return "textEncoder";
  if (/:steps$/.test(key)) return "steps";
  if (/(?:^|:)upscale$/.test(key) || /:resize_type\.scale$/.test(key)) return "superResolution";
  return undefined;
}

function normalizeQualityValue(key: ZealmanQualityParameterKey, value: ZealmanExecutionValue) {
  if (key === "superResolution") {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value > 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "on", "enabled"].includes(normalized)) return true;
      if (["false", "off", "disabled"].includes(normalized)) return false;
      const numeric = Number(normalized.replace(/x$/i, ""));
      if (Number.isFinite(numeric)) return numeric > 0;
    }
  }
  return value;
}

export function parseZealmanWorkflowExecutionSettings(inputValues: Record<string, unknown>): ZealmanWorkflowExecutionSettings {
  const raw = inputValues[ZEALMAN_WORKFLOW_EXECUTION_SETTINGS_KEY];
  if (raw == null || raw === "") return {};
  if (typeof raw !== "string") throw new Error("Zealman workflow execution settings must be stored as JSON text");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Zealman workflow execution settings are invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Zealman workflow execution settings must be an object");
  }
  const settings: ZealmanWorkflowExecutionSettings = {};
  for (const [workflowId, values] of Object.entries(parsed as Record<string, unknown>)) {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error(`Zealman workflow execution settings for ${workflowId} must be an object`);
    }
    const normalized: ZealmanExecutionOverrides = {};
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      const qualityKey = normalizeQualityKey(key);
      if (!qualityKey) {
        throw new Error(`Zealman workflow execution setting ${workflowId}.${key} is not a supported quality parameter`);
      }
      if (!isExecutionValue(value)) throw new Error(`Zealman workflow execution setting ${workflowId}.${key} must be a string, number, or boolean`);
      normalized[qualityKey] = normalizeQualityValue(qualityKey, value);
    }
    settings[workflowId] = normalized;
  }
  return settings;
}

export function getZealmanWorkflowExecutionOverrides(inputValues: Record<string, unknown>, workflowId: string): ZealmanExecutionOverrides {
  return { ...(parseZealmanWorkflowExecutionSettings(inputValues)[workflowId] || {}) };
}

export function withZealmanWorkflowExecutionOverrides(
  inputValues: Record<string, unknown>,
  workflowId: string,
  overrides: ZealmanExecutionOverrides,
): Record<string, unknown> {
  const settings = parseZealmanWorkflowExecutionSettings(inputValues);
  if (Object.keys(overrides).length) settings[workflowId] = { ...overrides };
  else delete settings[workflowId];
  return { ...inputValues, [ZEALMAN_WORKFLOW_EXECUTION_SETTINGS_KEY]: JSON.stringify(settings) };
}
