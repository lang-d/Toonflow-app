import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataMap = [{ label: "README", value: "README" }];

async function writeManual(root: string, name: string, title: string) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, "images"), { recursive: true });
  await fs.writeFile(path.join(dir, "README.md"), `${title}\nbody`, "utf8");
  await fs.writeFile(path.join(dir, "images", "cover.png"), "not-a-real-png", "utf8");
}

test("project manuals merge builtin and user roots with user override", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-manuals-test-"));
  const previousAppData = process.env.TOONFLOW_APP_DATA_DIR;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.TOONFLOW_APP_DATA_DIR = path.join(root, "app");
  process.env.NODE_ENV = "prod";

  try {
    const systemArtRoot = path.join(root, "app", "system", "skills", "art_skills");
    const userArtRoot = path.join(root, "app", "user", "skills", "art_skills");
    const systemStoryRoot = path.join(root, "app", "system", "skills", "story_skills");
    await writeManual(systemArtRoot, "builtin_visual", "Builtin Visual");
    await writeManual(systemArtRoot, "override_visual", "System Visual");
    await writeManual(userArtRoot, "override_visual", "User Visual");
    await fs.mkdir(path.join(systemArtRoot, "bad_without_readme"), { recursive: true });
    await writeManual(systemStoryRoot, "builtin_director", "Builtin Director");

    const manuals = await import("../src/services/projectManuals");
    const visual = await manuals.listProjectManuals("visual", dataMap);
    const director = await manuals.listProjectManuals("director", dataMap);

    assert.equal(visual.some((item: any) => item.stylePath === "builtin_visual"), true);
    assert.equal(visual.some((item: any) => item.stylePath === "bad_without_readme"), false);
    assert.equal(visual.find((item: any) => item.stylePath === "override_visual")?.name, "User Visual");
    assert.equal(director.some((item: any) => item.directorManual === "builtin_director"), true);
    assert.equal(manuals.manualExistsInAnyRoot("visual", "builtin_visual"), true);
    assert.match(visual.find((item: any) => item.stylePath === "builtin_visual")?.image?.[0] || "", /\/skills\/art_skills\/builtin_visual\/images\/cover\.png$/);
  } finally {
    if (previousAppData === undefined) delete process.env.TOONFLOW_APP_DATA_DIR;
    else process.env.TOONFLOW_APP_DATA_DIR = previousAppData;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    await fs.rm(root, { recursive: true, force: true });
  }
});
