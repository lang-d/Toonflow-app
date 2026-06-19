import fs from "node:fs";
import path from "node:path";
import { systemDataPath } from "@/services/storagePaths";

function unique(values: string[]) {
  return [...new Set(values.map((item) => path.resolve(item)))];
}

export function builtinDataCandidates(...parts: string[]) {
  const repoDataPath = path.resolve(process.cwd(), "data", ...parts);
  const runtimeSystemPath = systemDataPath(...parts);
  return process.env.NODE_ENV !== "prod"
    ? unique([repoDataPath, runtimeSystemPath])
    : unique([runtimeSystemPath, repoDataPath]);
}

export function findBuiltinDataFile(...parts: string[]) {
  return builtinDataCandidates(...parts).find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) || null;
}

export function findBuiltinDataDir(...parts: string[]) {
  return builtinDataCandidates(...parts).find((dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory()) || null;
}

export async function readBuiltinDataFile(...parts: string[]) {
  const file = findBuiltinDataFile(...parts);
  if (!file) return null;
  return {
    file,
    content: await fs.promises.readFile(file, "utf8"),
  };
}
