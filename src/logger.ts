import fs from "node:fs";
import path from "node:path";
import { appDataRoot } from "@/services/storagePaths";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogRole = "main" | "api" | "worker" | "agent" | "script" | string;

export interface LogContext {
  role?: LogRole;
  module?: string;
  event?: string;
  requestId?: string;
  taskId?: string | number;
  projectId?: string | number;
  scriptId?: string | number;
  businessId?: string | number;
  provider?: string;
  model?: string;
  durationMs?: number;
  error?: unknown;
  diagnosticFile?: string;
  [key: string]: unknown;
}

export interface LoggerInitOptions {
  role?: LogRole;
  logDir?: string;
  retentionDays?: number;
  console?: boolean;
  hijackConsole?: boolean;
}

export interface LoggerStatus {
  logDir: string;
  retentionDays: number;
  currentRole: LogRole;
  files: Array<{ path: string; relativePath: string; size: number; mtimeMs: number }>;
  totalSize: number;
  recentErrors: Array<Record<string, unknown>>;
  lastLogAtByRole: Record<string, number>;
}

const DEFAULT_RETENTION_DAYS = 7;
const MAX_FIELD_BYTES = 8 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const SENSITIVE_KEYS = /authorization|cookie|token|secret|password|credential|api[_-]?key|access[_-]?key|refresh[_-]?token/i;
const BASE64_PATTERN = /data:[^;]+;base64,[A-Za-z0-9+/=\r\n]+/gi;
const ANSI_PATTERN = /\x1B\[[0-9;]*m/g;

type ConsoleMethod = (...args: unknown[]) => void;

let currentRole: LogRole = process.env.TOONFLOW_RUNTIME_ROLE || "script";
let rootLogDir = path.join(appDataRoot(), "logs");
let retentionDays = DEFAULT_RETENTION_DAYS;
let initialized = false;
let hijacked = false;
let writeStreams = new Map<string, fs.WriteStream>();
let originalConsole: Partial<Record<"log" | "info" | "warn" | "error" | "debug", ConsoleMethod>> = {};
let originalStdoutWrite: typeof process.stdout.write | null = null;
let originalStderrWrite: typeof process.stderr.write | null = null;
let writingRaw = false;

function dateKey(time = Date.now()) {
  return new Date(time).toISOString().slice(0, 10);
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function streamKey(role: LogRole, channel: string) {
  return `${dateKey()}:${role}:${channel}`;
}

function logFilePath(role: LogRole, channel = role) {
  return path.join(rootLogDir, dateKey(), `${channel}.jsonl`);
}

function getStream(role: LogRole, channel = role) {
  const key = streamKey(role, channel);
  const existing = writeStreams.get(key);
  if (existing && !existing.destroyed) return existing;
  const file = logFilePath(role, channel);
  ensureDir(path.dirname(file));
  const stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
  writeStreams.set(key, stream);
  return stream;
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function stringifyError(error: unknown) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return sanitizeValue(error, 0);
}

function truncateString(value: string, maxBytes = MAX_FIELD_BYTES) {
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

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[max depth]";
  if (value == null) return value;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return stringifyError(value);
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      output[key] = SENSITIVE_KEYS.test(key) ? "[redacted]" : sanitizeValue(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

function compactLine(entry: Record<string, unknown>) {
  let line = `${JSON.stringify(entry)}\n`;
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
    diagnosticFile,
  };
  line = `${JSON.stringify(compact)}\n`;
  return { line, diagnosticFile };
}

function consoleMethod(level: LogLevel): "log" | "info" | "warn" | "error" | "debug" {
  if (level === "error") return "error";
  if (level === "warn") return "warn";
  if (level === "debug") return "debug";
  return "info";
}

function formatConsole(level: LogLevel, entry: Record<string, unknown>) {
  const moduleName = entry.module ? `[${entry.module}]` : "";
  const eventName = entry.event ? ` ${entry.event}` : "";
  const message = entry.message ? ` ${entry.message}` : "";
  return `[${entry.role}] [${level}]${moduleName}${eventName}${message}`;
}

export function writeLog(level: LogLevel, message: string, context: LogContext = {}) {
  if (!initialized) initLogger();
  const role = context.role || currentRole;
  const channel = context.module === "video-queue" ? "video-queue" : role;
  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    role,
    pid: process.pid,
    module: context.module || "app",
    event: context.event || "log",
    message: truncateString(message),
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

export function createLogger(moduleName: string, defaults: LogContext = {}) {
  const write = (level: LogLevel, message: string, context: LogContext = {}) =>
    writeLog(level, message, { ...defaults, ...context, module: context.module || defaults.module || moduleName });
  return {
    debug: (message: string, context?: LogContext) => write("debug", message, context),
    info: (message: string, context?: LogContext) => write("info", message, context),
    warn: (message: string, context?: LogContext) => write("warn", message, context),
    error: (message: string, context?: LogContext) => write("error", message, context),
  };
}

function writeRaw(level: LogLevel, chunk: unknown) {
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
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    originalConsole[method] = console[method].bind(console);
    (console as any)[method] = (...args: unknown[]) => {
      const level: LogLevel = method === "log" ? "info" : method;
      writeLog(level, args.map((item) => (typeof item === "string" ? item : JSON.stringify(sanitizeValue(item)))).join(" "), {
        module: "console",
        event: method,
      });
    };
  }
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    writeRaw("info", chunk);
    return originalStdoutWrite!(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any, ...rest: any[]) => {
    writeRaw("error", chunk);
    return originalStderrWrite!(chunk, ...rest);
  }) as typeof process.stderr.write;
  hijacked = true;
}

export function initLogger(options: LoggerInitOptions = {}) {
  currentRole = options.role || process.env.TOONFLOW_RUNTIME_ROLE || currentRole;
  rootLogDir = options.logDir || path.join(appDataRoot(), "logs");
  retentionDays = options.retentionDays || DEFAULT_RETENTION_DAYS;
  ensureDir(rootLogDir);
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    if (!originalConsole[method]) originalConsole[method] = console[method].bind(console);
  }
  if (options.hijackConsole) hijackConsole();
  initialized = true;
  return logger;
}

export function closeLogger() {
  for (const stream of writeStreams.values()) stream.end();
  writeStreams.clear();
  if (hijacked) {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      const original = originalConsole[method];
      if (original) (console as any)[method] = original;
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

export function writeDiagnosticFile(name: string, content: string | Buffer, context: LogContext = {}) {
  if (!initialized) initLogger();
  const provider = context.provider || "app";
  const safeName = name.replace(/[^\w.-]+/g, "_").slice(0, 80) || "diagnostic";
  const fileName = `${Date.now()}-${safeName}.log`;
  const file = path.join(rootLogDir, "provider", String(provider), dateKey(), fileName);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, typeof content === "string" ? "utf8" : undefined);
  return file;
}

function walkFiles(dir: string): Array<{ path: string; relativePath: string; size: number; mtimeMs: number }> {
  if (!fs.existsSync(dir)) return [];
  const files: Array<{ path: string; relativePath: string; size: number; mtimeMs: number }> = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile()) {
        const stat = fs.statSync(file);
        files.push({ path: file, relativePath: path.relative(dir, file), size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  walk(dir);
  return files;
}

function readRecentErrors(files: Array<{ path: string; relativePath: string }>) {
  const errors: Array<Record<string, unknown>> = [];
  for (const file of files.filter((item) => item.path.endsWith(".jsonl")).sort((a, b) => b.path.localeCompare(a.path))) {
    if (errors.length >= 50) break;
    try {
      const lines = fs.readFileSync(file.path, "utf8").trim().split(/\r?\n/).slice(-300);
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
            file: file.relativePath,
          });
        }
      }
    } catch {
      // Ignore malformed or currently written files.
    }
  }
  return errors;
}

