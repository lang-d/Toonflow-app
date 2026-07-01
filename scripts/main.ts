import {
  app,
  BrowserWindow,
  protocol,
  systemPreferences,
  utilityProcess,
  MessageChannelMain,
  dialog,
  type UtilityProcess,
} from "electron";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { startRuntimeMetrics, type RuntimeMetric } from "../src/runtime/runtimeMetrics";
import { buildRuntimeWatchdogDiagnostics, evaluateRuntimeWatchdog } from "../src/runtime/runtimeWatchdog";
import {
  RUNTIME_API_PORT,
  RUNTIME_API_URL,
  type RuntimeRole,
  type RuntimeServiceState,
  type RuntimeSupervisorSnapshot,
} from "../src/runtime/runtimeProtocol";
import {
  readRuntimeStorageConfig,
  writeRuntimeStorageConfig,
  type RuntimeStorageConfig,
} from "../src/services/storagePaths";
import { initLogger, createLogger } from "../src/logger";
import { sanitizeRuntimeEnv } from "./runtimeEnv";

const APP_NAME = "ToonFlow";
const mainLog = createLogger("runtime-main");

app.setName(APP_NAME);
const electronUserDataOverride = process.env.TOONFLOW_ELECTRON_USER_DATA_DIR?.trim();
if (electronUserDataOverride) {
  app.setPath("userData", path.resolve(electronUserDataOverride));
}
if (process.platform === "win32") app.setAppUserModelId("net.toonflow.www");

// 加速 Electron 启动：跳过 GPU 信息收集，减少初始化耗时
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

const SYSTEM_ENTRIES = new Set(["assets", "models", "serve", "web", "skills", "modelPrompt"]);
const ALWAYS_REFRESH_SYSTEM_ENTRIES = new Set(["serve", "web", "skills"]);
const USER_ENTRIES = new Set(["vendor"]);
const VITE_DEV_ORIGIN = "http://127.0.0.1:50188";
const VITE_READY_TIMEOUT_MS = 30_000;
const VITE_READY_INTERVAL_MS = 300;
const VITE_READINESS_PATHS = ["/", "/@vite/client", "/src/pages/workbench/index.vue"];

function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    entry.isDirectory() ? copyDir(s, d) : fs.existsSync(d) || fs.copyFileSync(s, d);
  }
}

function copyUserDataEntryIfMissing(srcRoot: string, destRoot: string, entryName: string) {
  const src = path.join(srcRoot, entryName);
  const dest = path.join(destRoot, entryName);
  if (!fs.existsSync(src) || fs.existsSync(dest)) return false;
  const stat = fs.statSync(src);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (stat.isDirectory()) copyDir(src, dest);
  else if (stat.isFile()) fs.copyFileSync(src, dest);
  return true;
}

function migrateLegacyElectronUserData() {
  const currentRoot = app.getPath("userData");
  const legacyRoot = path.join(app.getPath("appData"), "Electron");
  if (path.resolve(currentRoot) === path.resolve(legacyRoot)) return [];
  if (fs.existsSync(path.join(currentRoot, "runtime.json"))) return [];
  const legacyConfig = readRuntimeStorageConfig(legacyRoot);
  if (!legacyConfig) return [];

  const copied: string[] = [];
  for (const entry of ["runtime.json", "profile.sqlite", "user", "system", "logs"]) {
    if (copyUserDataEntryIfMissing(legacyRoot, currentRoot, entry)) copied.push(entry);
  }
  return copied;
}

function isDirectoryEmpty(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

declare const __APP_VERSION__: string;

function getAppVersion(): string {
  if (typeof __APP_VERSION__ !== "undefined") return __APP_VERSION__;
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a
    .split(".")
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n));
  const pb = b
    .split(".")
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function getOverrideDataPath(): string | null {
  const dataDir = process.env.TOONFLOW_DATA_DIR?.trim();
  if (dataDir) return path.resolve(dataDir);

  const workDir = process.env.TOONFLOW_WORK_DIR?.trim();
  if (workDir) return path.resolve(workDir, "data");

  const configPath = path.resolve(process.cwd(), "toonflow.local.json");
  if (fs.existsSync(configPath)) {
    try {
      const localConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
        dataDir?: string;
        workDir?: string;
      };
      if (localConfig.dataDir?.trim()) return path.resolve(localConfig.dataDir);
      if (localConfig.workDir?.trim()) return path.resolve(localConfig.workDir, "data");
    } catch (err) {
      console.warn("[ToonFlow] failed to read toonflow.local.json:", err);
    }
  }

  return null;
}

function resolveStorageRuntime(): RuntimeStorageConfig {
  const appRoot = app.getPath("userData");
  const saved = readRuntimeStorageConfig(appRoot);
  if (saved) return activatePendingProfile(saved);
  const configuredLegacy = getOverrideDataPath();
  const defaultLegacy = path.join(appRoot, "data");
  const legacyPath =
    configuredLegacy && fs.existsSync(path.join(configuredLegacy, "db2.sqlite"))
      ? configuredLegacy
      : fs.existsSync(path.join(defaultLegacy, "db2.sqlite"))
        ? defaultLegacy
        : null;
  const config: RuntimeStorageConfig = legacyPath
    ? {
        version: 1,
        mode: "legacy",
        workspacePath: legacyPath,
        legacyDataPath: legacyPath,
        updatedAt: Date.now(),
      }
    : {
        version: 1,
        mode: "workspace",
        workspacePath: path.join(app.getPath("documents"), "Toonflow Workspace"),
        selectionRequired: true,
        updatedAt: Date.now(),
      };
  writeRuntimeStorageConfig(config, appRoot);
  return config;
}

function activatePendingProfile(config: RuntimeStorageConfig): RuntimeStorageConfig {
  if (!config.pendingProfilePath || !fs.existsSync(config.pendingProfilePath)) return config;
  const appRoot = app.getPath("userData");
  const profilePath = path.join(appRoot, "profile.sqlite");
  const backupPath = path.join(appRoot, `profile-before-migration-${Date.now()}.sqlite`);
  try {
    if (fs.existsSync(profilePath)) fs.renameSync(profilePath, backupPath);
    fs.renameSync(config.pendingProfilePath, profilePath);
    const activated = { ...config };
    delete activated.pendingProfilePath;
    activated.updatedAt = Date.now();
    writeRuntimeStorageConfig(activated, appRoot);
    return activated;
  } catch (error) {
    if (!fs.existsSync(profilePath) && fs.existsSync(backupPath)) fs.renameSync(backupPath, profilePath);
    throw error;
  }
}

function applyStorageEnvironment(config: RuntimeStorageConfig) {
  const appRoot = app.getPath("userData");
  process.env.TOONFLOW_APP_DATA_DIR = appRoot;
  process.env.TOONFLOW_WORKSPACE_DIR = config.workspacePath;
  process.env.TOONFLOW_STORAGE_MODE = config.mode;
  if (config.legacyDataPath) {
    process.env.TOONFLOW_LEGACY_DATA_DIR = config.legacyDataPath;
    process.env.TOONFLOW_DATA_DIR = config.legacyDataPath;
  } else {
    delete process.env.TOONFLOW_LEGACY_DATA_DIR;
    delete process.env.TOONFLOW_DATA_DIR;
  }
}

function getSystemDataPath(): string {
  return path.join(app.getPath("userData"), "system");
}

