import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SCRIPT_SKILL_PREVIOUS_HASHES,
  STYLE_SKILL_PREVIOUS_HASHES,
  syncBuiltinScriptSkills,
} from "../src/services/builtinSkillSync";

const relativePath = "script_execution_skeleton.md";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-script-skill-sync-"));
  const builtinRoot = path.join(root, "builtin");
  const configuredRoot = path.join(root, "configured");
  await fs.mkdir(builtinRoot, { recursive: true });
  await fs.mkdir(configuredRoot, { recursive: true });
  await fs.writeFile(path.join(builtinRoot, relativePath), "rebuilt official script skill", "utf8");
  return { root, builtinRoot, configuredRoot, configuredFile: path.join(configuredRoot, relativePath) };
}

test("Script safe-sync inventory is separate and contains current-short and old-long official hashes", () => {
  assert.equal(Object.keys(SCRIPT_SKILL_PREVIOUS_HASHES).length, 5);
  assert.equal(Object.keys(STYLE_SKILL_PREVIOUS_HASHES).length, 94);
  assert.deepEqual(Object.keys(SCRIPT_SKILL_PREVIOUS_HASHES).sort(), [
    "script_agent_decision.md",
    "script_agent_supervision.md",
    "script_execution_adaptation.md",
    "script_execution_script.md",
    "script_execution_skeleton.md",
  ]);
  const skeletonHashes = SCRIPT_SKILL_PREVIOUS_HASHES[relativePath];
  assert.ok(Array.isArray(skeletonHashes));
  assert.ok(skeletonHashes.includes("76a2fcd6fa81de64e1a2ff1079d09610e8aac137c6437490e74242a5cf50856b"));
  assert.ok(skeletonHashes.includes("d23b6e86e36b74ad0df8ebba1971535801b2da007323b13f9d3bebc7ee45e353"));
});

test("syncBuiltinScriptSkills upgrades a known official predecessor", async () => {
  const data = await fixture();
  try {
    await fs.writeFile(data.configuredFile, "old official script skill", "utf8");
    const result = syncBuiltinScriptSkills({
      configuredRoot: data.configuredRoot,
      builtinRoots: [data.builtinRoot],
      previousHashes: { [relativePath]: hash("old official script skill") },
    });
    assert.deepEqual(result, { updated: 1, skippedCustomized: 0, skippedMissing: 0, skippedSourceMissing: 0 });
    assert.equal(await fs.readFile(data.configuredFile, "utf8"), "rebuilt official script skill");
  } finally {
    await fs.rm(data.root, { recursive: true, force: true });
  }
});

test("syncBuiltinScriptSkills preserves customized files and leaves missing overrides absent", async () => {
  const data = await fixture();
  try {
    await fs.writeFile(data.configuredFile, "user customized script skill", "utf8");
    const customized = syncBuiltinScriptSkills({
      configuredRoot: data.configuredRoot,
      builtinRoots: [data.builtinRoot],
      previousHashes: { [relativePath]: hash("old official script skill") },
    });
    assert.deepEqual(customized, { updated: 0, skippedCustomized: 1, skippedMissing: 0, skippedSourceMissing: 0 });
    assert.equal(await fs.readFile(data.configuredFile, "utf8"), "user customized script skill");

    await fs.rm(data.configuredFile);
    const missing = syncBuiltinScriptSkills({
      configuredRoot: data.configuredRoot,
      builtinRoots: [data.builtinRoot],
      previousHashes: { [relativePath]: hash("old official script skill") },
    });
    assert.deepEqual(missing, { updated: 0, skippedCustomized: 0, skippedMissing: 1, skippedSourceMissing: 0 });
    await assert.rejects(fs.access(data.configuredFile));
  } finally {
    await fs.rm(data.root, { recursive: true, force: true });
  }
});
