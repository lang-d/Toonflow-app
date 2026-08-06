import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PRODUCTION_WORKFLOW_SKILL_PREVIOUS_HASHES,
  syncBuiltinProductionWorkflowSkills,
} from "../src/services/builtinSkillSync";

const relativePath = "production_execution_director_plan.md";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-production-workflow-skill-sync-"));
  const builtinRoot = path.join(root, "builtin");
  const configuredRoot = path.join(root, "configured");
  const builtinFile = path.join(builtinRoot, relativePath);
  const configuredFile = path.join(configuredRoot, relativePath);
  await fs.mkdir(path.dirname(builtinFile), { recursive: true });
  await fs.mkdir(path.dirname(configuredFile), { recursive: true });
  await fs.writeFile(builtinFile, "new official production workflow skill", "utf8");
  return { root, builtinRoot, configuredRoot, configuredFile };
}

test("Production workflow safe-sync inventory tracks every changed root workflow Skill", () => {
  assert.deepEqual(Object.keys(PRODUCTION_WORKFLOW_SKILL_PREVIOUS_HASHES).sort(), [
    "production_agent_decision.md",
    "production_execution_director_plan.md",
    "production_execution_storyboard_panel.md",
    "production_execution_storyboard_table.md",
    "production_skills/storyboard_prompt_techniques.md",
    "production_skills/storyboard_table_techniques.md",
    "production_supervision_director_plan.md",
    "production_supervision_storyboard_panel.md",
    "production_supervision_storyboard_table.md",
  ]);
  assert.deepEqual(PRODUCTION_WORKFLOW_SKILL_PREVIOUS_HASHES["production_agent_decision.md"], [
    "bd0c9c5172a6b1c6f31c8251f6f76056799c03a353e9451826724b04daf37900",
  ]);
  assert.ok(
    (PRODUCTION_WORKFLOW_SKILL_PREVIOUS_HASHES["production_execution_director_plan.md"] as readonly string[]).includes(
      "572c474c6b496f84c254faad3b1e9aaecef0a1ea72ae7b14b497f7f8e1aa02ee",
    ),
  );
  assert.ok(
    (PRODUCTION_WORKFLOW_SKILL_PREVIOUS_HASHES["production_execution_director_plan.md"] as readonly string[]).includes(
      "328cab80634c2d484fdfd19a6034b544d0fd78b032019ee5d446689855b322f6",
    ),
  );
  assert.ok(
    (PRODUCTION_WORKFLOW_SKILL_PREVIOUS_HASHES["production_supervision_director_plan.md"] as readonly string[]).includes(
      "963199bbbdd8df0d7ca237d3a646e12caef7bfdd1f84fe4de7f00e5c454296fc",
    ),
  );
  assert.ok(
    (PRODUCTION_WORKFLOW_SKILL_PREVIOUS_HASHES["production_skills/storyboard_table_techniques.md"] as readonly string[]).includes(
      "6f69f405e2973c973dbdf982145a786c0f8d471441d38ab0bf74b9617c20ee05",
    ),
  );
  assert.ok(
    (PRODUCTION_WORKFLOW_SKILL_PREVIOUS_HASHES["production_execution_storyboard_panel.md"] as readonly string[]).includes(
      "90615eb23c226eafb29eb7871879ee674c6333f4ce6ac155a41d1a32d735a9cb",
    ),
  );
});

test("Production workflow safe-sync upgrades the official predecessor and preserves a user override", async () => {
  const data = await fixture();
  try {
    await fs.writeFile(data.configuredFile, "old official production workflow skill", "utf8");
    const upgraded = syncBuiltinProductionWorkflowSkills({
      configuredRoot: data.configuredRoot,
      builtinRoots: [data.builtinRoot],
      previousHashes: { [relativePath]: hash("old official production workflow skill") },
    });
    assert.deepEqual(upgraded, { updated: 1, skippedCustomized: 0, skippedMissing: 0, skippedSourceMissing: 0 });
    assert.equal(await fs.readFile(data.configuredFile, "utf8"), "new official production workflow skill");

    await fs.writeFile(data.configuredFile, "user customized production workflow skill", "utf8");
    const preserved = syncBuiltinProductionWorkflowSkills({
      configuredRoot: data.configuredRoot,
      builtinRoots: [data.builtinRoot],
      previousHashes: { [relativePath]: hash("old official production workflow skill") },
    });
    assert.deepEqual(preserved, { updated: 0, skippedCustomized: 1, skippedMissing: 0, skippedSourceMissing: 0 });
    assert.equal(await fs.readFile(data.configuredFile, "utf8"), "user customized production workflow skill");
  } finally {
    await fs.rm(data.root, { recursive: true, force: true });
  }
});