function initializeData(): void {
  const srcDir = path.resolve(app.isPackaged ? path.join(process.resourcesPath, "data") : path.join(process.cwd(), "data"));
  const systemDir = path.resolve(getSystemDataPath());
  const userDir = path.resolve(app.getPath("userData"), "user");
  console.log("[ToonFlow] system data dir:", systemDir);
  const versionFilePath = path.join(systemDir, "version.txt");
  const appVersion = getAppVersion();

  let shouldForceReplace = false;
  if (!fs.existsSync(versionFilePath)) {
    shouldForceReplace = true;
  } else {
    const localVersion = fs.readFileSync(versionFilePath, "utf-8").trim();
    if (compareVersions(localVersion, appVersion) < 0) {
      shouldForceReplace = true;
    }
  }

  for (const dir of SYSTEM_ENTRIES) {
    const targetDir = path.join(systemDir, dir);
    const shouldRefreshEntry = shouldForceReplace || (app.isPackaged && ALWAYS_REFRESH_SYSTEM_ENTRIES.has(dir));
    if (shouldRefreshEntry) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      copyDir(path.join(srcDir, dir), targetDir);
      continue;
    }
    if (!fs.existsSync(targetDir)) {
      copyDir(path.join(srcDir, dir), targetDir);
    } else if (isDirectoryEmpty(targetDir)) {
      copyDir(path.join(srcDir, dir), targetDir);
    }
  }
  for (const dir of USER_ENTRIES) {
    const targetDir = path.join(userDir, dir);
    if (!fs.existsSync(targetDir) || isDirectoryEmpty(targetDir)) copyDir(path.join(srcDir, dir), targetDir);
  }

  if (shouldForceReplace) {
    fs.mkdirSync(systemDir, { recursive: true });
    fs.writeFileSync(versionFilePath, `${appVersion}\n`, "utf-8");
  }
}

// 主窗口与运行时状态
let mainWindow: BrowserWindow | null = null;
let loadingWindow: BrowserWindow | null = null;
let workspaceLockPath: string | null = null;
let workspaceLockHeartbeatTimer: NodeJS.Timeout | null = null;
let workspaceLockSessionId: string | null = null;
let activeStorageConfig: RuntimeStorageConfig | null = null;
let startupInProgress = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const WORKSPACE_LOCK_HEARTBEAT_INTERVAL_MS = 10_000;
const WORKSPACE_LOCK_STALE_MS = 120_000;

type WorkspaceLockFile = {
  pid?: number;
  workspacePath?: string;
  startedAt?: number;
  heartbeatAt?: number;
  sessionId?: string;
  appPath?: string;
};

type StartupErrorCode =
  | "workspace_lock_active"
  | "workspace_lock_legacy_active"
  | "workspace_lock_repair_failed"
  | "api_port_unavailable"
  | "unknown_startup_error";

class ToonflowStartupError extends Error {
  code: StartupErrorCode;
  details: Record<string, unknown>;
  constructor(code: StartupErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ToonflowStartupError";
    this.code = code;
    this.details = details;
  }
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== "ESRCH";
  }
}

type ProcessInspection = {
  pid: number;
  exists: boolean;
  readable: boolean;
  name?: string;
  executablePath?: string;
  commandLine?: string;
  parentPid?: number;
  error?: string;
};

type LockOwnerClassification = "stale" | "owned" | "toonflow" | "pid-reused" | "unknown";

