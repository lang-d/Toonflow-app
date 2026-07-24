import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncBuiltinStyleSkills } from "../src/services/builtinSkillSync";

const relativePath = "art_skills/sample/driector_skills/director_planning_style.md";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-skill-sync-"));
  const builtinRoot = path.join(root, "builtin");
  const configuredRoot = path.join(root, "configured");
  const builtinFile = path.join(builtinRoot, relativePath);
  const configuredFile = path.join(configuredRoot, relativePath);
  await fs.mkdir(path.dirname(builtinFile), { recursive: true });
  await fs.mkdir(path.dirname(configuredFile), { recursive: true });
  await fs.writeFile(builtinFile, "new official skill", "utf8");
  return { root, builtinRoot, configuredRoot, configuredFile };
}

test("syncBuiltinStyleSkills upgrades only the prior official runtime copy", async () => {
  const fixture = await setup();
  try {
    await fs.writeFile(fixture.configuredFile, "old official skill", "utf8");
    const result = syncBuiltinStyleSkills({
      configuredRoot: fixture.configuredRoot,
      builtinRoots: [fixture.builtinRoot],
      previousHashes: { [relativePath]: hash("old official skill") },
    });
    assert.deepEqual(result, { updated: 1, skippedCustomized: 0, skippedMissing: 0, skippedSourceMissing: 0 });
    assert.equal(await fs.readFile(fixture.configuredFile, "utf8"), "new official skill");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("syncBuiltinStyleSkills accepts every known official predecessor", async () => {
  const fixture = await setup();
  try {
    await fs.writeFile(fixture.configuredFile, "older official skill", "utf8");
    const result = syncBuiltinStyleSkills({
      configuredRoot: fixture.configuredRoot,
      builtinRoots: [fixture.builtinRoot],
      previousHashes: {
        [relativePath]: [hash("intermediate official skill"), hash("older official skill")],
      },
    });
    assert.deepEqual(result, { updated: 1, skippedCustomized: 0, skippedMissing: 0, skippedSourceMissing: 0 });
    assert.equal(await fs.readFile(fixture.configuredFile, "utf8"), "new official skill");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("syncBuiltinStyleSkills preserves custom files and does not create missing overrides", async () => {
  const fixture = await setup();
  try {
    await fs.writeFile(fixture.configuredFile, "custom skill", "utf8");
    const custom = syncBuiltinStyleSkills({
      configuredRoot: fixture.configuredRoot,
      builtinRoots: [fixture.builtinRoot],
      previousHashes: { [relativePath]: hash("old official skill") },
    });
    assert.deepEqual(custom, { updated: 0, skippedCustomized: 1, skippedMissing: 0, skippedSourceMissing: 0 });
    assert.equal(await fs.readFile(fixture.configuredFile, "utf8"), "custom skill");

    await fs.rm(fixture.configuredFile);
    const missing = syncBuiltinStyleSkills({
      configuredRoot: fixture.configuredRoot,
      builtinRoots: [fixture.builtinRoot],
      previousHashes: { [relativePath]: hash("old official skill") },
    });
    assert.deepEqual(missing, { updated: 0, skippedCustomized: 0, skippedMissing: 1, skippedSourceMissing: 0 });
    await assert.rejects(fs.access(fixture.configuredFile));
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
