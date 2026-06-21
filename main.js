"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// scripts/main.ts
var import_electron = require("electron");
var import_path = __toESM(require("path"));
var import_fs = __toESM(require("fs"));

// src/runtime/runtimeMetrics.ts
var import_node_perf_hooks = require("node:perf_hooks");
function startRuntimeMetrics(role, publish) {
  const histogram = (0, import_node_perf_hooks.monitorEventLoopDelay)({ resolution: 20 });
  histogram.enable();
  let previousCpu = process.cpuUsage();
  let previousElu = import_node_perf_hooks.performance.eventLoopUtilization();
  const collect = () => {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage(previousCpu);
    previousCpu = process.cpuUsage();
    const elu = import_node_perf_hooks.performance.eventLoopUtilization(previousElu);
    previousElu = import_node_perf_hooks.performance.eventLoopUtilization();
    const metric = {
      role,
      pid: process.pid,
      timestamp: Date.now(),
      uptimeSec: Math.round(process.uptime()),
      eventLoopDelayP95Ms: Number((histogram.percentile(95) / 1e6).toFixed(2)),
      eventLoopDelayMaxMs: Number((histogram.max / 1e6).toFixed(2)),
      eventLoopUtilization: Number(elu.utilization.toFixed(4)),
      cpuUserMs: Number((cpu.user / 1e3).toFixed(2)),
      cpuSystemMs: Number((cpu.system / 1e3).toFixed(2)),
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      external: memory.external
    };
    histogram.reset();
    publish(metric);
  };
  collect();
  const timer = setInterval(collect, 5e3);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}

// src/runtime/runtimeProtocol.ts
var RUNTIME_API_HOST = "127.0.0.1";
var RUNTIME_API_PORT = 10588;
var RUNTIME_API_URL = `http://${RUNTIME_API_HOST}:${RUNTIME_API_PORT}/api`;

// src/services/storagePaths.ts
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
function absolute(value, fallback) {
  return import_node_path.default.resolve(value?.trim() || fallback);
}
function appDataRoot() {
  return absolute(process.env.TOONFLOW_APP_DATA_DIR, import_node_path.default.join(process.cwd(), "data"));
}
function runtimeConfigPath(root = appDataRoot()) {
  return import_node_path.default.join(root, "runtime.json");
}
function readRuntimeStorageConfig(root = appDataRoot()) {
  const file = runtimeConfigPath(root);
  if (!import_node_fs.default.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(import_node_fs.default.readFileSync(file, "utf8"));
    if (parsed?.version !== 1 || !parsed.workspacePath || !["legacy", "workspace"].includes(parsed.mode)) return null;
    return { ...parsed, workspacePath: import_node_path.default.resolve(parsed.workspacePath) };
  } catch {
    return null;
  }
}
function writeRuntimeStorageConfig(config, root = appDataRoot()) {
  import_node_fs.default.mkdirSync(root, { recursive: true });
  const target = runtimeConfigPath(root);
  const temp = `${target}.tmp`;
  import_node_fs.default.writeFileSync(temp, JSON.stringify(config, null, 2), "utf8");
  import_node_fs.default.renameSync(temp, target);
}