function inspectProcess(pid: number): ProcessInspection {
  if (!Number.isInteger(pid) || pid <= 0) return { pid, exists: false, readable: false, error: "invalid pid" };
  if (!processIsAlive(pid)) return { pid, exists: false, readable: true };

  if (process.platform !== "win32") {
    return { pid, exists: true, readable: true, name: "", executablePath: "", commandLine: "" };
  }

  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        [
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop`,
          "if ($null -eq $p) {",
          "  [pscustomobject]@{ exists = $false } | ConvertTo-Json -Compress",
          "} else {",
          "  [pscustomobject]@{",
          "    exists = $true",
          "    processId = $p.ProcessId",
          "    parentProcessId = $p.ParentProcessId",
          "    name = $p.Name",
          "    executablePath = $p.ExecutablePath",
          "    commandLine = $p.CommandLine",
          "  } | ConvertTo-Json -Compress",
          "}",
        ].join("\n"),
      ],
      { encoding: "utf8", timeout: 3_000, windowsHide: true },
    ).trim();
    const parsed = JSON.parse(output || "{}") as {
      exists?: boolean;
      processId?: number;
      parentProcessId?: number;
      name?: string;
      executablePath?: string;
      commandLine?: string;
    };
    if (!parsed.exists) return { pid, exists: false, readable: true };
    return {
      pid,
      exists: true,
      readable: true,
      name: parsed.name || "",
      executablePath: parsed.executablePath || "",
      commandLine: parsed.commandLine || "",
      parentPid: Number(parsed.parentProcessId || 0) || undefined,
    };
  } catch (error) {
    try {
      const tasklist = execFileSync(
        "tasklist.exe",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", timeout: 2_000, windowsHide: true },
      ).trim();
      if (!tasklist || /^INFO:/i.test(tasklist)) return { pid, exists: false, readable: true };
      const match = tasklist.match(/^"([^"]+)"/);
      const name = match?.[1] || "";
      return {
        pid,
        exists: true,
        readable: true,
        name,
        executablePath: "",
        commandLine: "",
        error: String((error as Error)?.message || error),
      };
    } catch {
      // Keep the original inspection error; tasklist is only a best-effort fallback.
    }
    return {
      pid,
      exists: true,
      readable: false,
      error: String((error as Error)?.message || error),
    };
  }
}

function lowerText(value: unknown) {
  return String(value || "").toLowerCase();
}

function isToonflowProcess(lock: WorkspaceLockFile, info: ProcessInspection): boolean {
  const name = lowerText(info.name);
  const executablePath = lowerText(info.executablePath);
  const commandLine = lowerText(info.commandLine);
  const normalizedCommandLine = commandLine.replace(/\\/g, "/");
  const currentExe = lowerText(app.getPath("exe"));
  const currentAppPath = lowerText(app.getAppPath());
  const currentCwd = lowerText(process.cwd());
  const normalizedCurrentAppPath = currentAppPath.replace(/\\/g, "/");
  const normalizedCurrentCwd = currentCwd.replace(/\\/g, "/");
  const lockedAppPath = lowerText(lock.appPath);
  const isElectron = name === "electron.exe" || name === "electron";
  const isNode = name === "node.exe" || name === "node";

  if (name.includes("toonflow")) return true;
  if (lockedAppPath && (executablePath === lockedAppPath || commandLine.includes(lockedAppPath))) return true;
  if (currentExe && (executablePath === currentExe || commandLine.includes(currentExe))) return true;
  if (isElectron) {
    if (normalizedCurrentAppPath && normalizedCommandLine.includes(normalizedCurrentAppPath)) return true;
    if (normalizedCurrentCwd && normalizedCommandLine.includes(normalizedCurrentCwd)) return true;
    if (normalizedCommandLine.includes("app.asar") || normalizedCommandLine.includes("scripts/main.ts")) return true;
    if (executablePath.includes("toonflow") || commandLine.includes("toonflow")) return true;
  }
  if (isNode) {
    const looksLikeToonflowNode =
      commandLine.includes("electronmon") ||
      normalizedCommandLine.includes("scripts/main.ts") ||
      normalizedCommandLine.includes("data/serve/app.js") ||
      normalizedCommandLine.includes("build/runtime-") ||
      commandLine.includes("runtime-api") ||
      commandLine.includes("runtime-worker") ||
      commandLine.includes("runtime-agent");
    if (looksLikeToonflowNode && normalizedCurrentCwd && normalizedCommandLine.includes(normalizedCurrentCwd)) return true;
    if (looksLikeToonflowNode && commandLine.includes("toonflow")) return true;
  }
  return false;
}

function isCurrentProcessAncestor(targetPid: number): boolean {
  let cursor = Number(process.ppid || 0);
  for (let depth = 0; depth < 12 && cursor > 0; depth += 1) {
    if (cursor === targetPid) return true;
    const info = inspectProcess(cursor);
    const next = Number(info.parentPid || 0);
    if (!info.exists || !next || next === cursor) return false;
    cursor = next;
  }
  return false;
}

function classifyLockOwner(lock: WorkspaceLockFile, info: ProcessInspection): LockOwnerClassification {
  const pid = Number(lock.pid || 0);
  if (!info.exists) return "stale";
  if (pid === process.pid) return "owned";
  if (pid === process.ppid || isCurrentProcessAncestor(pid)) return "pid-reused";
  if (!info.readable) return "unknown";
  if (isToonflowProcess(lock, info)) return "toonflow";
  return "pid-reused";
}

function waitForProcessExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return !processIsAlive(pid);
}

function terminateProcessTree(pid: number): { ok: boolean; error?: string } {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: true };
  if (pid === process.pid) return { ok: false, error: "Refuse to terminate current process" };
  if (!processIsAlive(pid)) return { ok: true };

  try {
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill.exe", ["/PID", String(pid), "/T"], { stdio: "ignore", timeout: 3_000, windowsHide: true });
      } catch {
        // Some GUI/background processes only exit with /F; fall through to the bounded forced attempt.
      }
      if (waitForProcessExit(pid, 2_000)) return { ok: true };
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 4_000, windowsHide: true });
      return waitForProcessExit(pid, 3_000)
        ? { ok: true }
        : { ok: false, error: `Process ${pid} is still running after taskkill` };
    }

    process.kill(pid, "SIGTERM");
    if (waitForProcessExit(pid, 2_000)) return { ok: true };
    process.kill(pid, "SIGKILL");
    return waitForProcessExit(pid, 3_000)
      ? { ok: true }
      : { ok: false, error: `Process ${pid} is still running after SIGKILL` };
  } catch (error) {
    if (!processIsAlive(pid)) return { ok: true };
    return { ok: false, error: String((error as Error)?.message || error) };
  }
}

function safeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function formatTime(value: unknown) {
  const time = Number(value || 0);
  if (!Number.isFinite(time) || time <= 0) return "未知";
  return new Date(time).toLocaleString();
}

function lockDetails(lock: WorkspaceLockFile | null, lockPath: string) {
  return {
    lockPath,
    pid: lock?.pid || 0,
    workspacePath: lock?.workspacePath || "",
    startedAt: lock?.startedAt || 0,
    heartbeatAt: lock?.heartbeatAt || 0,
    sessionId: lock?.sessionId || "",
  };
}

function writeWorkspaceLock(lockPath: string, config: RuntimeStorageConfig) {
  workspaceLockSessionId = randomUUID();
  const now = Date.now();
  const lock: Required<WorkspaceLockFile> = {
    pid: process.pid,
    workspacePath: config.workspacePath,
    startedAt: now,
    heartbeatAt: now,
    sessionId: workspaceLockSessionId,
    appPath: app.getPath("exe"),
  };
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), { encoding: "utf8", flag: "wx" });
  workspaceLockPath = lockPath;
}

function refreshWorkspaceLockHeartbeat() {
  if (!workspaceLockPath || !workspaceLockSessionId) return;
  try {
    const current = JSON.parse(fs.readFileSync(workspaceLockPath, "utf8")) as WorkspaceLockFile;
    if (current.pid !== process.pid || current.sessionId !== workspaceLockSessionId) return;
    current.heartbeatAt = Date.now();
    fs.writeFileSync(workspaceLockPath, JSON.stringify(current, null, 2), "utf8");
  } catch (error) {
    mainLog.warn("Failed to refresh workspace lock heartbeat", {
      event: "workspace-lock.heartbeat-failed",
      error: String((error as Error)?.message || error),
    });
  }
}

function startWorkspaceLockHeartbeat() {
  if (workspaceLockHeartbeatTimer) clearInterval(workspaceLockHeartbeatTimer);
  refreshWorkspaceLockHeartbeat();
  workspaceLockHeartbeatTimer = setInterval(refreshWorkspaceLockHeartbeat, WORKSPACE_LOCK_HEARTBEAT_INTERVAL_MS);
  workspaceLockHeartbeatTimer.unref();
}

function removeWorkspaceLock(lockPath: string, reason: string, details: Record<string, unknown> = {}) {
  mainLog.warn("Removing workspace lock", {
    event: "workspace-lock.removed",
    reason,
    lockPath,
    ...details,
  });
  fs.rmSync(lockPath, { force: true });
}

function throwWorkspaceRepairFailed(
  message: string,
  lockPath: string,
  lock: WorkspaceLockFile,
  info: ProcessInspection,
  extra: Record<string, unknown> = {},
): never {
  throw new ToonflowStartupError("workspace_lock_repair_failed", message, {
    ...lockDetails(lock, lockPath),
    processName: info.name || "",
    processPath: info.executablePath || "",
    processError: info.error || "",
    ...extra,
  });
}

function repairWorkspaceLock(lockPath: string, lock: WorkspaceLockFile) {
  const pid = Number(lock.pid || 0);
  if (!Number.isInteger(pid) || pid <= 0) {
    removeWorkspaceLock(lockPath, "invalid-pid", { pid });
    return;
  }

  const info = inspectProcess(pid);
  const classification = classifyLockOwner(lock, info);
  const heartbeatAge = lock.heartbeatAt ? Date.now() - Number(lock.heartbeatAt || 0) : Number.POSITIVE_INFINITY;
  mainLog.warn("Workspace lock owner inspected", {
    event: "workspace-lock.owner-inspected",
    lockPath,
    pid,
    classification,
    processName: info.name || "",
    processPath: info.executablePath || "",
    readable: info.readable,
    heartbeatAge,
    processError: info.error || "",
  });

  if (classification === "owned" || classification === "stale") {
    removeWorkspaceLock(lockPath, classification, { pid });
    return;
  }

  if (classification === "pid-reused") {
    removeWorkspaceLock(lockPath, "pid-reused", {
      pid,
      processName: info.name || "",
      processPath: info.executablePath || "",
    });
    return;
  }

  if (classification === "toonflow") {
    const terminated = terminateProcessTree(pid);
    if (terminated.ok) {
      removeWorkspaceLock(lockPath, "old-toonflow-terminated", { pid, processName: info.name || "" });
      return;
    }
    throwWorkspaceRepairFailed(
      `系统拒绝结束旧 Toonflow 进程 PID ${pid}，请重启电脑或以管理员权限关闭旧 Toonflow。`,
      lockPath,
      lock,
      info,
      { terminateError: terminated.error || "" },
    );
  }

  if (!lock.heartbeatAt || heartbeatAge > WORKSPACE_LOCK_STALE_MS) {
    const terminated = terminateProcessTree(pid);
    if (terminated.ok) {
      removeWorkspaceLock(lockPath, "unknown-stale-owner-terminated", { pid, heartbeatAge });
      return;
    }
    throwWorkspaceRepairFailed(
      `无法自动处理占用进程 PID ${pid}：${terminated.error || info.error || "系统拒绝结束进程"}。请重启电脑或以管理员权限关闭旧 Toonflow。`,
      lockPath,
      lock,
      info,
      { heartbeatAge, terminateError: terminated.error || "" },
    );
  }

  throwWorkspaceRepairFailed(
    `无法确认 PID ${pid} 是否为旧 Toonflow，且锁心跳仍然有效。为避免误杀其他程序，本次没有结束该进程。`,
    lockPath,
    lock,
    info,
    { heartbeatAge },
  );
}

function getListeningPortOwner(port: number): number | null {
  if (!Number.isInteger(port) || port <= 0) return null;

  if (process.platform === "win32") {
    try {
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          [
            `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
            "if ($null -eq $c) { '' } else { [string]$c.OwningProcess }",
          ].join("\n"),
        ],
        { encoding: "utf8", timeout: 3_000, windowsHide: true },
      ).trim();
      const pid = Number(output);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // Fall through to netstat; some Windows installs restrict Get-NetTCPConnection.
    }

    try {
      const output = execFileSync("netstat.exe", ["-ano", "-p", "TCP"], {
        encoding: "utf8",
        timeout: 3_000,
        windowsHide: true,
      });
      const escapedPort = String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const line = output
        .split(/\r?\n/)
        .find((entry) => new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::\\]|::1):${escapedPort}\\s+`, "i").test(entry) && /\sLISTENING\s/i.test(entry));
      const pid = Number(line?.trim().split(/\s+/).pop());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      return null;
    }
    return null;
  }

  try {
    const output = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 3_000,
    });
    const line = output.split(/\r?\n/).find((entry) => entry.includes(`:${port} `));
    const pid = Number(line?.trim().split(/\s+/)[1]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function repairRuntimeApiPort(port = RUNTIME_API_PORT) {
  const pid = getListeningPortOwner(port);
  if (!pid) return;

  const info = inspectProcess(pid);
  const classification = classifyLockOwner({ pid, appPath: app.getPath("exe") }, info);
  mainLog.warn("Runtime API port owner inspected", {
    event: "runtime-api-port.owner-inspected",
    port,
    pid,
    classification,
    processName: info.name || "",
    processPath: info.executablePath || "",
    readable: info.readable,
    processError: info.error || "",
  });

  if (classification === "stale") return;
  if (classification === "owned") {
    throw new ToonflowStartupError(
      "api_port_unavailable",
      `固定端口 ${port} 已被当前 Toonflow 进程占用，无法重复启动 API。`,
      { port, pid, processName: info.name || "", processPath: info.executablePath || "" },
    );
  }

  if (classification === "toonflow") {
    const terminated = terminateProcessTree(pid);
    if (terminated.ok) {
      mainLog.warn("Runtime API port owner terminated", {
        event: "runtime-api-port.owner-terminated",
        port,
        pid,
        processName: info.name || "",
      });
      return;
    }
    throw new ToonflowStartupError(
      "api_port_unavailable",
      `固定端口 ${port} 被旧 Toonflow 进程 PID ${pid} 占用，但系统拒绝结束它。`,
      {
        port,
        pid,
        processName: info.name || "",
        processPath: info.executablePath || "",
        processError: info.error || "",
        terminateError: terminated.error || "",
      },
    );
  }

  throw new ToonflowStartupError(
    "api_port_unavailable",
    classification === "unknown"
      ? `固定端口 ${port} 被 PID ${pid} 占用，但无法确认它是否为 Toonflow。`
      : `固定端口 ${port} 被其他程序 PID ${pid} 占用。`,
    {
      port,
      pid,
      processName: info.name || "",
      processPath: info.executablePath || "",
      processError: info.error || "",
    },
  );
}

function acquireWorkspaceLock(config: RuntimeStorageConfig) {
  if (config.mode !== "workspace") return;
  fs.mkdirSync(config.workspacePath, { recursive: true });
  const lockPath = path.join(config.workspacePath, ".toonflow.lock");
  if (fs.existsSync(lockPath)) {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as WorkspaceLockFile;
      repairWorkspaceLock(lockPath, current);
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.warn("[ToonFlow] replacing an invalid workspace lock");
      } else {
        throw error;
      }
    }
    if (fs.existsSync(lockPath)) fs.rmSync(lockPath, { force: true });
  }
  writeWorkspaceLock(lockPath, config);
  startWorkspaceLockHeartbeat();
}

function releaseWorkspaceLock() {
  if (workspaceLockHeartbeatTimer) {
    clearInterval(workspaceLockHeartbeatTimer);
    workspaceLockHeartbeatTimer = null;
  }
  if (!workspaceLockPath) return;
  try {
    const current = JSON.parse(fs.readFileSync(workspaceLockPath, "utf8")) as WorkspaceLockFile;
    if (current.pid === process.pid && current.sessionId === workspaceLockSessionId) fs.rmSync(workspaceLockPath, { force: true });
  } catch {
    // A missing or replaced lock is no longer owned by this process.
  }
  workspaceLockPath = null;
  workspaceLockSessionId = null;
}

if (!hasSingleInstanceLock) {
  console.warn("[ToonFlow] another application instance is already running, exiting");
  app.quit();
}

app.on("second-instance", () => {
  const window = mainWindow || loadingWindow;
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

const loadingHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
  background:#fff;color:#333;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  user-select:none;-webkit-app-region:drag}
.spinner{width:48px;height:48px;border:4px solid rgba(0,0,0,.1);
  border-top-color:#000;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
p{margin-top:20px;font-size:14px;opacity:.6}
</style></head><body><div class="spinner"></div><p>正在启动服务...</p></body></html>`)}`;

function ensureLoadingWindow(): BrowserWindow {
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.show();
    loadingWindow.focus();
    return loadingWindow;
  }

  loadingWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    show: true,
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#ffffff",
      symbolColor: "#333333",
      height: 36,
    },
  });
  loadingWindow.setMenuBarVisibility(false);
  loadingWindow.removeMenu();
  loadingWindow.on("closed", () => {
    loadingWindow = null;
  });
  return loadingWindow;
}

async function showLoading(): Promise<void> {
  const window = ensureLoadingWindow();
  await window.loadURL(loadingHtml);
}

function closeLoading(): void {
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.close();
    loadingWindow = null;
  }
}

function selectDirectory(options: Electron.OpenDialogSyncOptions) {
  const owner = mainWindow || loadingWindow;
  return owner ? dialog.showOpenDialogSync(owner, options) : dialog.showOpenDialogSync(options);
}

function updateLoadingMessage(message: string): void {
  if (!loadingWindow || loadingWindow.isDestroyed()) return;
  void loadingWindow.webContents.executeJavaScript(
    `document.querySelector("p") && (document.querySelector("p").textContent = ${JSON.stringify(message)})`,
  );
}

async function isViteReady(): Promise<boolean> {
  const checks = await Promise.all(
    VITE_READINESS_PATHS.map(async (pathname) => {
      try {
        const response = await fetch(`${VITE_DEV_ORIGIN}${pathname}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(2_000),
        });
        return { pathname, ok: response.ok, status: response.status };
      } catch (error) {
        return { pathname, ok: false, error };
      }
    }),
  );
  const failed = checks.filter((check) => !check.ok);
  if (failed.length) {
    console.warn(
      "[vite-ready] waiting for dev server:",
      failed
        .map((check) =>
          "status" in check
            ? `${check.pathname} -> HTTP ${check.status}`
            : `${check.pathname} -> ${check.error instanceof Error ? check.error.message : String(check.error)}`,
        )
        .join("; "),
    );
    return false;
  }
  return true;
}

