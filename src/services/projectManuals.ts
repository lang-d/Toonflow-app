import fs from "node:fs";
import path from "node:path";
import { builtinDataCandidates } from "@/services/builtinData";
import { userDataPath } from "@/services/storagePaths";
import { RUNTIME_API_HOST, RUNTIME_API_PORT } from "@/runtime/runtimeProtocol";

export type ProjectManualKind = "visual" | "director";

export interface ManualDataField {
  label: string;
  value: string;
  subDir?: string;
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

function readMd(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

export function manualRootName(kind: ProjectManualKind) {
  return kind === "visual" ? "art_skills" : "story_skills";
}

export function userManualRoot(kind: ProjectManualKind) {
  return userDataPath("skills", manualRootName(kind));
}

export function projectManualRoots(kind: ProjectManualKind) {
  const rootName = manualRootName(kind);
  const roots = [
    ...builtinDataCandidates("skills", rootName),
    userManualRoot(kind),
  ].map((item) => path.resolve(item));
  return [...new Set(roots)];
}

export function manualExistsInAnyRoot(kind: ProjectManualKind, key: string) {
  return projectManualRoots(kind).some((root) => fs.existsSync(path.join(root, key)));
}

async function readImages(kind: ProjectManualKind, key: string, manualDir: string) {
  const imagesDir = path.join(manualDir, "images");
  try {
    const files = fs.readdirSync(imagesDir);
    const relPaths = files
      .filter((file) => IMAGE_RE.test(file))
      .map((file) => path.join(manualRootName(kind), key, "images", file));
    return relPaths.map((item) => `http://${RUNTIME_API_HOST}:${RUNTIME_API_PORT}/skills/${item.split(path.sep).join("/")}`);
  } catch {
    return [];
  }
}

export async function listProjectManuals(kind: ProjectManualKind, dataMap: ManualDataField[]) {
  const entries = new Map<string, string>();
  const userRoot = path.resolve(userManualRoot(kind));
  for (const root of projectManualRoots(kind)) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manualDir = path.join(root, entry.name);
      if (!fs.existsSync(path.join(manualDir, "README.md"))) continue;
      if (root === userRoot) entries.set(entry.name, manualDir);
      else if (!entries.has(entry.name)) entries.set(entry.name, manualDir);
    }
  }

  return Promise.all(
    [...entries.entries()].map(async ([key, manualDir]) => {
      const readmeContent = fs.readFileSync(path.join(manualDir, "README.md"), "utf-8");
      const firstLine = readmeContent.split("\n")[0].replace(/--/g, "");
      const data = dataMap.map(({ label, value, subDir }) => {
        const mdPath = subDir
          ? path.join(manualDir, subDir, `${value}.md`)
          : path.join(manualDir, `${value}.md`);
        return { label, value, data: readMd(mdPath) };
      });

      return kind === "visual"
        ? {
            name: firstLine,
            image: await readImages(kind, key, manualDir),
            stylePath: key,
            data,
          }
        : {
            name: firstLine,
            image: await readImages(kind, key, manualDir),
            directorManual: key,
            data,
          };
    }),
  );
}
