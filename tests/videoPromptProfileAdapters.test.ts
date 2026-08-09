import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { transform } from "sucrase";
import { VM } from "vm2";

const root = process.cwd();

function loadAdapter(file: string) {
  const code = fs.readFileSync(path.join(root, "data", "vendor", file), "utf8");
  const jsCode = transform(code, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
  const exports: Record<string, unknown> = {};
  new VM({ sandbox: { exports } }).run(jsCode);
  return exports as { resolveVideoPromptModelId?: (model: { modelName: string; type: "video" }) => string | undefined };
}

test("built-in adapters identify their canonical prompt model IDs without returning skill paths", () => {
  const cases = [
    ["minimax.ts", "MiniMax-H3", "minimax-h3"],
    ["zealman.ts", "minimax-h3-u06", "minimax-h3"],
    ["xlcsh.ts", "seedance-2.0-unlimited", "seedance-2"],
    ["toonflow.ts", "wan2.6", "wan-2.6"],
    ["atlascloud.ts", "bytedance/seedance-2.0-fast/text-to-video", "seedance-2"],
    ["geeknow.ts", "seedance-2.0-pro", "seedance-2"],
    ["volcengine.ts", "doubao-seedance-2-0-260128", "seedance-2"],
    ["volcengineSd2.ts", "doubao-seedance-2-0-fast-260128", "seedance-2"],
    ["dreamina.ts", "multimodal2video:seedance2.0_vip", "seedance-2"],
  ] as const;

  for (const [file, modelName, expected] of cases) {
    const adapter = loadAdapter(file);
    assert.equal(typeof adapter.resolveVideoPromptModelId, "function", `${file} should export the canonical model resolver`);
    assert.equal(adapter.resolveVideoPromptModelId?.({ modelName, type: "video" }), expected, `${file} should identify ${modelName}`);
    assert.equal(adapter.resolveVideoPromptModelId?.({ modelName: "unknown-video", type: "video" }), undefined, `${file} should not invent a prompt model ID`);
  }
});