async function waitForViteReady(timeoutMs = VITE_READY_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  updateLoadingMessage("前端服务正在启动...");
  while (Date.now() < deadline) {
    if (await isViteReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, VITE_READY_INTERVAL_MS));
  }
  return false;
}

function showViteStartupError(): void {
  const errorHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#f5f6f8;color:#202124;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.panel{width:min(640px,calc(100vw - 64px));padding:32px;background:#fff;border:1px solid #ddd;border-radius:8px}
h1{font-size:20px;margin:0 0 16px}p{line-height:1.7;margin:8px 0}.address{font-family:Consolas,monospace}
button{margin-top:20px;padding:9px 18px;border:0;border-radius:4px;background:#0052d9;color:#fff;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}
</style></head><body><div class="panel"><h1>前端服务尚未就绪</h1>
<p>开发服务器 <span class="address">${VITE_DEV_ORIGIN}</span> 当前无法完整加载。</p>
<p>请确认 Vite 已启动。后端运行进程不会因此停止。</p>
<button id="retry">重新检测</button>
<script>
const button=document.getElementById("retry");
button.addEventListener("click",async()=>{
  button.disabled=true;
  button.textContent="正在检测...";
  try{await fetch("toonflow://retryvite");}
  catch{button.disabled=false;button.textContent="重新检测";}
});
</script></div></body></html>`)}`;
  const window = ensureLoadingWindow();
  void window.loadURL(errorHtml);
}

function showStartupError(error: unknown): void {
  const startupError =
    error instanceof ToonflowStartupError
      ? error
      : error instanceof Error && /10588|EADDRINUSE|fixed port|bind/i.test(error.message)
        ? new ToonflowStartupError(
            "api_port_unavailable",
            `固定端口 ${RUNTIME_API_PORT} 被占用，点击重载会自动处理可确认的旧 Toonflow runtime。`,
            { port: RUNTIME_API_PORT },
          )
        : new ToonflowStartupError(
            "unknown_startup_error",
            error instanceof Error ? error.message : String(error),
          );
  const title =
    startupError.code === "workspace_lock_active" ||
    startupError.code === "workspace_lock_legacy_active" ||
    startupError.code === "workspace_lock_repair_failed"
      ? "工作区正在被占用"
      : startupError.code === "api_port_unavailable"
        ? "Toonflow API 端口不可用"
        : "Toonflow 启动失败";
  const detailRows = [
    startupError.details.workspacePath ? ["工作区", startupError.details.workspacePath] : null,
    startupError.details.pid ? ["占用进程 PID", startupError.details.pid] : null,
    startupError.details.processName ? ["进程名称", startupError.details.processName] : null,
    startupError.details.heartbeatAt ? ["最近心跳", formatTime(startupError.details.heartbeatAt)] : null,
    startupError.details.port ? ["端口", startupError.details.port] : null,
  ].filter(Boolean) as Array<[string, unknown]>;
  const detailsHtml = detailRows.length
    ? `<div class="details">${detailRows
        .map(([label, value]) => `<div><span>${safeHtml(label)}</span><strong>${safeHtml(value)}</strong></div>`)
        .join("")}</div>`
    : "";
  const errorHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#f5f6f8;color:#202124;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.panel{width:min(680px,calc(100vw - 64px));padding:32px;background:#fff;border:1px solid #ddd;border-radius:8px}
h1{font-size:20px;margin:0 0 16px}p{line-height:1.7;margin:8px 0}.address{font-family:Consolas,monospace}
.details{margin:18px 0;padding:12px;background:#f8f8f8;border-radius:4px}
.details div{display:flex;gap:16px;margin:6px 0}.details span{width:120px;color:#666}.details strong{font-weight:500;word-break:break-all}
.error{margin-top:18px;padding:12px;background:#f8f8f8;border-left:3px solid #d93025;white-space:pre-wrap;
word-break:break-word;font-family:Consolas,monospace;font-size:12px}
button{margin-top:18px;padding:8px 18px;border:0;border-radius:4px;background:#0052d9;color:#fff;cursor:pointer}
button:disabled{opacity:.6;cursor:not-allowed}
.retry-message{min-height:20px;color:#d93025;font-size:13px}
</style></head><body><div class="panel"><h1>${safeHtml(title)}</h1>
<p>${safeHtml(startupError.message)}</p>
<p>点击重载将自动处理旧 Toonflow 进程或失效锁。</p>
<p>固定地址 <span class="address">${RUNTIME_API_URL}</span></p>
${detailsHtml}
<div class="error">${safeHtml(error instanceof Error ? error.message : String(error))}</div>
<button id="reload">重载</button>
<p id="retry-message" class="retry-message"></p>
<script>
const button=document.getElementById("reload");
button.addEventListener("click",async()=>{
  button.disabled=true;
  button.textContent="正在重载...";
  const message=document.getElementById("retry-message");
  if(message) message.textContent="";
  try{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),8000);
    const response=await fetch("toonflow://retry-startup",{cache:"no-store",signal:controller.signal});
    clearTimeout(timer);
    const result=await response.json().catch(()=>({ok:false,error:"重载请求没有返回有效结果"}));
    if(!result.ok||!result.started){
      button.disabled=false;
      button.textContent="重载";
      if(message) message.textContent=result.reason||result.error||"本次自动修复未能启动。";
      return;
    }
    if(message) message.textContent=result.repaired ? "已自动处理旧进程或失效锁，正在启动。" : "正在自动处理旧进程或失效锁。";
    setTimeout(()=>{
      if(!document.body.contains(button)) return;
      button.disabled=false;
      button.textContent="重载";
      if(message) message.textContent="本次重载未在限定时间内完成启动，请查看当前错误原因。";
    },8000);
  }
  catch(error){
    button.disabled=false;
    button.textContent="重载";
    if(message) message.textContent=String(error&&error.message||error||"重载请求超时或失败");
  }
});
</script>
</div></body></html>`)}`;
  const window = ensureLoadingWindow();
  void window.loadURL(errorHtml);
}

async function createMainWindow(): Promise<void> {
  if (process.env.VITE_DEV && !(await waitForViteReady())) {
    showViteStartupError();
    return;
  }

  return new Promise((resolve) => {
    let settled = false;
    const win = new BrowserWindow({
      width: 1000,
      height: 700,
      minWidth: 800,
      minHeight: 500,
      frame: false,
      show: false,
      autoHideMenuBar: true,
      resizable: true,
      thickFrame: true,
    });
    mainWindow = win;
    win.setMenuBarVisibility(false);
    win.removeMenu();

    win.on("closed", () => {
      mainWindow = null;
    });

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const handleLoadFailure = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (!win.isDestroyed()) win.destroy();
      mainWindow = null;
      if (process.env.VITE_DEV) {
        showViteStartupError();
      } else {
        showStartupError(error);
      }
      resolve();
    };

    win.once("ready-to-show", () => {
      closeLoading();
      win.show();
      finish();
    });

    win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      handleLoadFailure(new Error(`window load failed (${errorCode}) ${errorDescription}: ${validatedURL}`));
    });

    const isDev = process.env.NODE_ENV === "dev" || !app.isPackaged;
    if (process.env.VITE_DEV) {
      void win.loadURL(VITE_DEV_ORIGIN).catch(handleLoadFailure);
    } else {
      const htmlPath = isDev
        ? path.join(process.cwd(), "data", "web", "index.html")
        : path.join(getSystemDataPath(), "web", "index.html");
      void win.loadFile(htmlPath).catch(handleLoadFailure);
    }
  });
}

