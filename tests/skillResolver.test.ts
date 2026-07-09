import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getArtPrompt } from "../src/utils/getArtPrompt";
import { readConfiguredSkill, resolveManualPackage } from "../src/services/skillResolver";

test("workspace skill resolution prefers the configured package and never mixes missing manual files", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-skill-resolver-"));
  const previous = {
    appData: process.env.TOONFLOW_APP_DATA_DIR,
    workspace: process.env.TOONFLOW_WORKSPACE_DIR,
    mode: process.env.TOONFLOW_STORAGE_MODE,
    nodeEnv: process.env.NODE_ENV,
  };
  process.env.TOONFLOW_APP_DATA_DIR = path.join(temp, "app");
  process.env.TOONFLOW_WORKSPACE_DIR = path.join(temp, "workspace");
  process.env.TOONFLOW_STORAGE_MODE = "workspace";
  process.env.NODE_ENV = "prod";

  try {
    const systemSkills = path.join(temp, "app", "system", "skills");
    const userSkills = path.join(temp, "app", "user", "skills");
    await fs.mkdir(path.join(systemSkills, "art_skills", "sample", "art_prompt"), { recursive: true });
    await fs.mkdir(path.join(userSkills, "art_skills", "sample"), { recursive: true });
    await fs.writeFile(path.join(systemSkills, "root.md"), "system", "utf8");
    await fs.writeFile(path.join(userSkills, "root.md"), "user", "utf8");
    await fs.writeFile(path.join(systemSkills, "art_skills", "sample", "README.md"), "System", "utf8");
    await fs.writeFile(path.join(systemSkills, "art_skills", "sample", "prefix.md"), "system prefix", "utf8");
    await fs.writeFile(path.join(systemSkills, "art_skills", "sample", "art_prompt", "art_character.md"), "system character", "utf8");
    await fs.writeFile(path.join(userSkills, "art_skills", "sample", "README.md"), "User", "utf8");
    await fs.writeFile(path.join(userSkills, "art_skills", "sample", "prefix.md"), "user prefix", "utf8");

    assert.equal((await readConfiguredSkill("root.md")).content, "user");
    assert.equal(resolveManualPackage("visual", "sample"), path.join(userSkills, "art_skills", "sample"));
    assert.equal(getArtPrompt("sample", "art_skills", "art_character"), "");
  } finally {
    if (previous.appData === undefined) delete process.env.TOONFLOW_APP_DATA_DIR;
    else process.env.TOONFLOW_APP_DATA_DIR = previous.appData;
    if (previous.workspace === undefined) delete process.env.TOONFLOW_WORKSPACE_DIR;
    else process.env.TOONFLOW_WORKSPACE_DIR = previous.workspace;
    if (previous.mode === undefined) delete process.env.TOONFLOW_STORAGE_MODE;
    else process.env.TOONFLOW_STORAGE_MODE = previous.mode;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("legacy skill resolution prefers configured data skills over AppData user stale copies", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-skill-resolver-legacy-"));
  const previous = {
    appData: process.env.TOONFLOW_APP_DATA_DIR,
    dataDir: process.env.TOONFLOW_DATA_DIR,
    legacyDataDir: process.env.TOONFLOW_LEGACY_DATA_DIR,
    mode: process.env.TOONFLOW_STORAGE_MODE,
    nodeEnv: process.env.NODE_ENV,
  };
  process.env.TOONFLOW_APP_DATA_DIR = path.join(temp, "app");
  process.env.TOONFLOW_DATA_DIR = path.join(temp, "legacy");
  delete process.env.TOONFLOW_LEGACY_DATA_DIR;
  delete process.env.TOONFLOW_STORAGE_MODE;
  process.env.NODE_ENV = "prod";

  try {
    const legacySkills = path.join(temp, "legacy", "skills");
    const userSkills = path.join(temp, "app", "user", "skills");
    await fs.mkdir(path.join(legacySkills, "art_skills", "sample"), { recursive: true });
    await fs.mkdir(path.join(userSkills, "art_skills", "sample", "art_prompt"), { recursive: true });
    await fs.writeFile(path.join(legacySkills, "root.md"), "legacy", "utf8");
    await fs.writeFile(path.join(userSkills, "root.md"), "user", "utf8");
    await fs.writeFile(path.join(legacySkills, "art_skills", "sample", "README.md"), "Legacy", "utf8");
    await fs.writeFile(path.join(legacySkills, "art_skills", "sample", "prefix.md"), "legacy prefix", "utf8");
    await fs.writeFile(path.join(userSkills, "art_skills", "sample", "README.md"), "User", "utf8");
    await fs.writeFile(path.join(userSkills, "art_skills", "sample", "art_prompt", "art_character.md"), "user character", "utf8");

    assert.equal((await readConfiguredSkill("root.md")).content, "legacy");
    assert.equal(resolveManualPackage("visual", "sample"), path.join(legacySkills, "art_skills", "sample"));
    assert.equal(getArtPrompt("sample", "art_skills", "art_character"), "");
  } finally {
    if (previous.appData === undefined) delete process.env.TOONFLOW_APP_DATA_DIR;
    else process.env.TOONFLOW_APP_DATA_DIR = previous.appData;
    if (previous.dataDir === undefined) delete process.env.TOONFLOW_DATA_DIR;
    else process.env.TOONFLOW_DATA_DIR = previous.dataDir;
    if (previous.legacyDataDir === undefined) delete process.env.TOONFLOW_LEGACY_DATA_DIR;
    else process.env.TOONFLOW_LEGACY_DATA_DIR = previous.legacyDataDir;
    if (previous.mode === undefined) delete process.env.TOONFLOW_STORAGE_MODE;
    else process.env.TOONFLOW_STORAGE_MODE = previous.mode;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("skill resolution falls back to builtin before AppData user legacy", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-skill-resolver-builtin-"));
  const previous = {
    appData: process.env.TOONFLOW_APP_DATA_DIR,
    dataDir: process.env.TOONFLOW_DATA_DIR,
    legacyDataDir: process.env.TOONFLOW_LEGACY_DATA_DIR,
    systemDataDir: process.env.TOONFLOW_SYSTEM_DATA_DIR,
    mode: process.env.TOONFLOW_STORAGE_MODE,
    nodeEnv: process.env.NODE_ENV,
  };
  process.env.TOONFLOW_APP_DATA_DIR = path.join(temp, "app");
  process.env.TOONFLOW_DATA_DIR = path.join(temp, "legacy");
  process.env.TOONFLOW_SYSTEM_DATA_DIR = path.join(temp, "system");
  delete process.env.TOONFLOW_LEGACY_DATA_DIR;
  delete process.env.TOONFLOW_STORAGE_MODE;
  process.env.NODE_ENV = "prod";

  try {
    const builtinSkills = path.join(temp, "system", "skills");
    const userSkills = path.join(temp, "app", "user", "skills");
    await fs.mkdir(builtinSkills, { recursive: true });
    await fs.mkdir(userSkills, { recursive: true });
    await fs.writeFile(path.join(builtinSkills, "fallback.md"), "builtin", "utf8");
    await fs.writeFile(path.join(userSkills, "fallback.md"), "user", "utf8");

    assert.equal((await readConfiguredSkill("fallback.md")).content, "builtin");
  } finally {
    if (previous.appData === undefined) delete process.env.TOONFLOW_APP_DATA_DIR;
    else process.env.TOONFLOW_APP_DATA_DIR = previous.appData;
    if (previous.dataDir === undefined) delete process.env.TOONFLOW_DATA_DIR;
    else process.env.TOONFLOW_DATA_DIR = previous.dataDir;
    if (previous.legacyDataDir === undefined) delete process.env.TOONFLOW_LEGACY_DATA_DIR;
    else process.env.TOONFLOW_LEGACY_DATA_DIR = previous.legacyDataDir;
    if (previous.systemDataDir === undefined) delete process.env.TOONFLOW_SYSTEM_DATA_DIR;
    else process.env.TOONFLOW_SYSTEM_DATA_DIR = previous.systemDataDir;
    if (previous.mode === undefined) delete process.env.TOONFLOW_STORAGE_MODE;
    else process.env.TOONFLOW_STORAGE_MODE = previous.mode;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    await fs.rm(temp, { recursive: true, force: true });
  }
});
