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
import { startRuntimeMetrics, type RuntimeMetric } from "../src/runtime/runtimeMetrics";
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

// 鍔犻€?Electron 鍚姩锛氳烦杩?GPU 淇℃伅鏀堕泦锛屽噺灏戝垵濮嬪寲鑰楁椂
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

const SYSTEM_ENTRIES = new Set(["assets", "models", "serve", "web"]);
const USER_ENTRIES = new Set(["skills", "vendor", "modelPrompt"]);
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
    if (shouldForceReplace) {
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

//鑾峰彇鍏ㄩ儴渚濊禆璺緞锛屼紭鍏堜粠 unpacked 鍔犺浇鍘熺敓妯″潡锛屽叾浠栨ā鍧椾粠 asar 鍔犺浇
let mainWindow: BrowserWindow | null = null;
let loadingWindow: BrowserWindow | null = null;
let workspaceLockPath: string | null = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireWorkspaceLock(config: RuntimeStorageConfig) {
  if (config.mode !== "workspace") return;
  fs.mkdirSync(config.workspacePath, { recursive: true });
  const lockPath = path.join(config.workspacePath, ".toonflow.lock");
  if (fs.existsSync(lockPath)) {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number };
      if (current.pid && current.pid !== process.pid && processIsAlive(current.pid)) {
        throw new Error(`Workspace is already in use by process ${current.pid}: ${config.workspacePath}`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.warn("[ToonFlow] replacing an invalid workspace lock");
      } else {
        throw error;
      }
    }
    fs.rmSync(lockPath, { force: true });
  }
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), workspacePath: config.workspacePath }, null, 2),
    { encoding: "utf8", flag: "wx" },
  );
  workspaceLockPath = lockPath;
}

function releaseWorkspaceLock() {
  if (!workspaceLockPath) return;
  try {
    const current = JSON.parse(fs.readFileSync(workspaceLockPath, "utf8")) as { pid?: number };
    if (current.pid === process.pid) fs.rmSync(workspaceLockPath, { force: true });
  } catch {
    // A missing or replaced lock is no longer owned by this process.
  }
  workspaceLockPath = null;
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
</style></head><body><div class="spinner"></div><p>姝ｅ湪鍚姩鏈嶅姟鈥?/p></body></html>`)}`;

function showLoading(): void {
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
  void loadingWindow.loadURL(loadingHtml);
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
  updateLoadingMessage("鍓嶇鏈嶅姟姝ｅ湪鍚姩...");
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
</style></head><body><div class="panel"><h1>鍓嶇鏈嶅姟灏氭湭灏辩华</h1>
<p>寮€鍙戞湇鍔″櫒 <span class="address">${VITE_DEV_ORIGIN}</span> 褰撳墠鏃犳硶瀹屾暣鍔犺浇銆?/p>
<p>璇风‘璁?Vite 宸插惎鍔ㄣ€傚悗绔繍琛岃繘绋嬩笉浼氬洜姝ゅ仠姝€?/p>
<button id="retry">閲嶆柊妫€娴?/button>
<script>
const button=document.getElementById("retry");
button.addEventListener("click",async()=>{
  button.disabled=true;
  button.textContent="姝ｅ湪妫€娴?..";
  try{await fetch("toonflow://retryvite");}
  catch{button.disabled=false;button.textContent="閲嶆柊妫€娴?;}
});
</script></div></body></html>`)}`;
  if (!loadingWindow || loadingWindow.isDestroyed()) showLoading();
  void loadingWindow?.loadURL(errorHtml);
}

function showStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const errorHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#f5f6f8;color:#202124;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.panel{width:min(640px,calc(100vw - 64px));padding:32px;background:#fff;border:1px solid #ddd;border-radius:8px}
h1{font-size:20px;margin:0 0 16px}p{line-height:1.7;margin:8px 0}.address{font-family:Consolas,monospace}
.error{margin-top:18px;padding:12px;background:#f8f8f8;border-left:3px solid #d93025;white-space:pre-wrap;
word-break:break-word;font-family:Consolas,monospace;font-size:12px}
</style></head><body><div class="panel"><h1>Toonflow API 鍚姩澶辫触</h1>
<p>鍥哄畾鍦板潃 <span class="address">${RUNTIME_API_URL}</span> 褰撳墠涓嶅彲鐢ㄣ€?/p>
<p>璇峰叧闂棫鐨?Toonflow锛屾垨缁撴潫鍗犵敤绔彛 ${RUNTIME_API_PORT} 鐨勭▼搴忓悗閲嶆柊鍚姩銆?/p>
<div class="error">${message.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)}</div>
</div></body></html>`)}`;
  if (!loadingWindow || loadingWindow.isDestroyed()) showLoading();
  void loadingWindow?.loadURL(errorHtml);
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
    return { file: path.join(getSystemDataPath(), "serve", "runtime", file), execArgv: [] as string[], env: {} };
  }
  const file = role === "api" ? "apiProcess.ts" : role === "worker" ? "taskWorker.ts" : "agentProcess.ts";
  return {
    file: path.join(process.cwd(), "scripts", "runtimeBootstrap.cjs"),
    execArgv: [] as string[],
    env: { TOONFLOW_RUNTIME_ENTRY: path.join(process.cwd(), "src", "runtime", file) },
  };
}