type RuntimeRecord = {
  role: RuntimeRole;
  process: UtilityProcess;
  restartCount: number;
  stopping: boolean;
  ready: boolean;
  readyAt: number;
  healthKillIssued: boolean;
  lastStdoutAt: number;
  lastStderrAt: number;
  lastMetricAt: number;
  lastMetric?: RuntimeMetric;
  lastHealthDiagnosticAt: number;
};

const runtimeRecords = new Map<RuntimeRole, RuntimeRecord>();
const runtimeStates = new Map<RuntimeRole, RuntimeServiceState>();
const ipcConnectedRoles = new Set<RuntimeRole>();
let runtimeShuttingDown = false;
let runtimeBootCompleted = false;
let stopMainMetrics: undefined | (() => void);
let runtimeHealthTimer: NodeJS.Timeout | null = null;

function runtimeEntry(role: RuntimeRole) {
  if (app.isPackaged) {
    const file = role === "api" ? "api-process.js" : role === "worker" ? "task-worker.js" : "agent-process.js";
    const modulePaths = [
      path.join(process.resourcesPath, "app.asar", "node_modules"),
      path.join(process.resourcesPath, "app.asar.unpacked", "node_modules"),
      process.env.NODE_PATH,
    ].filter(Boolean);
    return {
      file: path.join(getSystemDataPath(), "serve", "runtime", file),
      execArgv: [] as string[],
      env: { NODE_PATH: modulePaths.join(path.delimiter) },
    };
  }
  const file = role === "api" ? "apiProcess.ts" : role === "worker" ? "taskWorker.ts" : "agentProcess.ts";
  return {
    file: path.join(process.cwd(), "scripts", "runtimeBootstrap.cjs"),
    execArgv: [] as string[],
    env: { TOONFLOW_RUNTIME_ENTRY: path.join(process.cwd(), "src", "runtime", file) },
  };
}

