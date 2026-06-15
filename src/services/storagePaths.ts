import fs from "node:fs";
import path from "node:path";
import isPathInside from "is-path-inside";

export type StorageMode = "legacy" | "workspace";

export interface RuntimeStorageConfig {
  version: 1;
  mode: StorageMode;
  workspacePath: string;
  legacyDataPath?: string;
  pendingProfilePath?: string;
  selectionRequired?: boolean;
  updatedAt: number;
}

export const PROFILE_TABLES = new Set([
  "o_user",
  "o_artStyle",
  "o_agentDeploy",
  "o_setting",
  "o_prompt",
  "o_modelPrompt",
  "o_vendorConfig",
  "o_skillList",
  "o_skillAttribution",
]);

function absolute(value: string | undefined, fallback: string) {
  return path.resolve(value?.trim() || fallback);
}

export function appDataRoot() {
  return absolute(process.env.TOONFLOW_APP_DATA_DIR, path.join(process.cwd(), "data"));
}

export function storageMode(): StorageMode {
  return process.env.TOONFLOW_STORAGE_MODE === "workspace" ? "workspace" : "legacy";
}

export function legacyDataRoot() {
  return absolute(
    process.env.TOONFLOW_LEGACY_DATA_DIR || process.env.TOONFLOW_DATA_DIR,
    path.join(process.cwd(), "data"),
  );
}

export function workspaceRoot() {
  return absolute(process.env.TOONFLOW_WORKSPACE_DIR, legacyDataRoot());
}

export function runtimeConfigPath(root = appDataRoot()) {
  return path.join(root, "runtime.json");
}

export function readRuntimeStorageConfig(root = appDataRoot()): RuntimeStorageConfig | null {
  const file = runtimeConfigPath(root);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RuntimeStorageConfig;
    if (parsed?.version !== 1 || !parsed.workspacePath || !["legacy", "workspace"].includes(parsed.mode)) return null;
    return { ...parsed, workspacePath: path.resolve(parsed.workspacePath) };
  } catch {
    return null;
  }
}

export function writeRuntimeStorageConfig(config: RuntimeStorageConfig, root = appDataRoot()) {
  fs.mkdirSync(root, { recursive: true });
  const target = runtimeConfigPath(root);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(temp, target);
}

export function systemDataPath(...parts: string[]) {
  return path.join(
    absolute(process.env.TOONFLOW_SYSTEM_DATA_DIR, path.join(appDataRoot(), "system")),
    ...parts,
  );
}

export function userDataPath(...parts: string[]) {
  return path.join(appDataRoot(), "user", ...parts);
}

export function cacheDataPath(...parts: string[]) {
  return path.join(appDataRoot(), "cache", ...parts);
}

export function workspaceDataPath(...parts: string[]) {
  return path.join(workspaceRoot(), ...parts);
}

export function profileDatabasePath() {
  return path.join(appDataRoot(), "profile.sqlite");
}

export function workspaceDatabasePath() {
  return storageMode() === "workspace" ? workspaceDataPath("workspace.sqlite") : path.join(legacyDataRoot(), "db2.sqlite");
}

export function projectDirectory(projectId: number | string) {
  return workspaceDataPath("projects", String(projectId));
}

export function projectMediaDirectory(projectId: number | string) {
  return path.join(projectDirectory(projectId), "media");
}

export function resolveMediaFilePath(userPath: string) {
  const normalized = userPath.replace(/^[/\\]+/, "").replace(/[\\/]+/g, path.sep);
  if (storageMode() !== "workspace") return path.resolve(legacyDataRoot(), "oss", normalized);
  const segments = normalized.split(path.sep).filter(Boolean);
  if (segments[0]?.toLowerCase() === "smallimage") {
    return path.resolve(cacheDataPath("thumbnails"), ...segments.slice(1));
  }
  if (/^\d+$/.test(segments[0] || "")) {
    return path.resolve(projectMediaDirectory(segments[0]), ...segments.slice(1));
  }
  return path.resolve(workspaceDataPath("shared"), ...segments);
}

export function resolveThumbnailFilePath(userPath: string, suffix: string) {
  const normalized = userPath.replace(/^[/\\]+/, "").replace(/[\\/]+/g, path.sep);
  const ext = path.extname(normalized);
  const withoutExt = normalized.slice(0, -ext.length);
  return path.resolve(cacheDataPath("thumbnails"), `${withoutExt}_${suffix}${ext}`);
}

export function isSafeMediaFilePath(filePath: string) {
  const resolved = path.resolve(filePath);
  const roots =
    storageMode() === "workspace"
      ? [workspaceRoot(), cacheDataPath("thumbnails")]
      : [path.join(legacyDataRoot(), "oss")];
  return roots.some((root) => resolved === path.resolve(root) || isPathInside(resolved, path.resolve(root)));
}

export function getDataPath(fileName?: string[] | string) {
  if (storageMode() === "legacy") {
    const base = legacyDataRoot();
    return fileName == null ? base : path.resolve(base, ...(Array.isArray(fileName) ? fileName : [fileName]));
  }
  if (fileName == null) return appDataRoot();
  const parts = Array.isArray(fileName) ? fileName : [fileName];
  const [head, ...tail] = parts;
  const mapping: Record<string, string> = {
    "db2.sqlite": workspaceDatabasePath(),
    "workspace.sqlite": workspaceDatabasePath(),
    oss: workspaceRoot(),
    backups: workspaceDataPath("backups"),
    vendor: userDataPath("vendor"),
    skills: userDataPath("skills"),
    modelPrompt: userDataPath("modelPrompt"),
    bin: userDataPath("bin"),
    models: systemDataPath("models"),
    serve: systemDataPath("serve"),
    web: systemDataPath("web"),
    assets: systemDataPath("assets"),
    logs: path.join(appDataRoot(), "logs"),
    temp: path.join(appDataRoot(), "temp"),
    cache: path.join(appDataRoot(), "cache"),
    "version.txt": systemDataPath("version.txt"),
  };
  const root = mapping[head] || userDataPath(head);
  return path.resolve(root, ...tail);
}
