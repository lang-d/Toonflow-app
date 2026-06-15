import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import os from "node:os";
import knex from "knex";
import db from "@/utils/db";
import {
  PROFILE_TABLES,
  appDataRoot,
  legacyDataRoot,
  profileDatabasePath,
  readRuntimeStorageConfig,
  storageMode,
  userDataPath,
  workspaceDatabasePath,
  workspaceRoot,
  writeRuntimeStorageConfig,
} from "@/services/storagePaths";
import { generateProjectSnapshot } from "@/services/projectPortable";
import { updateUnifiedTask } from "@/services/taskCoordinator";

const Database = require("better-sqlite3") as any;

const ACTIVE_PROVIDER_STATUSES = ["submitting", "processing", "confirming"];

export function storageMigrationLockPath() {
  return path.join(appDataRoot(), "temp", "storage-migration.lock");
}

export function isStorageMaintenanceActive() {
  return fss.existsSync(storageMigrationLockPath());
}

async function directorySize(directory: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  async function visit(current: string) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        files += 1;
        bytes += stat.size;
      }
    }
  }
  await visit(directory);
  return { files, bytes };
}

function legacyCandidates() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return [
    legacyDataRoot(),
    path.join(roaming, "toonflow", "data"),
    path.join(roaming, "Toonflow", "data"),
  ];
}

function databaseFileFor(root: string) {
  const workspaceFile = path.join(root, "workspace.sqlite");
  const legacyFile = path.join(root, "db2.sqlite");
  return fss.existsSync(workspaceFile) ? workspaceFile : legacyFile;
}

function inspectSqlite(databasePath: string) {
  if (!fss.existsSync(databasePath)) return { healthy: false, projectCount: 0, message: "Database not found" };
  try {
    const database = new Database(databasePath, { readonly: true });
    const integrity = String(database.pragma("integrity_check", { simple: true }));
    const hasProject = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='o_project'")
      .get();
    const projectCount = hasProject
      ? Number((database.prepare("SELECT count(*) AS count FROM o_project").get() as any)?.count || 0)
      : 0;
    database.close();
    return { healthy: integrity === "ok", projectCount, message: integrity };
  } catch (error: any) {
    return { healthy: false, projectCount: 0, message: String(error?.message || error) };
  }
}

export async function scanLegacyStorage() {
  const seen = new Set<string>();
  const results = [];
  for (const candidate of legacyCandidates()) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved.toLowerCase()) || !fss.existsSync(resolved)) continue;
    seen.add(resolved.toLowerCase());
    const databasePath = databaseFileFor(resolved);
    const database = inspectSqlite(databasePath);
    if (!fss.existsSync(databasePath)) continue;
    const size = await directorySize(resolved);
    results.push({
      path: resolved,
      databasePath,
      ...database,
      mediaFiles: (await directorySize(path.join(resolved, "oss"))).files,
      totalFiles: size.files,
      totalBytes: size.bytes,
      current: resolved.toLowerCase() === workspaceRoot().toLowerCase(),
    });
  }
  return results;
}

export async function activeMigrationBlockers(database: any = db) {
  const unified = await database("o_tasks")
    .whereIn("status", ACTIVE_PROVIDER_STATUSES)
    .where((builder: any) =>
      builder.whereNull("businessType").orWhereNot("businessType", "storage-migration"),
    )
    .select("taskId", "taskType", "status", "phase", "projectId");
  const video = await database("o_videoGenerationTask")
    .whereIn("status", ACTIVE_PROVIDER_STATUSES)
    .select("id", "status", "phase", "projectId", "submitId");
  return { unified, video, count: unified.length + video.length };
}

export async function validateWorkspaceTarget(targetPath: string) {
  const target = path.resolve(targetPath);
  const current = path.resolve(workspaceRoot());
  const appRoot = path.resolve(appDataRoot());
  const installRoot = path.resolve(process.cwd());
  const forbiddenRoots = [appRoot, installRoot];
  const lower = target.toLowerCase();
  const isInside = (child: string, parent: string) =>
    child === parent || child.startsWith(`${parent}${path.sep}`);
  if (!path.isAbsolute(targetPath)) throw new Error("Workspace path must be absolute");
  if (target === path.parse(target).root) throw new Error("A disk root cannot be used as the workspace");
  if (forbiddenRoots.some((root) => isInside(lower, root.toLowerCase()))) {
    throw new Error("The workspace cannot be inside application data or the installation directory");
  }
  if (isInside(lower, current.toLowerCase()) || isInside(current.toLowerCase(), lower)) {
    throw new Error("The target cannot be the current workspace or its parent/child directory");
  }
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  if (fss.existsSync(target)) {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error("Symbolic links cannot be used as a workspace");
    if (!stat.isDirectory()) throw new Error("The target must be a directory");
    if ((await fs.readdir(target)).length) throw new Error("The target directory must be empty");
  }
  const probeRoot = fss.existsSync(target) ? target : parent;
  const probe = path.join(probeRoot, `.toonflow-write-${process.pid}-${Date.now()}`);
  await fs.writeFile(probe, "ok", "utf8");
  await fs.rm(probe, { force: true });
  const sourceSize = await directorySize(storageMode() === "workspace" ? workspaceRoot() : legacyDataRoot());
  const statfs = await fs.statfs(probeRoot);
  const freeBytes = Number(statfs.bavail) * Number(statfs.bsize);
  if (freeBytes < sourceSize.bytes * 1.1) throw new Error("Insufficient free disk space");
  return { targetPath: target, freeBytes, requiredBytes: Math.ceil(sourceSize.bytes * 1.1) };
}