function forwardRuntimeOutput(role: RuntimeRole, stream: NodeJS.ReadableStream | null, level: "log" | "error") {
  stream?.on("data", (chunk) => {
    const message = String(chunk).trimEnd();
    if (!message) return;
    const record = runtimeRecords.get(role);
    if (record) {
      if (level === "error") record.lastStderrAt = Date.now();
      else record.lastStdoutAt = Date.now();
    }
    mainLog[level === "error" ? "error" : "info"](message, {
      event: level === "error" ? "runtime.stderr" : "runtime.stdout",
      role: "main",
      childRole: role,
    });
  });
}

function getRuntimeSnapshot(): RuntimeSupervisorSnapshot {
  const roles: RuntimeRole[] = ["api", "worker", "agent"];
  return {
    apiUrl: RUNTIME_API_URL,
    updatedAt: Date.now(),
    services: roles.map((role) => {
      const state = runtimeStates.get(role);
      return {
        role,
        pid: state?.pid ?? 0,
        status: state?.status ?? "stopped",
        lastHeartbeatAt: state?.lastHeartbeatAt ?? 0,
        restartCount: state?.restartCount ?? 0,
        lastError: state?.lastError,
        ipcConnected: role === "api" ? state?.status === "ready" : ipcConnectedRoles.has(role),
      };
    }),
  };
}

function publishRuntimeState(): void {
  const api = runtimeRecords.get("api")?.process;
  if (!api?.pid) return;
  api.postMessage({ type: "runtime:supervisor", snapshot: getRuntimeSnapshot() });
}

function updateRuntimeState(role: RuntimeRole, patch: Partial<RuntimeServiceState>): void {
  const previous = runtimeStates.get(role);
  const hasLastError = Object.prototype.hasOwnProperty.call(patch, "lastError");
  runtimeStates.set(role, {
    role,
    pid: patch.pid ?? previous?.pid ?? 0,
    status: patch.status ?? previous?.status ?? "starting",
    lastHeartbeatAt: patch.lastHeartbeatAt ?? previous?.lastHeartbeatAt ?? Date.now(),
    restartCount: patch.restartCount ?? previous?.restartCount ?? 0,
    lastError: hasLastError ? patch.lastError : previous?.lastError,
    ipcConnected: patch.ipcConnected ?? previous?.ipcConnected,
  });
  publishRuntimeState();
}

function connectRuntimeChannel(role: "worker" | "agent") {
  const api = runtimeRecords.get("api")?.process;
  const child = runtimeRecords.get(role)?.process;
  if (!api?.pid || !child?.pid) return;
  const channel = new MessageChannelMain();
  api.postMessage({ type: "runtime:attach", role, pid: child.pid }, [channel.port1]);
  child.postMessage({ type: "runtime:attach", role: "api", pid: api.pid }, [channel.port2]);
  ipcConnectedRoles.add(role);
  updateRuntimeState(role, { ipcConnected: true });
}