// src/logger.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
var DEFAULT_RETENTION_DAYS = 7;
var MAX_FIELD_BYTES = 8 * 1024;
var MAX_LINE_BYTES = 64 * 1024;
var SENSITIVE_KEYS = /authorization|cookie|token|secret|password|credential|api[_-]?key|access[_-]?key|refresh[_-]?token/i;
var BASE64_PATTERN = /data:[^;]+;base64,[A-Za-z0-9+/=\r\n]+/gi;
var ANSI_PATTERN = /\x1B\[[0-9;]*m/g;
var currentRole = process.env.TOONFLOW_RUNTIME_ROLE || "script";
var rootLogDir = import_node_path2.default.join(appDataRoot(), "logs");
var retentionDays = DEFAULT_RETENTION_DAYS;
var initialized = false;
var hijacked = false;
var writeStreams = /* @__PURE__ */ new Map();
var originalConsole = {};
var originalStdoutWrite = null;
var originalStderrWrite = null;
var writingRaw = false;
function dateKey(time = Date.now()) {
  return new Date(time).toISOString().slice(0, 10);
}
function ensureDir(dir) {
  import_node_fs2.default.mkdirSync(dir, { recursive: true });
}
function streamKey(role, channel) {
  return `${dateKey()}:${role}:${channel}`;
}
function logFilePath(role, channel = role) {
  return import_node_path2.default.join(rootLogDir, dateKey(), `${channel}.jsonl`);
}
function getStream(role, channel = role) {
  const key = streamKey(role, channel);
  const existing = writeStreams.get(key);
  if (existing && !existing.destroyed) return existing;
  const file = logFilePath(role, channel);
  ensureDir(import_node_path2.default.dirname(file));
  const stream = import_node_fs2.default.createWriteStream(file, { flags: "a", encoding: "utf8" });
  writeStreams.set(key, stream);
  return stream;
}
function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}
function stringifyError(error) {
  if (!error) return void 0;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return sanitizeValue(error, 0);
}
function truncateString(value, maxBytes = MAX_FIELD_BYTES) {
  const clean = value.replace(BASE64_PATTERN, "[base64 omitted]");
  if (byteLength(clean) <= maxBytes) return clean;
  let size = 0;
  let output = "";
  for (const char of clean) {
    const next = byteLength(char);
    if (size + next > maxBytes) break;
    output += char;
    size += next;
  }
  return `${output}...[truncated ${byteLength(clean) - size} bytes]`;
}
function sanitizeValue(value, depth = 0) {
  if (depth > 5) return "[max depth]";
  if (value == null) return value;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return stringifyError(value);
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      output[key] = SENSITIVE_KEYS.test(key) ? "[redacted]" : sanitizeValue(item, depth + 1);
    }
    return output;
  }
  return String(value);
}
function compactLine(entry) {
  let line = `${JSON.stringify(entry)}
`;
  if (byteLength(line) <= MAX_LINE_BYTES) return { line };
  const diagnosticFile = writeDiagnosticFile("oversize-log-entry", JSON.stringify(entry, null, 2));
  const compact = {
    time: entry.time,
    level: entry.level,
    role: entry.role,
    pid: entry.pid,
    module: entry.module,
    event: entry.event,
    message: truncateString(String(entry.message || "oversize log entry"), 2048),
    diagnosticFile
  };
  line = `${JSON.stringify(compact)}
`;
  return { line, diagnosticFile };
}
function consoleMethod(level) {
  if (level === "error") return "error";
  if (level === "warn") return "warn";
  if (level === "debug") return "debug";
  return "info";
}
function formatConsole(level, entry) {
  const moduleName = entry.module ? `[${entry.module}]` : "";
  const eventName = entry.event ? ` ${entry.event}` : "";
  const message = entry.message ? ` ${entry.message}` : "";
  return `[${entry.role}] [${level}]${moduleName}${eventName}${message}`;
}
function writeLog(level, message, context = {}) {
  if (!initialized) initLogger();
  const role = context.role || currentRole;
  const channel = context.module === "video-queue" ? "video-queue" : role;
  const entry = {
    time: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    role,
    pid: process.pid,
    module: context.module || "app",
    event: context.event || "log",
    message: truncateString(message)
  };
  for (const [key, value] of Object.entries(context)) {
    if (["role", "module", "event", "error"].includes(key)) continue;
    entry[key] = SENSITIVE_KEYS.test(key) ? "[redacted]" : sanitizeValue(value);
  }
  if (context.error) entry.error = stringifyError(context.error);
  const { line, diagnosticFile } = compactLine(entry);
  if (diagnosticFile) entry.diagnosticFile = diagnosticFile;
  getStream(role, channel).write(line);
  const original = originalConsole[consoleMethod(level)];
  if (original) {
    writingRaw = true;
    try {
      original(formatConsole(level, entry));
    } finally {
      writingRaw = false;
    }
  }
}
function createLogger(moduleName, defaults = {}) {
  const write = (level, message, context = {}) => writeLog(level, message, { ...defaults, ...context, module: context.module || defaults.module || moduleName });
  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context)
  };
}
function writeRaw(level, chunk) {
  if (writingRaw) return;
  const value = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
  const text = value.replace(ANSI_PATTERN, "").trim();
  if (!text) return;
  writingRaw = true;
  try {
    writeLog(level, text, { module: "stdout", event: level === "error" ? "stderr" : "stdout" });
  } finally {
    writingRaw = false;
  }
}
function hijackConsole() {
  if (hijacked) return;
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[method] = console[method].bind(console);
    console[method] = (...args) => {
      const level = method === "log" ? "info" : method;
      writeLog(level, args.map((item) => typeof item === "string" ? item : JSON.stringify(sanitizeValue(item))).join(" "), {
        module: "console",
        event: method
      });
    };
  }
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk, ...rest) => {
    writeRaw("info", chunk);
    return originalStdoutWrite(chunk, ...rest);
  });
  process.stderr.write = ((chunk, ...rest) => {
    writeRaw("error", chunk);
    return originalStderrWrite(chunk, ...rest);
  });
  hijacked = true;
}
function initLogger(options = {}) {
  currentRole = options.role || process.env.TOONFLOW_RUNTIME_ROLE || currentRole;
  rootLogDir = options.logDir || import_node_path2.default.join(appDataRoot(), "logs");
  retentionDays = options.retentionDays || DEFAULT_RETENTION_DAYS;
  ensureDir(rootLogDir);
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    if (!originalConsole[method]) originalConsole[method] = console[method].bind(console);
  }
  if (options.hijackConsole) hijackConsole();
  initialized = true;
  return logger;
}
function closeLogger() {
  for (const stream of writeStreams.values()) stream.end();
  writeStreams.clear();
  if (hijacked) {
    for (const method of ["log", "info", "warn", "error", "debug"]) {
      const original = originalConsole[method];
      if (original) console[method] = original;
    }
    if (originalStdoutWrite) process.stdout.write = originalStdoutWrite;
    if (originalStderrWrite) process.stderr.write = originalStderrWrite;
    originalConsole = {};
    originalStdoutWrite = null;
    originalStderrWrite = null;
    hijacked = false;
  }
  initialized = false;
}
function writeDiagnosticFile(name, content, context = {}) {
  if (!initialized) initLogger();
  const provider = context.provider || "app";
  const safeName = name.replace(/[^\w.-]+/g, "_").slice(0, 80) || "diagnostic";
  const fileName = `${Date.now()}-${safeName}.log`;
  const file = import_node_path2.default.join(rootLogDir, "provider", String(provider), dateKey(), fileName);
  ensureDir(import_node_path2.default.dirname(file));
  import_node_fs2.default.writeFileSync(file, content, typeof content === "string" ? "utf8" : void 0);
  return file;
}
function walkFiles(dir) {
  if (!import_node_fs2.default.existsSync(dir)) return [];
  const files = [];
  const walk = (current) => {
    for (const entry of import_node_fs2.default.readdirSync(current, { withFileTypes: true })) {
      const file = import_node_path2.default.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile()) {
        const stat = import_node_fs2.default.statSync(file);
        files.push({ path: file, relativePath: import_node_path2.default.relative(dir, file), size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  walk(dir);
  return files;
}
function readRecentErrors(files) {
  const errors = [];
  for (const file of files.filter((item) => item.path.endsWith(".jsonl")).sort((a, b) => b.path.localeCompare(a.path))) {
    if (errors.length >= 50) break;
    try {
      const lines = import_node_fs2.default.readFileSync(file.path, "utf8").trim().split(/\r?\n/).slice(-300);
      for (const line of lines.reverse()) {
        if (errors.length >= 50) break;
        const parsed = JSON.parse(line);
        if (parsed.level === "error" || parsed.level === "warn") {
          errors.push({
            time: parsed.time,
            level: parsed.level,
            role: parsed.role,
            module: parsed.module,
            event: parsed.event,
            message: parsed.message,
            file: file.relativePath
          });
        }
      }
    } catch {
    }
  }
  return errors;
}
function getLoggerStatus() {
  if (!initialized) initLogger();
  const files = walkFiles(rootLogDir);
  const totalSize = files.reduce((sum, item) => sum + item.size, 0);
  const lastLogAtByRole = {};
  for (const file of files) {
    const name = import_node_path2.default.basename(file.path, ".jsonl");
    if (!lastLogAtByRole[name] || lastLogAtByRole[name] < file.mtimeMs) lastLogAtByRole[name] = file.mtimeMs;
  }
  return {
    logDir: rootLogDir,
    retentionDays,
    currentRole,
    files,
    totalSize,
    recentErrors: readRecentErrors(files),
    lastLogAtByRole
  };
}
function cleanupLogs(days = retentionDays) {
  if (!initialized) initLogger();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1e3;
  let removedFiles = 0;
  let removedBytes = 0;
  for (const file of walkFiles(rootLogDir)) {
    if (file.mtimeMs >= cutoff) continue;
    try {
      import_node_fs2.default.rmSync(file.path, { force: true });
      removedFiles += 1;
      removedBytes += file.size;
    } catch {
    }
  }
  pruneEmptyDirs(rootLogDir);
  return { removedFiles, removedBytes, cutoff };
}
function pruneEmptyDirs(dir) {
  if (!import_node_fs2.default.existsSync(dir)) return;
  for (const entry of import_node_fs2.default.readdirSync(dir, { withFileTypes: true })) {
    const child = import_node_path2.default.join(dir, entry.name);
    if (entry.isDirectory()) pruneEmptyDirs(child);
  }
  if (dir !== rootLogDir && import_node_fs2.default.existsSync(dir) && import_node_fs2.default.readdirSync(dir).length === 0) {
    try {
      import_node_fs2.default.rmdirSync(dir);
    } catch {
    }
  }
}
var logger = {
  init: initLogger,
  close: closeLogger,
  create: createLogger,
  diagnostic: writeDiagnosticFile,
  status: getLoggerStatus,
  cleanup: cleanupLogs,
  debug: (message, context) => writeLog("debug", message, context),
  info: (message, context) => writeLog("info", message, context),
  warn: (message, context) => writeLog("warn", message, context),
  error: (message, context) => writeLog("error", message, context)
};

// scripts/main.ts
var APP_NAME = "ToonFlow";
var mainLog = createLogger("runtime-main");
import_electron.app.setName(APP_NAME);
if (process.platform === "win32") import_electron.app.setAppUserModelId("net.toonflow.www");
import_electron.app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
import_electron.app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
var SYSTEM_ENTRIES = /* @__PURE__ */ new Set(["assets", "models", "serve", "web", "skills", "modelPrompt"]);
var USER_ENTRIES = /* @__PURE__ */ new Set(["vendor"]);
var VITE_DEV_ORIGIN = "http://127.0.0.1:50188";
var VITE_READY_TIMEOUT_MS = 3e4;
var VITE_READY_INTERVAL_MS = 300;
var VITE_READINESS_PATHS = ["/", "/@vite/client", "/src/pages/workbench/index.vue"];
function copyDir(src, dest) {
  if (!import_fs.default.existsSync(src)) return;
  import_fs.default.mkdirSync(dest, { recursive: true });
  for (const entry of import_fs.default.readdirSync(src, { withFileTypes: true })) {
    const s = import_path.default.join(src, entry.name);
    const d = import_path.default.join(dest, entry.name);
    entry.isDirectory() ? copyDir(s, d) : import_fs.default.existsSync(d) || import_fs.default.copyFileSync(s, d);
  }
}
function copyUserDataEntryIfMissing(srcRoot, destRoot, entryName) {
  const src = import_path.default.join(srcRoot, entryName);
  const dest = import_path.default.join(destRoot, entryName);
  if (!import_fs.default.existsSync(src) || import_fs.default.existsSync(dest)) return false;
  const stat = import_fs.default.statSync(src);
  import_fs.default.mkdirSync(import_path.default.dirname(dest), { recursive: true });
  if (stat.isDirectory()) copyDir(src, dest);
  else if (stat.isFile()) import_fs.default.copyFileSync(src, dest);
  return true;
}
function migrateLegacyElectronUserData() {
  const currentRoot = import_electron.app.getPath("userData");
  const legacyRoot = import_path.default.join(import_electron.app.getPath("appData"), "Electron");
  if (import_path.default.resolve(currentRoot) === import_path.default.resolve(legacyRoot)) return [];
  if (import_fs.default.existsSync(import_path.default.join(currentRoot, "runtime.json"))) return [];
  const legacyConfig = readRuntimeStorageConfig(legacyRoot);
  if (!legacyConfig) return [];
  const copied = [];
  for (const entry of ["runtime.json", "profile.sqlite", "user", "system", "logs"]) {
    if (copyUserDataEntryIfMissing(legacyRoot, currentRoot, entry)) copied.push(entry);
  }
  return copied;
}
function isDirectoryEmpty(dir) {
  try {
    return import_fs.default.existsSync(dir) && import_fs.default.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}
function getAppVersion() {
  if (true) return "2.0.0";
  try {
    const pkgPath = import_path.default.join(process.cwd(), "package.json");
    const pkg = JSON.parse(import_fs.default.readFileSync(pkgPath, "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
function compareVersions(a, b) {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10)).filter((n) => Number.isFinite(n));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10)).filter((n) => Number.isFinite(n));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}
function getOverrideDataPath() {
  const dataDir = process.env.TOONFLOW_DATA_DIR?.trim();
  if (dataDir) return import_path.default.resolve(dataDir);
  const workDir = process.env.TOONFLOW_WORK_DIR?.trim();
  if (workDir) return import_path.default.resolve(workDir, "data");
  const configPath = import_path.default.resolve(process.cwd(), "toonflow.local.json");
  if (import_fs.default.existsSync(configPath)) {
    try {
      const localConfig = JSON.parse(import_fs.default.readFileSync(configPath, "utf-8"));
      if (localConfig.dataDir?.trim()) return import_path.default.resolve(localConfig.dataDir);
      if (localConfig.workDir?.trim()) return import_path.default.resolve(localConfig.workDir, "data");
    } catch (err) {
      console.warn("[ToonFlow] failed to read toonflow.local.json:", err);
    }
  }
  return null;
}
function resolveStorageRuntime() {
  const appRoot = import_electron.app.getPath("userData");
  const saved = readRuntimeStorageConfig(appRoot);
  if (saved) return activatePendingProfile(saved);
  const configuredLegacy = getOverrideDataPath();
  const defaultLegacy = import_path.default.join(appRoot, "data");
  const legacyPath = configuredLegacy && import_fs.default.existsSync(import_path.default.join(configuredLegacy, "db2.sqlite")) ? configuredLegacy : import_fs.default.existsSync(import_path.default.join(defaultLegacy, "db2.sqlite")) ? defaultLegacy : null;
  const config = legacyPath ? {
    version: 1,
    mode: "legacy",
    workspacePath: legacyPath,
    legacyDataPath: legacyPath,
    updatedAt: Date.now()
  } : {
    version: 1,
    mode: "workspace",
    workspacePath: import_path.default.join(import_electron.app.getPath("documents"), "Toonflow Workspace"),
    selectionRequired: true,
    updatedAt: Date.now()
  };
  writeRuntimeStorageConfig(config, appRoot);
  return config;
}
function activatePendingProfile(config) {
  if (!config.pendingProfilePath || !import_fs.default.existsSync(config.pendingProfilePath)) return config;
  const appRoot = import_electron.app.getPath("userData");
  const profilePath = import_path.default.join(appRoot, "profile.sqlite");
  const backupPath = import_path.default.join(appRoot, `profile-before-migration-${Date.now()}.sqlite`);
  try {
    if (import_fs.default.existsSync(profilePath)) import_fs.default.renameSync(profilePath, backupPath);
    import_fs.default.renameSync(config.pendingProfilePath, profilePath);
    const activated = { ...config };
    delete activated.pendingProfilePath;
    activated.updatedAt = Date.now();
    writeRuntimeStorageConfig(activated, appRoot);
    return activated;
  } catch (error) {
    if (!import_fs.default.existsSync(profilePath) && import_fs.default.existsSync(backupPath)) import_fs.default.renameSync(backupPath, profilePath);
    throw error;
  }
}
function applyStorageEnvironment(config) {
  const appRoot = import_electron.app.getPath("userData");
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
function getSystemDataPath() {
  return import_path.default.join(import_electron.app.getPath("userData"), "system");
}
function initializeData() {
  const srcDir = import_path.default.resolve(import_electron.app.isPackaged ? import_path.default.join(process.resourcesPath, "data") : import_path.default.join(process.cwd(), "data"));
  const systemDir = import_path.default.resolve(getSystemDataPath());
  const userDir = import_path.default.resolve(import_electron.app.getPath("userData"), "user");
  console.log("[ToonFlow] system data dir:", systemDir);
  const versionFilePath = import_path.default.join(systemDir, "version.txt");
  const appVersion = getAppVersion();
  let shouldForceReplace = false;
  if (!import_fs.default.existsSync(versionFilePath)) {
    shouldForceReplace = true;
  } else {
    const localVersion = import_fs.default.readFileSync(versionFilePath, "utf-8").trim();
    if (compareVersions(localVersion, appVersion) < 0) {
      shouldForceReplace = true;
    }
  }
  for (const dir of SYSTEM_ENTRIES) {
    const targetDir = import_path.default.join(systemDir, dir);
    if (shouldForceReplace) {
      import_fs.default.rmSync(targetDir, { recursive: true, force: true });
      copyDir(import_path.default.join(srcDir, dir), targetDir);
      continue;
    }
    if (!import_fs.default.existsSync(targetDir)) {
      copyDir(import_path.default.join(srcDir, dir), targetDir);
    } else if (isDirectoryEmpty(targetDir)) {
      copyDir(import_path.default.join(srcDir, dir), targetDir);
    }
  }
  for (const dir of USER_ENTRIES) {
    const targetDir = import_path.default.join(userDir, dir);
    if (!import_fs.default.existsSync(targetDir) || isDirectoryEmpty(targetDir)) copyDir(import_path.default.join(srcDir, dir), targetDir);
  }
  if (shouldForceReplace) {
    import_fs.default.mkdirSync(systemDir, { recursive: true });
    import_fs.default.writeFileSync(versionFilePath, `${appVersion}
`, "utf-8");
  }
}
var mainWindow = null;
var loadingWindow = null;
var workspaceLockPath = null;
var hasSingleInstanceLock = import_electron.app.requestSingleInstanceLock();
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function acquireWorkspaceLock(config) {
  if (config.mode !== "workspace") return;
  import_fs.default.mkdirSync(config.workspacePath, { recursive: true });
  const lockPath = import_path.default.join(config.workspacePath, ".toonflow.lock");
  if (import_fs.default.existsSync(lockPath)) {
    try {
      const current = JSON.parse(import_fs.default.readFileSync(lockPath, "utf8"));
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
    import_fs.default.rmSync(lockPath, { force: true });
  }
  import_fs.default.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), workspacePath: config.workspacePath }, null, 2),
    { encoding: "utf8", flag: "wx" }
  );
  workspaceLockPath = lockPath;
}
function releaseWorkspaceLock() {
  if (!workspaceLockPath) return;
  try {
    const current = JSON.parse(import_fs.default.readFileSync(workspaceLockPath, "utf8"));
    if (current.pid === process.pid) import_fs.default.rmSync(workspaceLockPath, { force: true });
  } catch {
  }
  workspaceLockPath = null;
}
if (!hasSingleInstanceLock) {
  console.warn("[ToonFlow] another application instance is already running, exiting");
  import_electron.app.quit();
}
import_electron.app.on("second-instance", () => {
  const window = mainWindow || loadingWindow;
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});
var loadingHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
  background:#fff;color:#333;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  user-select:none;-webkit-app-region:drag}
.spinner{width:48px;height:48px;border:4px solid rgba(0,0,0,.1);
  border-top-color:#000;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
p{margin-top:20px;font-size:14px;opacity:.6}
</style></head><body><div class="spinner"></div><p>\u6B63\u5728\u542F\u52A8\u670D\u52A1...</p></body></html>`)}`;
function showLoading() {
  loadingWindow = new import_electron.BrowserWindow({
    width: 1e3,
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
      height: 36
    }
  });
  loadingWindow.setMenuBarVisibility(false);
  loadingWindow.removeMenu();
  loadingWindow.on("closed", () => {
    loadingWindow = null;
  });
  void loadingWindow.loadURL(loadingHtml);
}
function closeLoading() {
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.close();
    loadingWindow = null;
  }
}
function selectDirectory(options) {
  const owner = mainWindow || loadingWindow;
  return owner ? import_electron.dialog.showOpenDialogSync(owner, options) : import_electron.dialog.showOpenDialogSync(options);
}
function updateLoadingMessage(message) {
  if (!loadingWindow || loadingWindow.isDestroyed()) return;
  void loadingWindow.webContents.executeJavaScript(
    `document.querySelector("p") && (document.querySelector("p").textContent = ${JSON.stringify(message)})`
  );
}
async function isViteReady() {
  const checks = await Promise.all(
    VITE_READINESS_PATHS.map(async (pathname) => {
      try {
        const response = await fetch(`${VITE_DEV_ORIGIN}${pathname}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(2e3)
        });
        return { pathname, ok: response.ok, status: response.status };
      } catch (error) {
        return { pathname, ok: false, error };
      }
    })
  );
  const failed = checks.filter((check) => !check.ok);
  if (failed.length) {
    console.warn(
      "[vite-ready] waiting for dev server:",
      failed.map(
        (check) => "status" in check ? `${check.pathname} -> HTTP ${check.status}` : `${check.pathname} -> ${check.error instanceof Error ? check.error.message : String(check.error)}`
      ).join("; ")
    );
    return false;
  }
  return true;
}
async function waitForViteReady(timeoutMs = VITE_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  updateLoadingMessage("\u524D\u7AEF\u670D\u52A1\u6B63\u5728\u542F\u52A8...");
  while (Date.now() < deadline) {
    if (await isViteReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, VITE_READY_INTERVAL_MS));
  }
  return false;
}
function showViteStartupError() {
  const errorHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#f5f6f8;color:#202124;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.panel{width:min(640px,calc(100vw - 64px));padding:32px;background:#fff;border:1px solid #ddd;border-radius:8px}
h1{font-size:20px;margin:0 0 16px}p{line-height:1.7;margin:8px 0}.address{font-family:Consolas,monospace}
button{margin-top:20px;padding:9px 18px;border:0;border-radius:4px;background:#0052d9;color:#fff;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}
</style></head><body><div class="panel"><h1>\u524D\u7AEF\u670D\u52A1\u5C1A\u672A\u5C31\u7EEA</h1>
<p>\u5F00\u53D1\u670D\u52A1\u5668 <span class="address">${VITE_DEV_ORIGIN}</span> \u5F53\u524D\u65E0\u6CD5\u5B8C\u6574\u52A0\u8F7D\u3002</p>
<p>\u8BF7\u786E\u8BA4 Vite \u5DF2\u542F\u52A8\u3002\u540E\u7AEF\u8FD0\u884C\u8FDB\u7A0B\u4E0D\u4F1A\u56E0\u6B64\u505C\u6B62\u3002</p>
<button id="retry">\u91CD\u65B0\u68C0\u6D4B</button>
<script>
const button=document.getElementById("retry");
button.addEventListener("click",async()=>{
  button.disabled=true;
  button.textContent="\u6B63\u5728\u68C0\u6D4B...";
  try{await fetch("toonflow://retryvite");}
  catch{button.disabled=false;button.textContent="\u91CD\u65B0\u68C0\u6D4B";}
});
</script></div></body></html>`)}`;
  if (!loadingWindow || loadingWindow.isDestroyed()) showLoading();
  void loadingWindow?.loadURL(errorHtml);
}
function showStartupError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const errorHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#f5f6f8;color:#202124;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.panel{width:min(640px,calc(100vw - 64px));padding:32px;background:#fff;border:1px solid #ddd;border-radius:8px}
h1{font-size:20px;margin:0 0 16px}p{line-height:1.7;margin:8px 0}.address{font-family:Consolas,monospace}
.error{margin-top:18px;padding:12px;background:#f8f8f8;border-left:3px solid #d93025;white-space:pre-wrap;
word-break:break-word;font-family:Consolas,monospace;font-size:12px}
</style></head><body><div class="panel"><h1>Toonflow API \u542F\u52A8\u5931\u8D25</h1>
<p>\u56FA\u5B9A\u5730\u5740 <span class="address">${RUNTIME_API_URL}</span> \u5F53\u524D\u4E0D\u53EF\u7528\u3002</p>
<p>\u8BF7\u5173\u95ED\u65E7\u7684 Toonflow\uFF0C\u6216\u7ED3\u675F\u5360\u7528\u7AEF\u53E3 ${RUNTIME_API_PORT} \u7684\u7A0B\u5E8F\u540E\u91CD\u65B0\u542F\u52A8\u3002</p>
<div class="error">${message.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)}</div>
</div></body></html>`)}`;
  if (!loadingWindow || loadingWindow.isDestroyed()) showLoading();
  void loadingWindow?.loadURL(errorHtml);
}
async function createMainWindow() {
  if (process.env.VITE_DEV && !await waitForViteReady()) {
    showViteStartupError();
    return;
  }
  return new Promise((resolve) => {
    let settled = false;
    const win = new import_electron.BrowserWindow({
      width: 1e3,
      height: 700,
      minWidth: 800,
      minHeight: 500,
      frame: false,
      show: false,
      autoHideMenuBar: true,
      resizable: true,
      thickFrame: true
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
    const handleLoadFailure = (error) => {
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
    const isDev = process.env.NODE_ENV === "dev" || !import_electron.app.isPackaged;
    if (process.env.VITE_DEV) {
      void win.loadURL(VITE_DEV_ORIGIN).catch(handleLoadFailure);
    } else {
      const htmlPath = isDev ? import_path.default.join(process.cwd(), "data", "web", "index.html") : import_path.default.join(getSystemDataPath(), "web", "index.html");
      void win.loadFile(htmlPath).catch(handleLoadFailure);
    }
  });
}
var runtimeRecords = /* @__PURE__ */ new Map();
var runtimeStates = /* @__PURE__ */ new Map();
var ipcConnectedRoles = /* @__PURE__ */ new Set();
var runtimeShuttingDown = false;
var runtimeBootCompleted = false;
var stopMainMetrics;
var runtimeHealthTimer = null;
function runtimeEntry(role) {
  if (import_electron.app.isPackaged) {
    const file2 = role === "api" ? "api-process.js" : role === "worker" ? "task-worker.js" : "agent-process.js";
    const modulePaths = [
      import_path.default.join(process.resourcesPath, "app.asar", "node_modules"),
      import_path.default.join(process.resourcesPath, "app.asar.unpacked", "node_modules"),
      process.env.NODE_PATH
    ].filter(Boolean);
    return {
      file: import_path.default.join(getSystemDataPath(), "serve", "runtime", file2),
      execArgv: [],
      env: { NODE_PATH: modulePaths.join(import_path.default.delimiter) }
    };
  }
  const file = role === "api" ? "apiProcess.ts" : role === "worker" ? "taskWorker.ts" : "agentProcess.ts";
  return {
    file: import_path.default.join(process.cwd(), "scripts", "runtimeBootstrap.cjs"),
    execArgv: [],
    env: { TOONFLOW_RUNTIME_ENTRY: import_path.default.join(process.cwd(), "src", "runtime", file) }
  };
}
function forwardRuntimeOutput(role, stream, level) {
  stream?.on("data", (chunk) => {
    const message = String(chunk).trimEnd();
    if (!message) return;
    mainLog[level === "error" ? "error" : "info"](message, {
      event: level === "error" ? "runtime.stderr" : "runtime.stdout",
      role: "main",
      childRole: role
    });
  });
}
function getRuntimeSnapshot() {
  const roles = ["api", "worker", "agent"];
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
        ipcConnected: role === "api" ? state?.status === "ready" : ipcConnectedRoles.has(role)
      };
    })
  };
}
function publishRuntimeState() {
  const api = runtimeRecords.get("api")?.process;
  if (!api?.pid) return;
  api.postMessage({ type: "runtime:supervisor", snapshot: getRuntimeSnapshot() });
}
function updateRuntimeState(role, patch) {
  const previous = runtimeStates.get(role);
  const hasLastError = Object.prototype.hasOwnProperty.call(patch, "lastError");
  runtimeStates.set(role, {
    role,
    pid: patch.pid ?? previous?.pid ?? 0,
    status: patch.status ?? previous?.status ?? "starting",
    lastHeartbeatAt: patch.lastHeartbeatAt ?? previous?.lastHeartbeatAt ?? Date.now(),
    restartCount: patch.restartCount ?? previous?.restartCount ?? 0,
    lastError: hasLastError ? patch.lastError : previous?.lastError,
    ipcConnected: patch.ipcConnected ?? previous?.ipcConnected
  });
  publishRuntimeState();
}
function connectRuntimeChannel(role) {
  const api = runtimeRecords.get("api")?.process;
  const child = runtimeRecords.get(role)?.process;
  if (!api?.pid || !child?.pid) return;
  const channel = new import_electron.MessageChannelMain();
  api.postMessage({ type: "runtime:attach", role, pid: child.pid }, [channel.port1]);
  child.postMessage({ type: "runtime:attach", role: "api", pid: api.pid }, [channel.port2]);
  ipcConnectedRoles.add(role);
  updateRuntimeState(role, { ipcConnected: true });
}
function spawnRuntime(role, restartCount = 0) {
  const { file, execArgv, env } = runtimeEntry(role);
  const childEnv = {
    ...process.env,
    PORT: String(RUNTIME_API_PORT),
    TOONFLOW_UTILITY: "1",
    TOONFLOW_RUNTIME_ROLE: role,
    TOONFLOW_APP_DATA_DIR: process.env.TOONFLOW_APP_DATA_DIR,
    TOONFLOW_WORKSPACE_DIR: process.env.TOONFLOW_WORKSPACE_DIR,
    TOONFLOW_STORAGE_MODE: process.env.TOONFLOW_STORAGE_MODE,
    TOONFLOW_LEGACY_DATA_DIR: process.env.TOONFLOW_LEGACY_DATA_DIR,
    TOONFLOW_DATA_DIR: process.env.TOONFLOW_DATA_DIR,
    NODE_ENV: import_electron.app.isPackaged ? "prod" : "dev",
    ...env
  };
  delete childEnv.TOONFLOW_API_PORT;
  const child = import_electron.utilityProcess.fork(file, [], {
    cwd: process.cwd(),
    execArgv,
    serviceName: `Toonflow ${role}`,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv
  });
  const record = {
    role,
    process: child,
    restartCount,
    stopping: false,
    ready: false,
    readyAt: 0,
    healthKillIssued: false
  };
  runtimeRecords.set(role, record);
  updateRuntimeState(role, {
    pid: Number(child.pid || 0),
    status: "starting",
    lastHeartbeatAt: Date.now(),
    restartCount,
    lastError: void 0,
    ipcConnected: false
  });
  forwardRuntimeOutput(role, child.stdout, "log");
  forwardRuntimeOutput(role, child.stderr, "error");
  child.on("message", (message) => {
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
        lastError: void 0
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
        lastError: void 0
      });
    }
    if (message?.type === "runtime:error") {
      mainLog.error("Runtime child reported fatal error", {
        event: "runtime.error",
        childRole: role,
        childPid: message.pid,
        error: message.message
      });
      updateRuntimeState(role, { status: "failed", lastError: String(message.message || "unknown runtime error") });
    }
    if (message?.type === "runtime:log") {
      mainLog.info(String(message.message || ""), {
        event: "runtime.child-log",
        childRole: message.role || role,
        childPid: message.pid
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
      lastError: current?.stopping ? void 0 : `process exited with code ${code}`
    });
    if (runtimeShuttingDown || current?.stopping) return;
    if (!runtimeBootCompleted) return;
    const stableRun = record.readyAt > 0 && Date.now() - record.readyAt >= 6e4;
    const nextAttempt = stableRun ? 1 : restartCount + 1;
    if (nextAttempt > 3) {
      updateRuntimeState(role, {
        status: "failed",
        restartCount,
        lastError: `restart limit reached after exit code ${code}`
      });
      return;
    }
    const delays = [1e3, 3e3, 1e4];
    mainLog.warn("Runtime child exited; restarting", {
      event: "runtime.restart",
      childRole: role,
      code,
      delayMs: delays[nextAttempt - 1]
    });
    setTimeout(() => {
      void spawnRuntime(role, nextAttempt).then(() => {
        if (role === "api") {
          connectRuntimeChannel("worker");
          connectRuntimeChannel("agent");
        } else {
          connectRuntimeChannel(role);
        }
        publishRuntimeState();
      }).catch((error) => {
        updateRuntimeState(role, { status: "failed", lastError: String(error?.message || error) });
      });
    }, delays[nextAttempt - 1]);
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${role} utility process startup timed out`)), 12e4);
    const onMessage = (message) => {
      if (message?.type === "runtime:error") {
        clearTimeout(timeout);
        child.off("message", onMessage);
        reject(new Error(message.message || `${role} utility process failed`));
      }
      if (message?.type === "runtime:ready" && message.role === role) {
        clearTimeout(timeout);
        child.off("message", onMessage);
        resolve({ pid: Number(message.pid || child.pid), port: message.port == null ? void 0 : Number(message.port) });
      }
    };
    child.on("message", onMessage);
  });
}
function startRuntimeHealthMonitor() {
  if (runtimeHealthTimer) clearInterval(runtimeHealthTimer);
  runtimeHealthTimer = setInterval(() => {
    const now = Date.now();
    for (const [role, record] of runtimeRecords) {
      if (record.stopping || !record.ready) continue;
      const state = runtimeStates.get(role);
      const heartbeatAge = now - (state?.lastHeartbeatAt || now);
      if (heartbeatAge > 3e4 && !record.healthKillIssued) {
        record.healthKillIssued = true;
        updateRuntimeState(role, {
          status: "failed",
          lastError: `heartbeat timed out after ${Math.round(heartbeatAge / 1e3)}s`
        });
        mainLog.error("Runtime heartbeat timed out; terminating child", {
          event: "runtime.heartbeat-timeout",
          childRole: role,
          childPid: record.process.pid,
          heartbeatAge
        });
        record.process.kill();
      } else if (heartbeatAge > 15e3 && state?.status === "ready") {
        updateRuntimeState(role, {
          status: "degraded",
          lastError: `heartbeat delayed ${Math.round(heartbeatAge / 1e3)}s`
        });
      }
    }
  }, 5e3);
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
  stopMainMetrics = startRuntimeMetrics("main", (metric) => {
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
  stopMainMetrics = void 0;
  const records = [...runtimeRecords.values()];
  const stopped = records.map(
    (record) => new Promise((resolve) => {
      record.stopping = true;
      const timeout = setTimeout(() => {
        record.process.kill();
        resolve();
      }, record.role === "worker" ? 75e3 : 15e3);
      record.process.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      record.process.postMessage({ type: "shutdown" });
    })
  );
  await Promise.all(stopped);
  runtimeRecords.clear();
  runtimeStates.clear();
  ipcConnectedRoles.clear();
}
import_electron.protocol.registerSchemesAsPrivileged([
  {
    scheme: "toonflow",
    privileges: {
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
]);
if (hasSingleInstanceLock) import_electron.app.whenReady().then(async () => {
  const migratedUserDataEntries = migrateLegacyElectronUserData();
  initLogger({ role: "main", logDir: import_path.default.join(import_electron.app.getPath("userData"), "logs"), hijackConsole: true });
  mainLog.info("Electron main process ready", {
    event: "ready",
    appName: APP_NAME,
    userData: import_electron.app.getPath("userData"),
    migratedUserDataEntries
  });
  showLoading();
  try {
    const storageConfig = resolveStorageRuntime();
    applyStorageEnvironment(storageConfig);
    if (storageConfig.mode === "workspace") {
      import_fs.default.mkdirSync(storageConfig.workspacePath, { recursive: true });
      acquireWorkspaceLock(storageConfig);
      const manifestPath = import_path.default.join(storageConfig.workspacePath, "workspace.json");
      if (!import_fs.default.existsSync(manifestPath)) {
        import_fs.default.writeFileSync(
          manifestPath,
          JSON.stringify({ version: 1, createdAt: Date.now() }, null, 2),
          "utf8"
        );
      }
    }
    if (import_electron.app.isPackaged) {
      await new Promise((r) => setTimeout(r, 0));
      initializeData();
    } else {
      process.env.NODE_ENV = "dev";
      initializeData();
    }
    await startRuntimeProcesses();
    await new Promise((resolve, reject) => {
      setTimeout(() => {
        resolve();
      }, 2e3);
    });
    import_electron.protocol.handle("toonflow", async (request) => {
      const url = new URL(request.url);
      const pathname = url.hostname.toLowerCase();
      const handlers = {
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
          import_electron.app.exit(0);
          return { ok: true };
        },
        apprestart: () => {
          setTimeout(() => {
            import_electron.app.relaunch();
            import_electron.app.exit(0);
          }, 500);
          return { ok: true, message: "\u5E94\u7528\u5373\u5C06\u91CD\u542F" };
        },
        windowismaximized: () => ({
          maximized: mainWindow?.isMaximized() ?? false
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
            return { ok: false, error: "\u7F3A\u5C11 url \u53C2\u6570" };
          }
        },
        selectdirectory: () => {
          const purpose = url.searchParams.get("purpose");
          const result = selectDirectory({
            title: purpose === "projectImport" ? "Select Toonflow project directory" : "Select Toonflow workspace directory",
            properties: ["openDirectory", "createDirectory"]
          });
          return { ok: Boolean(result?.[0]), path: result?.[0] || null, purpose };
        },
        opendirectory: async () => {
          const requestedPath = url.searchParams.get("path");
          if (!requestedPath) return { ok: false, error: "Missing path" };
          const target = import_path.default.resolve(requestedPath);
          const roots = [import_path.default.resolve(storageConfig.workspacePath), import_path.default.resolve(import_electron.app.getPath("userData"))];
          const allowed = roots.some(
            (root) => target === root || target.startsWith(`${root}${import_path.default.sep}`)
          );
          if (!allowed || !import_fs.default.existsSync(target) || !import_fs.default.statSync(target).isDirectory()) {
            return { ok: false, error: "Directory is outside Toonflow managed storage" };
          }
          const { shell } = require("electron");
          const openError = await shell.openPath(target);
          return openError ? { ok: false, error: openError } : { ok: true, path: target };
        },
        getlocallanguage: () => {
          if (process.platform === "darwin") {
            const systemLocale = import_electron.systemPreferences.getUserDefault("AppleLocale", "string");
            return { ok: true, local: systemLocale };
          }
          const appLocale = import_electron.app.getLocale();
          return { ok: true, local: appLocale };
        }
      };
      const handler = handlers[pathname];
      const responseData = handler ? await handler() : { error: "\u672A\u77E5\u63A5\u53E3" };
      return new Response(JSON.stringify(responseData), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
        }
      });
    });
    await createMainWindow();
  } catch (err) {
    console.error("[runtime startup failed]:", err);
    await stopRuntimeProcesses().catch(() => {
    });
    showStartupError(err);
  }
});
import_electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") import_electron.app.quit();
});
import_electron.app.on("activate", () => {
  if (import_electron.BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
var shutdownStarted = false;
import_electron.app.on("before-quit", (event) => {
  if (shutdownStarted) return;
  if (runtimeRecords.size === 0) {
    releaseWorkspaceLock();
    return;
  }
  event.preventDefault();
  shutdownStarted = true;
  void stopRuntimeProcesses().catch((error) => {
    console.error("[\u670D\u52A1\u5173\u95ED\u5931\u8D25]:", error);
  }).finally(() => {
    releaseWorkspaceLock();
    import_electron.app.exit(0);
  });
});
