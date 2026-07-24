import assert from "node:assert/strict";
import test from "node:test";
import { shouldForwardTemperature } from "../src/lib/textModelCapabilities";

test("text models that disallow explicit temperature do not receive deployment temperature", () => {
  assert.equal(shouldForwardTemperature({ supportsTemperature: false }, 0.7), false);
});

test("existing text models keep forwarding a configured temperature", () => {
  assert.equal(shouldForwardTemperature({}, 0.7), true);
  assert.equal(shouldForwardTemperature(undefined, 0.7), true);
  assert.equal(shouldForwardTemperature({ supportsTemperature: true }, undefined), false);
});
