import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { z } from "zod";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-ai-json-object-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let invokeAiObjectWithFallback: typeof import("../src/services/aiJsonObject").invokeAiObjectWithFallback;
let isStructuredOutputUnsupported: typeof import("../src/services/aiJsonObject").isStructuredOutputUnsupported;
let parseAiJsonValue: typeof import("../src/services/aiJsonObject").parseAiJsonValue;
let parseAiJsonWithSchema: typeof import("../src/services/aiJsonObject").parseAiJsonWithSchema;
let u: typeof import("../src/utils").default;

before(async () => {
  const [aiJsonObject, utils] = await Promise.all([import("../src/services/aiJsonObject"), import("../src/utils")]);
  invokeAiObjectWithFallback = aiJsonObject.invokeAiObjectWithFallback;
  isStructuredOutputUnsupported = aiJsonObject.isStructuredOutputUnsupported;
  parseAiJsonValue = aiJsonObject.parseAiJsonValue;
  parseAiJsonWithSchema = aiJsonObject.parseAiJsonWithSchema;
  u = utils.default;
});

after(async () => {
  await u?.db?.destroy?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const schema = z.object({
  value: z.string(),
  count: z.number(),
});

test("parseAiJsonWithSchema parses plain JSON", () => {
  assert.deepEqual(parseAiJsonWithSchema('{"value":"ok","count":1}', schema), { value: "ok", count: 1 });
});

test("parseAiJsonWithSchema parses fenced JSON", () => {
  assert.deepEqual(parseAiJsonWithSchema('```json\n{"value":"ok","count":2}\n```', schema), { value: "ok", count: 2 });
});

test("parseAiJsonValue preserves root arrays with object items", () => {
  assert.deepEqual(parseAiJsonValue('[{"value":"ok","count":2}]'), [{ value: "ok", count: 2 }]);
});

test("parseAiJsonWithSchema reports invalid JSON", () => {
  assert.throws(() => parseAiJsonWithSchema("not json", schema, "demo"), /demo is not valid JSON/);
});

test("parseAiJsonWithSchema reports schema mismatch", () => {
  assert.throws(() => parseAiJsonWithSchema('{"value":"ok"}', schema, "demo"), /demo does not match schema/);
});

test("isStructuredOutputUnsupported detects response format errors", () => {
  assert.equal(isStructuredOutputUnsupported(new Error("The feature responseFormat is not supported")), true);
  assert.equal(isStructuredOutputUnsupported(new Error("JSON response format schema is only supported with structuredOutputs")), true);
  assert.equal(isStructuredOutputUnsupported(new Error("other failure")), false);
});

test("invokeAiObjectWithFallback returns structured output when Output.object succeeds", async () => {
  const original = u.Ai.Text;
  let calls = 0;
  (u.Ai as any).Text = () => ({
    invoke: async (input: any) => {
      calls += 1;
      assert.ok(input.output);
      return { output: { value: "structured", count: 3 } };
    },
  });
  try {
    const result = await invokeAiObjectWithFallback({
      modelKey: "universalAi",
      system: "system",
      messages: [{ role: "user", content: "user" }],
      schema,
      label: "demo",
    });
    assert.deepEqual(result, { value: "structured", count: 3 });
    assert.equal(calls, 1);
  } finally {
    (u.Ai as any).Text = original;
  }
});

test("invokeAiObjectWithFallback retries as text JSON when responseFormat is unsupported", async () => {
  const original = u.Ai.Text;
  let calls = 0;
  (u.Ai as any).Text = () => ({
    invoke: async (input: any) => {
      calls += 1;
      if (input.output) throw new Error("responseFormat is not supported");
      assert.equal(input.output, undefined);
      return { text: "```json\n{\"value\":\"fallback\",\"count\":4}\n```" };
    },
  });
  try {
    const result = await invokeAiObjectWithFallback({
      modelKey: "universalAi",
      system: "system",
      messages: [{ role: "user", content: "user" }],
      schema,
      label: "demo",
    });
    assert.deepEqual(result, { value: "fallback", count: 4 });
    assert.equal(calls, 2);
  } finally {
    (u.Ai as any).Text = original;
  }
});

test("invokeAiObjectWithFallback retries as text JSON when structured output misses schema", async () => {
  const original = u.Ai.Text;
  let calls = 0;
  (u.Ai as any).Text = () => ({
    invoke: async (input: any) => {
      calls += 1;
      if (input.output) throw new Error("No object generated: response did not match schema.");
      assert.equal(input.output, undefined);
      return { text: "{\"value\":\"fallback\",\"count\":5}" };
    },
  });
  try {
    const result = await invokeAiObjectWithFallback({
      modelKey: "universalAi",
      system: "system",
      messages: [{ role: "user", content: "user" }],
      schema,
      label: "demo",
    });
    assert.deepEqual(result, { value: "fallback", count: 5 });
    assert.equal(calls, 2);
  } finally {
    (u.Ai as any).Text = original;
  }
});

test("invokeAiObjectWithFallback repairs fallback JSON once", async () => {
  const original = u.Ai.Text;
  let calls = 0;
  (u.Ai as any).Text = () => ({
    invoke: async (input: any) => {
      calls += 1;
      if (input.output) throw new Error("No object generated: response did not match schema.");
      if (calls === 2) return { text: "{\"value\":\"needs-repair\"}" };
      assert.match(input.messages.at(-1)?.content || "", /Repair the previous demo JSON output/);
      return { text: "{\"value\":\"repaired\",\"count\":6}" };
    },
  });
  try {
    const result = await invokeAiObjectWithFallback({
      modelKey: "universalAi",
      system: "system",
      messages: [{ role: "user", content: "user" }],
      schema,
      label: "demo",
    });
    assert.deepEqual(result, { value: "repaired", count: 6 });
    assert.equal(calls, 3);
  } finally {
    (u.Ai as any).Text = original;
  }
});
