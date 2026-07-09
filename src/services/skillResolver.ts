import fs from "node:fs";
import path from "node:path";
import getPath from "@/utils/getPath";
import { builtinDataCandidates } from "@/services/builtinData";
import { userDataPath } from "@/services/storagePaths";

export type ManualKind = "visual" | "director";
export type SkillRootKind = "configured" | "builtin" | "legacyUser";

export interface SkillRootEntry {
  root: string;
  kind: SkillRootKind;
}

function uniqueRootEntries(values: Array<SkillRootEntry | null | undefined>) {
  const seen = new Set<string>();
  const entries: SkillRootEntry[] = [];
  for (const value of values) {
    if (!value?.root) continue;
    const root = path.resolve(value.root);
    const key = root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ ...value, root });
  }
  return entries;
}

export function skillRootEntries(): SkillRootEntry[] {
  return uniqueRootEntries([
    { root: getPath(["skills"]), kind: "configured" },
    ...builtinDataCandidates("skills").map((root) => ({ root, kind: "builtin" as const })),
    { root: userDataPath("skills"), kind: "legacyUser" },
  ]);
}

export function skillRootCandidates() {
  return skillRootEntries().map((entry) => entry.root);
}

export function skillSourceKind(filePath: string): SkillRootKind | "unknown" {
  const resolved = path.resolve(filePath);
  for (const entry of skillRootEntries()) {
    const relative = path.relative(entry.root, resolved);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) return entry.kind;
  }
  return "unknown";
}

export function manualRootName(kind: ManualKind) {
  return kind === "visual" ? "art_skills" : "story_skills";
}

export function manualRootCandidates(kind: ManualKind) {
  const rootName = manualRootName(kind);
  return skillRootCandidates().map((root) => path.join(root, rootName));
}

export function resolveSkillFile(fileName: string) {
  const normalized = fileName.replace(/[\\/]+/g, path.sep);
  if (path.isAbsolute(normalized)) return null;
  return skillRootCandidates()
    .map((root) => {
      const file = path.resolve(root, normalized);
      const relative = path.relative(root, file);
      return relative.startsWith("..") || path.isAbsolute(relative) ? null : file;
    })
    .filter((file): file is string => Boolean(file))
    .find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) || null;
}

export async function readConfiguredSkill(fileName: string, fallback?: string) {
  const file = resolveSkillFile(fileName);
  if (!file) {
    if (fallback !== undefined) return { content: fallback, source: `fallback:${fileName}` };
    throw new Error(`Skill file not found: ${fileName}`);
  }
  return { content: await fs.promises.readFile(file, "utf8"), source: file };
}

export function resolveManualPackage(kind: ManualKind, key: string) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey || normalizedKey.includes("/") || normalizedKey.includes("\\")) return null;
  for (const root of manualRootCandidates(kind)) {
    const manualDir = path.join(root, normalizedKey);
    if (fs.existsSync(manualDir) && fs.statSync(manualDir).isDirectory()) return manualDir;
  }
  return null;
}

export function resolveManualFile(kind: ManualKind, key: string, relativeFile: string) {
  const manualDir = resolveManualPackage(kind, key);
  if (!manualDir) return null;
  const file = path.resolve(manualDir, relativeFile);
  const relative = path.relative(manualDir, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}
