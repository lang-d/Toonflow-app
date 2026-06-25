import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeRuntimeEnv } from "../scripts/runtimeEnv";

test("runtime env sanitizer drops undefined and null values before utilityProcess fork", () => {
  const env = sanitizeRuntimeEnv({
    PORT: "10588",
    TOONFLOW_UTILITY: "1",
    TOONFLOW_RUNTIME_ROLE: "api",
    TOONFLOW_STORAGE_MODE: "workspace",
    TOONFLOW_WORKSPACE_DIR: "C:\\Users\\tester\\Documents\\Toonflow Workspace",
    TOONFLOW_LEGACY_DATA_DIR: undefined,
    TOONFLOW_DATA_DIR: undefined,
    EMPTY_VALUE_IS_ALLOWED: "",
    NULL_VALUE_IS_DROPPED: null,
  });

  assert.equal(env.PORT, "10588");
  assert.equal(env.TOONFLOW_STORAGE_MODE, "workspace");
  assert.equal(env.EMPTY_VALUE_IS_ALLOWED, "");
  assert.equal(Object.prototype.hasOwnProperty.call(env, "TOONFLOW_LEGACY_DATA_DIR"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(env, "TOONFLOW_DATA_DIR"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(env, "NULL_VALUE_IS_DROPPED"), false);
  assert.equal(Object.values(env).some((value) => value == null), false);
});