export function getLoggerStatus(): LoggerStatus {
  if (!initialized) initLogger();
  const files = walkFiles(rootLogDir);
  const totalSize = files.reduce((sum, item) => sum + item.size, 0);
  const lastLogAtByRole: Record<string, number> = {};
  for (const file of files) {
    const name = path.basename(file.path, ".jsonl");
    if (!lastLogAtByRole[name] || lastLogAtByRole[name] < file.mtimeMs) lastLogAtByRole[name] = file.mtimeMs;
  }
  return {
    logDir: rootLogDir,
    retentionDays,
    currentRole,
    files,
    totalSize,
    recentErrors: readRecentErrors(files),
    lastLogAtByRole,
  };
}

export function cleanupLogs(days = retentionDays) {
  if (!initialized) initLogger();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removedFiles = 0;
  let removedBytes = 0;
  for (const file of walkFiles(rootLogDir)) {
    if (file.mtimeMs >= cutoff) continue;
    try {
      fs.rmSync(file.path, { force: true });
      removedFiles += 1;
      removedBytes += file.size;
    } catch {
      // Best effort cleanup.
    }
  }
  pruneEmptyDirs(rootLogDir);
  return { removedFiles, removedBytes, cutoff };
}

function pruneEmptyDirs(dir: string) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) pruneEmptyDirs(child);
  }
  if (dir !== rootLogDir && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Ignore.
    }
  }
}

export const logger = {
  init: initLogger,
  close: closeLogger,
  create: createLogger,
  diagnostic: writeDiagnosticFile,
  status: getLoggerStatus,
  cleanup: cleanupLogs,
  debug: (message: string, context?: LogContext) => writeLog("debug", message, context),
  info: (message: string, context?: LogContext) => writeLog("info", message, context),
  warn: (message: string, context?: LogContext) => writeLog("warn", message, context),
  error: (message: string, context?: LogContext) => writeLog("error", message, context),
};

export default logger;
