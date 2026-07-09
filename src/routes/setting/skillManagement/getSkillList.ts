import express from "express";
import fs from "node:fs";
import { success } from "@/lib/responseFormat";
import fg from "fast-glob";
import { skillRootEntries } from "@/services/skillResolver";

const router = express.Router();

export default router.post("/", async (req, res) => {
  const entries: Array<{ path: string; source: string; sourceRoot: string }> = [];
  const seen = new Set<string>();
  for (const { root: skillsRoot, kind } of skillRootEntries()) {
    if (!fs.existsSync(skillsRoot)) continue;
    const files = await fg("**/*.md", { cwd: skillsRoot.replace(/\\/g, "/"), onlyFiles: true });
    for (const file of files) {
      const normalized = file.replace(/\\/g, "/");
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      entries.push({ path: normalized, source: kind, sourceRoot: skillsRoot });
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  res.status(200).send(success(entries));
});