function stripDatabase(databasePath: string, keepProfile: boolean) {
  const database = new Database(databasePath);
  database.pragma("journal_mode = DELETE");
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row: any) => String(row.name));
  database.exec("PRAGMA foreign_keys = OFF");
  database.transaction(() => {
    for (const table of tables) {
      const isProfile = PROFILE_TABLES.has(table);
      if ((keepProfile && !isProfile) || (!keepProfile && isProfile)) {
        database.exec(`DROP TABLE IF EXISTS "${table.replace(/"/g, '""')}"`);
      }
    }
  })();
  database.exec("VACUUM");
  const integrity = String(database.pragma("integrity_check", { simple: true }));
  database.close();
  if (integrity !== "ok") throw new Error(`Migrated database integrity check failed: ${integrity}`);
}

function ensureProjectStorageTable(databasePath: string) {
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS o_projectStorage (
      projectId INTEGER NOT NULL PRIMARY KEY,
      storageKey TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL DEFAULT 1,
      snapshotRevision INTEGER NOT NULL DEFAULT 0,
      snapshotState TEXT NOT NULL DEFAULT 'stale',
      lastSnapshotAt INTEGER,
      lastChangedAt INTEGER,
      errorReason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_project_storage_snapshot
      ON o_projectStorage(snapshotState, revision);
    INSERT OR IGNORE INTO o_projectStorage
      (projectId, storageKey, revision, snapshotRevision, snapshotState)
    SELECT id, CAST(id AS TEXT), 1, 0, 'stale' FROM o_project;
  `);
  database.close();
}

async function copyLegacyMedia(sourceRoot: string, stagingRoot: string, projectIds: number[]) {
  const sourceOss = path.join(sourceRoot, "oss");
  for (const projectId of projectIds) {
    const source = path.join(sourceOss, String(projectId));
    const target = path.join(stagingRoot, "projects", String(projectId), "media");
    if (fss.existsSync(source)) await fs.cp(source, target, { recursive: true, filter: (item) => !/[/\\]smallImage([/\\]|$)/i.test(item) });
  }
}

async function copyUserConfiguration(sourceRoot: string) {
  for (const name of ["vendor", "skills", "modelPrompt"]) {
    const source = path.join(sourceRoot, name);
    const target = userDataPath(name);
    if (fss.existsSync(source)) {
      await fs.mkdir(target, { recursive: true });
      await fs.cp(source, target, { recursive: true, force: false, errorOnExist: false });
    }
  }
}

export async function performStorageMigration(
  input: { sourcePath?: string; targetPath: string },
  taskId: string | number,
) {
  const validation = await validateWorkspaceTarget(input.targetPath);
  const blockers = await activeMigrationBlockers();
  if (blockers.count) throw new Error("Active provider tasks must finish before workspace migration");
  const sourceRoot = path.resolve(input.sourcePath || workspaceRoot());
  const sourceDatabase = databaseFileFor(sourceRoot);
  const sourceHealth = inspectSqlite(sourceDatabase);
  if (!sourceHealth.healthy) throw new Error(`Source database is unhealthy: ${sourceHealth.message}`);
  const target = validation.targetPath;
  const staging = path.join(path.dirname(target), `.${path.basename(target)}.toonflow-migrate-${randomSuffix()}`);
  const lock = storageMigrationLockPath();
  await fs.mkdir(path.dirname(lock), { recursive: true });
  await fs.writeFile(lock, JSON.stringify({ taskId, sourceRoot, target, startedAt: Date.now() }), "utf8");
  const progress = async (value: number, phase: string) =>
    updateUnifiedTask(taskId, { status: "processing", progress: value, phase });
  try {
    await progress(5, "backup");
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(path.join(staging, "backups"), { recursive: true });
    const backupPath = path.join(staging, "backups", `source-before-migration-${Date.now()}.sqlite`);
    const sourceDb = new Database(sourceDatabase, { readonly: true });
    sourceDb.prepare("VACUUM INTO ?").run(backupPath);
    sourceDb.close();

    await progress(20, "split-database");
    const stagedWorkspaceDb = path.join(staging, "workspace.sqlite");
    const pendingProfile = path.join(appDataRoot(), "temp", `profile-migration-${Date.now()}.sqlite`);
    await fs.mkdir(path.dirname(pendingProfile), { recursive: true });
    await fs.copyFile(backupPath, stagedWorkspaceDb);
    const existingProfile = storageMode() === "workspace" && fss.existsSync(profileDatabasePath())
      ? profileDatabasePath()
      : backupPath;
    await fs.copyFile(existingProfile, pendingProfile);
    stripDatabase(stagedWorkspaceDb, false);
    stripDatabase(pendingProfile, true);
    ensureProjectStorageTable(stagedWorkspaceDb);

    await progress(35, "copy-media");
    const projectDb = new Database(stagedWorkspaceDb, { readonly: true });
    const projectIds = projectDb
      .prepare("SELECT id FROM o_project ORDER BY id")
      .all()
      .map((row: any) => Number(row.id));
    projectDb.close();
    if (storageMode() === "workspace" && fss.existsSync(path.join(sourceRoot, "projects"))) {
      await fs.cp(path.join(sourceRoot, "projects"), path.join(staging, "projects"), {
        recursive: true,
        filter: (item) => !/[/\\](project\.toonflow|manifest\.json|smallImage)([/\\]|$)/i.test(item),
      });
    } else {
      await copyLegacyMedia(sourceRoot, staging, projectIds);
    }
    await copyUserConfiguration(sourceRoot);

    await progress(60, "project-snapshots");
    const stagedDb = knex({
      client: "better-sqlite3",
      connection: { filename: stagedWorkspaceDb },
      pool: {
        afterCreate(connection: any, done: (error: Error | null, connection: any) => void) {
          try {
            connection.exec(`ATTACH DATABASE '${pendingProfile.replace(/'/g, "''")}' AS profile`);
            done(null, connection);
          } catch (error) {
            done(error as Error, connection);
          }
        },
      },
      useNullAsDefault: true,
    });
    for (let index = 0; index < projectIds.length; index += 1) {
      const projectId = projectIds[index];
      await generateProjectSnapshot(projectId, stagedDb, {
        workspaceRoot: staging,
        mediaRoot: path.join(staging, "projects", String(projectId), "media"),
      });
      await progress(60 + Math.floor(((index + 1) / Math.max(1, projectIds.length)) * 25), "project-snapshots");
    }
    await stagedDb.destroy();

    await fs.writeFile(
      path.join(staging, "workspace.json"),
      JSON.stringify({ version: 1, createdAt: Date.now(), projectCount: projectIds.length }, null, 2),
      "utf8",
    );
    await progress(90, "activate");
    if (fss.existsSync(target)) await fs.rm(target, { recursive: true, force: true });
    await fs.rename(staging, target);
    writeRuntimeStorageConfig({
      version: 1,
      mode: "workspace",
      workspacePath: target,
      legacyDataPath: sourceRoot,
      pendingProfilePath: pendingProfile,
      selectionRequired: false,
      updatedAt: Date.now(),
    });
    await progress(100, "restart-required");
    return { workspacePath: target, projectCount: projectIds.length, restartRequired: true, sourcePreserved: true };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(lock, { force: true }).catch(() => {});
  }
}

function randomSuffix() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function getStorageStatus() {
  const root = storageMode() === "workspace" ? workspaceRoot() : legacyDataRoot();
  const size = await directorySize(root);
  const projects = Number((await db("o_project").count<{ count: number }[]>({ count: "*" }).first())?.count || 0);
  const blockers = await activeMigrationBlockers();
  const runtime = readRuntimeStorageConfig();
  return {
    mode: storageMode(),
    workspacePath: workspaceRoot(),
    appDataPath: appDataRoot(),
    profileDatabasePath: profileDatabasePath(),
    workspaceDatabasePath: workspaceDatabasePath(),
    projectCount: projects,
    totalFiles: size.files,
    totalBytes: size.bytes,
    maintenance: isStorageMaintenanceActive(),
    activeTaskCount: blockers.count,
    restartRequired: Boolean(runtime?.pendingProfilePath),
    selectionRequired: Boolean(runtime?.selectionRequired),
  };
}
