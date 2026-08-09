import assert from "node:assert/strict";
import test from "node:test";
import {
  ZEALMAN_WORKFLOW_EXECUTION_SETTINGS_KEY,
  getZealmanWorkflowExecutionOverrides,
  parseZealmanWorkflowExecutionSettings,
  withZealmanWorkflowExecutionOverrides,
} from "../src/services/zealmanWorkflowSettings";

test("Zealman execution settings are isolated by workflow and stored inside vendor inputValues", () => {
  const inputValues = withZealmanWorkflowExecutionOverrides(
    { instanceUrls: "https://one.example:8443" },
    "workflow-u06",
    { baseModel: "bf16", steps: 12 },
  );
  const updated = withZealmanWorkflowExecutionOverrides(inputValues, "workflow-light2v", { textEncoder: "qwen-bf16" });
  assert.equal(typeof updated[ZEALMAN_WORKFLOW_EXECUTION_SETTINGS_KEY], "string");
  assert.deepEqual(getZealmanWorkflowExecutionOverrides(updated, "workflow-u06"), { baseModel: "bf16", steps: 12 });
  assert.deepEqual(getZealmanWorkflowExecutionOverrides(updated, "workflow-light2v"), { textEncoder: "qwen-bf16" });
  assert.equal(updated.instanceUrls, "https://one.example:8443");
});

test("Zealman execution settings can clear one workflow without touching another", () => {
  const inputValues = {
    [ZEALMAN_WORKFLOW_EXECUTION_SETTINGS_KEY]: JSON.stringify({
      u06: { baseModel: "bf16" },
      light2v: { textEncoder: "qwen-bf16" },
    }),
  };
  const updated = withZealmanWorkflowExecutionOverrides(inputValues, "u06", {});
  assert.deepEqual(parseZealmanWorkflowExecutionSettings(updated), { light2v: { textEncoder: "qwen-bf16" } });
});

test("Zealman execution settings reject malformed or non-scalar persisted values", () => {
  assert.throws(() => parseZealmanWorkflowExecutionSettings({ [ZEALMAN_WORKFLOW_EXECUTION_SETTINGS_KEY]: "{" }), /invalid JSON/);
  assert.throws(
    () => parseZealmanWorkflowExecutionSettings({ [ZEALMAN_WORKFLOW_EXECUTION_SETTINGS_KEY]: JSON.stringify({ u06: { baseModel: ["invalid"] } }) }),
    /must be a string, number, or boolean/,
  );
  assert.deepEqual(
    parseZealmanWorkflowExecutionSettings({ [ZEALMAN_WORKFLOW_EXECUTION_SETTINGS_KEY]: JSON.stringify({ u06: { "620:unet_name": "legacy", "124:steps": 12, "702:upscale": "2x" } }) }),
    { u06: { baseModel: "legacy", steps: 12, superResolution: true } },
  );
});