function spawnRuntime(role: RuntimeRole, restartCount = 0): Promise<{ pid: number; port?: number }> {
  const { file, execArgv, env } = runtimeEntry(role);
  const rawChildEnv: Record<string, string | undefined> = {
    ...process.env,
    PORT: String(RUNTIME_API_PORT),
    TOONFLOW_UTILITY: "1",
    TOONFLOW_RUNTIME_ROLE: role,
    TOONFLOW_APP_DATA_DIR: process.env.TOONFLOW_APP_DATA_DIR,
    TOONFLOW_WORKSPACE_DIR: process.env.TOONFLOW_WORKSPACE_DIR,
    TOONFLOW_STORAGE_MODE: process.env.TOONFLOW_STORAGE_MODE,
    TOONFLOW_LEGACY_DATA_DIR: process.env.TOONFLOW_LEGACY_DATA_DIR,
    TOONFLOW_DATA_DIR: process.env.TOONFLOW_DATA_DIR,
    NODE_ENV: app.isPackaged ? "prod" : "dev",
    ...env,
  };
  const childEnv = sanitizeRuntimeEnv(rawChildEnv);
  delete childEnv.TOONFLOW_API_PORT;
  const child = utilityProcess.fork(file, [], {
    cwd: process.cwd(),
    execArgv,
    serviceName: `Toonflow ${role}`,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
  const record: RuntimeRecord = {
    role,
    process: child,
    restartCount,
    stopping: false,
    ready: false,
    readyAt: 0,
    healthKillIssued: false,
    lastStdoutAt: 0,
    lastStderrAt: 0,
    lastMetricAt: 0,
    lastHealthDiagnosticAt: 0,
  };
  runtimeRecords.set(role, record);
  updateRuntimeState(role, {
    pid: Number(child.pid || 0),
    status: "starting",
    lastHeartbeatAt: Date.now(),
    restartCount,
    lastError: undefined,
    ipcConnected: false,
  });
  forwardRuntimeOutput(role, child.stdout, "log");
  forwardRuntimeOutput(role, child.stderr, "error");

  child.on("message", (message: any) => {
    if (Number(message?.pid || 0) !== Number(child.pid || 0) && message?.pid) return;
    if (message?.type === "runtime:metric" && role !== "api") {
      record.lastMetricAt = Date.now();
      record.lastMetric = message.metric as RuntimeMetric;
      runtimeRecords.get("api")?.process.postMessage(message);
    }
    if (message?.type === "runtime:heartbeat") {
      record.healthKillIssued = false;
      updateRuntimeState(role, {
        pid: Number(child.pid || message.pid || 0),
        status: record.ready ? "ready" : "starting",
        lastHeartbeatAt: Number(message.timestamp || Date.now()),
        lastError: undefined,
      });
    }
    if (message?.type === "runtime:ready" && message.role === role) {
      record.ready = true;
      record.readyAt = Date.now();
      updateRuntimeState(role, {
        pid: Number(message.pid || child.pid || 0),
        status: "ready",
        lastHeartbeatAt: Date.now(),
        restartCount,
        lastError: undefined,
      });
    }
    if (message?.type === "runtime:error") {
      mainLog.error("Runtime child reported fatal error", {
        event: "runtime.error",
        childRole: role,
        childPid: message.pid,
        error: message.message,
      });
      updateRuntimeState(role, { status: "failed", lastError: String(message.message || "unknown runtime error") });
    }
    if (message?.type === "runtime:log") {
      mainLog.info(String(message.message || ""), {
        event: "runtime.child-log",
        childRole: message.role || role,
        childPid: message.pid,
      });
    }
    if (message?.type === "runtime:stopped") {
      updateRuntimeState(role, { status: "stopped" });
    }
  });
  child.on("exit", (code) => {
    const current = runtimeRecords.get(role);
    if (current?.process === child) runtimeRecords.delete(role);
    if (role === "api") {
      ipcConnectedRoles.clear();
    } else {
      ipcConnectedRoles.delete(role);
    }
    updateRuntimeState(role, {
      status: current?.stopping ? "stopped" : "failed",
      ipcConnected: false,
      lastError: current?.stopping ? undefined : `process exited with code ${code}`,
    });
    if (runtimeShuttingDown || current?.stopping) return;
    if (!runtimeBootCompleted) return;
    const stableRun = record.readyAt > 0 && Date.now() - record.readyAt >= 60_000;
    const nextAttempt = stableRun ? 1 : restartCount + 1;
    if (nextAttempt > 3) {
      updateRuntimeState(role, {
        status: "failed",
        restartCount,
        lastError: `restart limit reached after exit code ${code}`,
      });
      return;
    }
    const delays = [1000, 3000, 10_000];
    mainLog.warn("Runtime child exited; restarting", {
      event: "runtime.restart",
      childRole: role,
      code,
      delayMs: delays[nextAttempt - 1],
    });
    setTimeout(() => {
      void spawnRuntime(role, nextAttempt)
        .then(() => {
          if (role === "api") {
            connectRuntimeChannel("worker");
            connectRuntimeChannel("agent");
          } else {
            connectRuntimeChannel(role);
          }
          publishRuntimeState();
        })
        .catch((error) => {
          updateRuntimeState(role, { status: "failed", lastError: String(error?.message || error) });
        });
    }, delays[nextAttempt - 1]);
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${role} utility process startup timed out`)), 120_000);
    const onMessage = (message: any) => {
      if (message?.type === "runtime:error") {
        clearTimeout(timeout);
        child.off("message", onMessage);
        reject(new Error(message.message || `${role} utility process failed`));
      }
      if (message?.type === "runtime:ready" && message.role === role) {
        clearTimeout(timeout);
        child.off("message", onMessage);
        resolve({ pid: Number(message.pid || child.pid), port: message.port == null ? undefined : Number(message.port) });
      }
    };
    child.on("message", onMessage);
  });
}

function startRuntimeHealthMonitor(): void {
  if (runtimeHealthTimer) clearInterval(runtimeHealthTimer);
  runtimeHealthTimer = setInterval(() => {
    const now = Date.now();
    for (const [role, record] of runtimeRecords) {
      if (record.stopping || !record.ready) continue;
      const state = runtimeStates.get(role);
      const heartbeatAge = now - (state?.lastHeartbeatAt || now);
      const killThresholdMs = role === "worker" ? 120_000 : 30_000;
      const degradedThresholdMs = role === "worker" ? 30_000 : 15_000;
      const watchdog = evaluateRuntimeWatchdog({
        now,
        lastHeartbeatAt: state?.lastHeartbeatAt || now,
        lastStdoutAt: record.lastStdoutAt,
        lastStderrAt: record.lastStderrAt,
        lastMetricAt: record.lastMetricAt,
        killThresholdMs,
      });
      const diagnostics = () =>
        buildRuntimeWatchdogDiagnostics({
          now,
          lastHeartbeatAt: state?.lastHeartbeatAt,
          lastStdoutAt: record.lastStdoutAt,
          lastStderrAt: record.lastStderrAt,
          lastMetricAt: record.lastMetricAt,
          lastMetric: record.lastMetric,
        });
      if (heartbeatAge > killThresholdMs && !record.healthKillIssued) {
        if (role === "worker" && !watchdog.kill) {
          updateRuntimeState(role, {
            status: "degraded",
            lastError: `heartbeat delayed ${Math.round(heartbeatAge / 1000)}s; recent ${watchdog.lastActivityKind} activity ${Math.round(watchdog.lastActivityAge / 1000)}s ago`,
          });
          if (now - record.lastHealthDiagnosticAt >= 30_000) {
            record.lastHealthDiagnosticAt = now;
            mainLog.warn("Runtime heartbeat timeout deferred because child still has recent activity", {
              event: "runtime.heartbeat-timeout.deferred",
              childRole: role,
              childPid: record.process.pid,
              heartbeatAge,
              killThresholdMs,
              lastActivityKind: watchdog.lastActivityKind,
              lastActivityAge: watchdog.lastActivityAge,
              diagnostics: diagnostics(),
            });
          }
          continue;
        }
        record.healthKillIssued = true;
        updateRuntimeState(role, {
          status: "failed",
          lastError: `heartbeat timed out after ${Math.round(heartbeatAge / 1000)}s`,
        });
        mainLog.error("Runtime heartbeat timed out; terminating child", {
          event: "runtime.heartbeat-timeout",
          childRole: role,
          childPid: record.process.pid,
          heartbeatAge,
          killThresholdMs,
          lastActivityKind: watchdog.lastActivityKind,
          lastActivityAge: watchdog.lastActivityAge,
          diagnostics: diagnostics(),
        });
        record.process.kill();
      } else if (heartbeatAge > degradedThresholdMs && state?.status === "ready") {
        updateRuntimeState(role, {
          status: "degraded",
          lastError: `heartbeat delayed ${Math.round(heartbeatAge / 1000)}s`,
        });
        if (now - record.lastHealthDiagnosticAt >= 30_000) {
          record.lastHealthDiagnosticAt = now;
          mainLog.warn("Runtime heartbeat delayed", {
            event: "runtime.heartbeat-delayed",
            childRole: role,
            childPid: record.process.pid,
            heartbeatAge,
            degradedThresholdMs,
            diagnostics: diagnostics(),
          });
        }
      }
    }
  }, 5_000);
  runtimeHealthTimer.unref();
}

async function startRuntimeProcesses() {
  runtimeShuttingDown = false;
  runtimeBootCompleted = false;
  process.env.PORT = String(RUNTIME_API_PORT);
  delete process.env.TOONFLOW_API_PORT;
  const api = await spawnRuntime("api");
  if (Number(api.port) !== RUNTIME_API_PORT) {
    throw new Error(`API utility process did not bind fixed port ${RUNTIME_API_PORT}`);
  }
  await Promise.all([spawnRuntime("worker"), spawnRuntime("agent")]);
  connectRuntimeChannel("worker");
  connectRuntimeChannel("agent");
  runtimeBootCompleted = true;
  startRuntimeHealthMonitor();
  stopMainMetrics = startRuntimeMetrics("main", (metric: RuntimeMetric) => {
    runtimeRecords.get("api")?.process.postMessage({ type: "runtime:metric", metric });
  });
  publishRuntimeState();
  return RUNTIME_API_PORT;
}

async function stopRuntimeProcesses() {
  runtimeShuttingDown = true;
  runtimeBootCompleted = false;
  if (runtimeHealthTimer) {
    clearInterval(runtimeHealthTimer);
    runtimeHealthTimer = null;
  }
  stopMainMetrics?.();
  stopMainMetrics = undefined;
  const records = [...runtimeRecords.values()];
  const stopped = records.map(
    (record) =>
      new Promise<void>((resolve) => {
        record.stopping = true;
        const timeout = setTimeout(() => {
          record.process.kill();
          resolve();
        }, record.role === "worker" ? 75_000 : 15_000);
        record.process.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        record.process.postMessage({ type: "shutdown" });
      }),
  );
  await Promise.all(stopped);
  runtimeRecords.clear();
  runtimeStates.clear();
  ipcConnectedRoles.clear();
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "toonflow",
    privileges: {
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

let toonflowProtocolRegistered = false;

function registerToonflowProtocolHandlers() {
  if (toonflowProtocolRegistered) return;
  toonflowProtocolRegistered = true;
  protocol.handle("toonflow", async (request) => {
    const url = new URL(request.url);
    const pathname = url.hostname.toLowerCase();
    const handlers: Record<string, () => object | Promise<object>> = {
      getappurl: () => ({ url: RUNTIME_API_URL }),
      "retry-startup": () => {
        if (startupInProgress) {
          return { ok: false, started: false, status: "failed", reason: "已有一次启动修复正在执行，本次不会重复启动。" };
        }
        void bootstrapApplication();
        return { ok: true, started: true, status: "started", repaired: true };
      },
      retryvite: () => {
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.destroy();
            mainWindow = null;
          }
          void createMainWindow();
        }, 0);
        return { ok: true };
      },
      windowminimize: () => {
        mainWindow?.minimize();
        return { ok: true };
      },
      windowmaximize: () => {
        if (mainWindow?.isMaximized()) {
          mainWindow.unmaximize();
        } else {
          mainWindow?.maximize();
        }
        return { ok: true };
      },
      windowclose: () => {
        app.exit(0);
        return { ok: true };
      },
      apprestart: () => {
        setTimeout(() => {
          app.relaunch();
          app.exit(0);
        }, 500);
        return { ok: true, message: "应用即将重启" };
      },
      windowismaximized: () => ({
        maximized: mainWindow?.isMaximized() ?? false,
      }),
      opendevtool: () => {
        mainWindow?.webContents.openDevTools();
        return { ok: true };
      },
      openurlwithbrowser: () => {
        const search = url.searchParams;
        const targetUrl = search.get("url");
        if (targetUrl) {
          const { shell } = require("electron");
          shell.openExternal(targetUrl);
          return { ok: true };
        }
        return { ok: false, error: "缺少 url 参数" };
      },
      selectdirectory: () => {
        const purpose = url.searchParams.get("purpose");
        const result = selectDirectory({
          title: purpose === "projectImport" ? "Select Toonflow project directory" : "Select Toonflow workspace directory",
          properties: ["openDirectory", "createDirectory"],
        });
        return { ok: Boolean(result?.[0]), path: result?.[0] || null, purpose };
      },
      opendirectory: async () => {
        const requestedPath = url.searchParams.get("path");
        if (!requestedPath) return { ok: false, error: "Missing path" };
        const storageConfig = activeStorageConfig;
        if (!storageConfig) return { ok: false, error: "Storage runtime is not ready" };
        const target = path.resolve(requestedPath);
        const roots = [path.resolve(storageConfig.workspacePath), path.resolve(app.getPath("userData"))];
        const allowed = roots.some(
          (root) => target === root || target.startsWith(`${root}${path.sep}`),
        );
        if (!allowed || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
          return { ok: false, error: "Directory is outside Toonflow managed storage" };
        }
        const { shell } = require("electron");
        const openError = await shell.openPath(target);
        return openError ? { ok: false, error: openError } : { ok: true, path: target };
      },
      getlocallanguage: () => {
        if (process.platform === "darwin") {
          const systemLocale = systemPreferences.getUserDefault("AppleLocale", "string");
          return { ok: true, local: systemLocale };
        }
        const appLocale = app.getLocale();
        return { ok: true, local: appLocale };
      },
    };

    const handler = handlers[pathname];
    const responseData = handler ? await handler() : { error: "未知接口" };
    return new Response(JSON.stringify(responseData), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  });
}

async function bootstrapApplication() {
  if (startupInProgress) return;
  startupInProgress = true;
  await showLoading();
  try {
    const storageConfig = resolveStorageRuntime();
    activeStorageConfig = storageConfig;
    applyStorageEnvironment(storageConfig);
    if (storageConfig.mode === "workspace") {
      fs.mkdirSync(storageConfig.workspacePath, { recursive: true });
      acquireWorkspaceLock(storageConfig);
      const manifestPath = path.join(storageConfig.workspacePath, "workspace.json");
      if (!fs.existsSync(manifestPath)) {
        fs.writeFileSync(
          manifestPath,
          JSON.stringify({ version: 1, createdAt: Date.now() }, null, 2),
          "utf8",
        );
      }
    }
    if (app.isPackaged) {
      // 生产环境：让出主线程一次，确保 loading 窗口渲染后再做耗时文件拷贝
      await new Promise((r) => setTimeout(r, 0));
      initializeData();
    } else {
      process.env.NODE_ENV = "dev";
      initializeData();
    }
    repairRuntimeApiPort(RUNTIME_API_PORT);
    await startRuntimeProcesses();
    await new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        resolve();
      }, 2000);
    });
    // 服务启动成功，创建主窗口（主窗口 ready-to-show 时自动关闭 loading）
    await createMainWindow();
  } catch (err) {
    console.error("[runtime startup failed]:", err);
    await stopRuntimeProcesses().catch(() => {});
    showStartupError(err);
  } finally {
    startupInProgress = false;
  }
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  const migratedUserDataEntries = migrateLegacyElectronUserData();
  initLogger({ role: "main", logDir: path.join(app.getPath("userData"), "logs"), hijackConsole: true });
  mainLog.info("Electron main process ready", {
    event: "ready",
    appName: APP_NAME,
    userData: app.getPath("userData"),
    migratedUserDataEntries,
  });
  registerToonflowProtocolHandlers();
  await bootstrapApplication();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

let shutdownStarted = false;
app.on("before-quit", (event) => {
  if (shutdownStarted) return;
  if (runtimeRecords.size === 0) {
    releaseWorkspaceLock();
    return;
  }
  event.preventDefault();
  shutdownStarted = true;
  void stopRuntimeProcesses()
    .catch((error) => {
      console.error("[服务关闭失败]:", error);
    })
    .finally(() => {
      releaseWorkspaceLock();
      app.exit(0);
    });
});