function forwardRuntimeOutput(role: RuntimeRole, stream: NodeJS.ReadableStream | null, level: "log" | "error") {
  stream?.on("data", (chunk) => console[level](`[${role}] ${String(chunk).trimEnd()}`));
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
  const childEnv: Record<string, string | undefined> = {
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
      console.error(`[${role}] fatal:`, message.message);
      updateRuntimeState(role, { status: "failed", lastError: String(message.message || "unknown runtime error") });
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
    console.warn(`[runtime] ${role} exited with code ${code}; restarting in ${delays[nextAttempt - 1]}ms`);
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
      if (heartbeatAge > 30_000 && !record.healthKillIssued) {
        record.healthKillIssued = true;
        updateRuntimeState(role, {
          status: "failed",
          lastError: `heartbeat timed out after ${Math.round(heartbeatAge / 1000)}s`,
        });
        console.error(`[runtime] ${role} heartbeat timed out; terminating pid ${record.process.pid}`);
        record.process.kill();
      } else if (heartbeatAge > 15_000 && state?.status === "ready") {
        updateRuntimeState(role, {
          status: "degraded",
          lastError: `heartbeat delayed ${Math.round(heartbeatAge / 1000)}s`,
        });
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

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  // 绔嬪嵆鏄剧ず鍔犺浇绐楀彛锛坉ata URL + backgroundColor锛岀灛闂村彲瑙侊級
  showLoading();

  try {
    const storageConfig = resolveStorageRuntime();
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
      // 鐢熶骇鐜锛氳鍑轰富绾跨▼涓€娆★紝纭繚 loading 绐楀彛娓叉煋鍚庡啀鍋氳€楁椂鏂囦欢鎷疯礉
      await new Promise((r) => setTimeout(r, 0));
      initializeData();
    } else {
      process.env.NODE_ENV = "dev";
      initializeData();
    }
    await startRuntimeProcesses();
    await new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        resolve();
      }, 2000);
    });
    // 娉ㄥ唽鍗忚澶勭悊鍣?
    protocol.handle("toonflow", async (request) => {
      const url = new URL(request.url);
      const pathname = url.hostname.toLowerCase();
      const handlers: Record<string, () => object | Promise<object>> = {
        getappurl: () => ({ url: RUNTIME_API_URL }),
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
          // 寤惰繜鎵ц锛岃鍝嶅簲鍏堣繑鍥炵粰鍓嶇
          setTimeout(() => {
            app.relaunch();
            app.exit(0);
          }, 500);
          return { ok: true, message: "搴旂敤鍗冲皢閲嶅惎" };
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
          } else {
            return { ok: false, error: "缂哄皯url鍙傛暟" };
          }
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
          // 鑾峰彇搴旂敤鍖哄煙璁剧疆

          // macOS绯荤粺鐗瑰畾鏂规硶
          if (process.platform === "darwin") {
            const systemLocale = systemPreferences.getUserDefault("AppleLocale", "string");
            return { ok: true, local: systemLocale };
          }
          const appLocale = app.getLocale();
          return { ok: true, local: appLocale };
        },
      };

      const handler = handlers[pathname];

      const responseData = handler ? await handler() : { error: "鏈煡鎺ュ彛" };
      return new Response(JSON.stringify(responseData), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    });

    // 鏈嶅姟鍚姩鎴愬姛锛屽垱寤轰富绐楀彛锛堜富绐楀彛 ready-to-show 鏃惰嚜鍔ㄥ叧闂璴oading锛?
    await createMainWindow();
  } catch (err) {
    console.error("[runtime startup failed]:", err);
    await stopRuntimeProcesses().catch(() => {});
    showStartupError(err);
  }
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
      console.error("[鏈嶅姟鍏抽棴澶辫触]:", error);
    })
    .finally(() => {
      releaseWorkspaceLock();
      app.exit(0);
    });
});
