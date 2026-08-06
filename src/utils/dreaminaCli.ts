import axios from "axios";
import fs from "fs";
import path from "path";
import os from "node:os";
import { execFile, spawn } from "child_process";
import { createRequire } from "node:module";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import getPath from "@/utils/getPath";
import { createLogger, writeDiagnosticFile } from "@/logger";

const dreaminaLog = createLogger("dreamina-cli", { provider: "dreamina" });
const runFile = promisify(execFile);
const localRequire = createRequire(typeof __filename === "string" ? __filename : path.resolve(process.cwd(), "package.json"));
const DREAMINA_VIDEO_DOWNLOAD_ATTEMPTS = 3;

type TaskState = "idle" | "running" | "qr" | "device" | "success" | "failed";

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface LoginSession {
  id: string;
  state: TaskState;
  qrPath?: string;
  qrBase64?: string;
  verificationUri?: string;
  loginUrl?: string;
  userCode?: string;
  deviceCode?: string;
  pollInterval?: number;
  expiresAt?: string;
  message?: string;
  stdout: string;
  stderr: string;
  startTime: number;
  endTime?: number;
}

interface ReferenceItem {
  type: "image" | "audio" | "video";
  base64?: string;
  filePath?: string;
}

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceItem, { type: "image" }>[];
  size: "1K" | "2K" | "4K" | string;
  aspectRatio: `${number}:${number}`;
}

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: `${number}:${number}`;
  prompt: string;
  referenceList?: ReferenceItem[];
  audio?: boolean;
  mode: any;
}

interface MusicConfig {
  prompt: string;
  durationSec?: number;
  duration?: number;
  vocalMode?: string;
  lyrics?: string;
  negativePrompt?: string;
  referenceList?: Extract<ReferenceItem, { type: "audio" }>[];
  outputFormat?: string;
  seed?: number;
  extra?: Record<string, unknown>;
}

interface ToonflowModel {
  name: string;
  modelName: string;
  type: "image" | "video" | "music";
  mode?: any;
  associationSkills?: string;
  audio?: "optional" | boolean;
  durationResolutionMap?: { duration: number[]; resolution: string[] }[];
  queueConfig?: QueueConfig;
  durationRange?: { min?: number; max?: number };
  durationParameter?: boolean;
  outputFormats?: string[];
  vocal?: "optional" | boolean;
  lyrics?: "optional" | boolean;
  referenceAudio?: "optional" | boolean;
  loop?: "optional" | boolean;
  supportedFlags?: string[];
}

interface ModelMeta {
  id: string;
  displayName: string;
  cost?: string;
  queue?: string;
  concurrency?: number;
  note?: string;
}

export interface QueueConfig {
  maxConcurrent?: number;
  pollInitialDelaySec?: number;
  pollMinIntervalSec?: number;
  pollMaxIntervalSec?: number;
  maxWorkHours?: number;
  /** @deprecated Use maxWorkHours. */
  maxWaitHours?: number;
}

export interface NormalizedQueueConfig {
  maxConcurrent: number;
  pollInitialDelaySec: number;
  pollMinIntervalSec: number;
  pollMaxIntervalSec: number;
  maxWorkHours: number;
  /** @deprecated Compatibility alias for one release. */
  maxWaitHours: number;
}

export interface DreaminaSubmitResult {
  state: "submitted" | "capacity_wait" | "failed";
  submitId?: string;
  confirmed?: boolean;
  rawOutput: string;
  errorReason?: string;
  officialTaskId?: string;
  historyRecordId?: string;
  providerAccountId?: string;
  providerCode?: string;
}

export interface DreaminaQueueInfo {
  status?: number;
  index?: number;
  length?: number;
}

export interface DreaminaPollResult {
  state: "generating" | "success" | "failed";
  data?: string;
  dataType?: "file" | "url" | "base64";
  rawOutput: string;
  errorReason?: string;
  providerAccountId?: string;
  providerCode?: string;
  evidence: DreaminaRemoteEvidence;
  queueInfo: DreaminaQueueInfo;
}

const DOWNLOAD_URL =
  "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/dreamina_cli_windows_amd64.exe";
const VERSION_URL = "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/version.json";
const MEDIA_COMMANDS = ["text2image", "image2image", "text2video", "image2video", "multiframe2video", "multimodal2video"] as const;
const MUSIC_COMMAND_CANDIDATES = ["text2music", "music_generation", "text2song", "generate_music", "music"] as const;
const COMMANDS = [...MEDIA_COMMANDS, ...MUSIC_COMMAND_CANDIDATES] as const;
const ALLOWED_COMMANDS = new Set<string>(["-h", "--help", "login", "relogin", "logout", "user_credit", "query_result", "list_task", ...COMMANDS]);

let currentLogin: LoginSession | null = null;
const queueState = new Map<string, { running: number; waiting: number; limit: number }>();

function cliDir() {
  return getPath(["bin", "dreamina"]);
}

function cliPath() {
  return path.join(cliDir(), process.platform === "win32" ? "dreamina.exe" : "dreamina");
}

function metaPath() {
  return path.join(cliDir(), "version.json");
}

function tempDir(...parts: string[]) {
  const dir = getPath(["temp", "dreamina", ...parts]);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function unpackedExecutablePath(value: unknown) {
  const resolved = String(value || "").replace(/([\\/])app\.asar([\\/])/i, "$1app.asar.unpacked$2");
  if (!resolved || !fs.existsSync(resolved)) throw new Error("Dreamina video validation runtime is unavailable: packaged executable is missing");
  return resolved;
}

function ffmpegPath() {
  return unpackedExecutablePath(localRequire("ffmpeg-static"));
}

function isInstalled() {
  return fs.existsSync(cliPath());
}

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(metaPath(), "utf-8"));
  } catch {
    return {};
  }
}

function writeMeta(data: Record<string, any>) {
  fs.mkdirSync(cliDir(), { recursive: true });
  fs.writeFileSync(metaPath(), JSON.stringify(data, null, 2), "utf-8");
}

function mimeFromExt(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".webm": "video/webm",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".m4a": "audio/mp4",
      ".aac": "audio/aac",
      ".flac": "audio/flac",
      ".ogg": "audio/ogg",
    }[ext] || "application/octet-stream"
  );
}

function fileToDataUrl(filePath: string) {
  const data = fs.readFileSync(filePath);
  return `data:${mimeFromExt(filePath)};base64,${data.toString("base64")}`;
}

function ensureInstalled() {
  if (!isInstalled()) throw new Error("未安装即梦 CLI，请先在即梦供应商设置中安装。");
}

function normalizeArgs(args: string[] = []) {
  return args.filter((arg) => typeof arg === "string" && arg.length > 0);
}

const activeCliProcesses = new Map<number, { pid: number; command: string; startedAt: number }>();

export function getActiveCliProcesses() {
  return [...activeCliProcesses.values()];
}

function runRaw(args: string[], timeoutMs = 120000): Promise<CliResult> {
  ensureInstalled();
  const normalizedArgs = normalizeArgs(args);
  const command = normalizedArgs[0] || "-h";
  if (!ALLOWED_COMMANDS.has(command)) throw new Error(`不允许执行的即梦 CLI 命令: ${command}`);
  const startedAt = Date.now();
  dreaminaLog.info("Dreamina CLI command started", {
    event: "command.started",
    command,
    timeoutMs,
    argCount: normalizedArgs.length - 1,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(cliPath(), normalizedArgs, {
      cwd: cliDir(),
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `${cliDir()}${path.delimiter}${process.env.PATH || ""}`,
      },
    });
    if (child.pid) activeCliProcesses.set(child.pid, { pid: child.pid, command, startedAt });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      dreaminaLog.warn("Dreamina CLI command timeout", {
        event: "command.timeout",
        command,
        elapsedMs: Date.now() - startedAt,
      });
      reject(new Error(`即梦 CLI 执行超时: dreamina ${command}`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (child.pid) activeCliProcesses.delete(child.pid);
      clearTimeout(timer);
      dreaminaLog.error("Dreamina CLI command error", {
        event: "command.error",
        command,
        elapsedMs: Date.now() - startedAt,
        error: err,
      });
      reject(err);
    });
    child.on("close", (code) => {
      if (child.pid) activeCliProcesses.delete(child.pid);
      clearTimeout(timer);
      dreaminaLog[code === 0 ? "info" : "warn"]("Dreamina CLI command finished", {
        event: "command.finished",
        command,
        code,
        elapsedMs: Date.now() - startedAt,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
      });
      resolve({ stdout, stderr, code });
    });
  });
}

async function run(args: string[], timeoutMs = 120000) {
  const result = await runRaw(args, timeoutMs);
  if (result.code !== 0) {
    throw new Error(cliFailureMessage(result, `即梦 CLI 退出码 ${result.code}`));
  }
  return result;
}

function normalizeError(message: string) {
  if (/AigcComplianceConfirmationRequired/i.test(message)) return "即梦模型需要先在网页端完成一次授权确认，请打开即梦网页完成确认后重试。";
  if (/未检测到有效登录态|请先执行\s*dreamina\s*login|not\s+logged\s+in|no\s+valid\s+login/i.test(message)) return "即梦 CLI 未检测到有效登录态，请重新登录。";
  if (/login|credential|unauthorized|permission/i.test(message)) return "即梦 CLI 未登录或登录已失效，请重新扫码登录。";
  return message.trim() || "即梦 CLI 执行失败";
}

function cliFailureMessage(result: CliResult, fallback: string) {
  const output = `${result.stderr}\n${result.stdout}`.trim();
  return normalizeError(output || fallback);
}

async function validateLoginState() {
  const result = await runRaw(["user_credit"], 60000);
  const raw = `${result.stdout}\n${result.stderr}`.trim();
  return {
    ok: result.code === 0,
    raw,
    message: result.code === 0 ? "即梦登录状态有效。" : cliFailureMessage(result, `即梦 CLI 退出码 ${result.code}`),
  };
}

async function fetchLatestVersion() {
  try {
    const res = await axios.get(VERSION_URL, { timeout: 15000 });
    return res.data;
  } catch {
    return null;
  }
}

async function install(force = false) {
  if (process.platform !== "win32") throw new Error("当前版本优先支持 Windows 安装即梦 CLI。");
  if (isInstalled() && !force) return status();

  fs.mkdirSync(cliDir(), { recursive: true });
  const res = await axios.get(DOWNLOAD_URL, { responseType: "arraybuffer", timeout: 120000 });
  fs.writeFileSync(cliPath(), Buffer.from(res.data));
  const version = await fetchLatestVersion();
  writeMeta({
    installedAt: Date.now(),
    downloadUrl: DOWNLOAD_URL,
    version,
  });
  return status();
}

async function uninstall() {
  const target = cliDir();
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  currentLogin = null;
  return status();
}

function parseLoginMarkers(text: string) {
  const qr = text.match(/\[DREAMINA:QR_READY\]\s+(.+)/);
  const success = /\[DREAMINA:LOGIN_SUCCESS\]|登录成功|授?权成功|login\s+success|auth(?:orization)?\s+success/i.test(text);
  const reused = /\[DREAMINA:LOGIN_REUSED\]|已经登录|已登录|login\s+reused|credential\s+valid/i.test(text);
  const verificationUri = text.match(/verification_uri\s*:\s*(\S+)/i)?.[1]?.trim();
  const userCode = text.match(/user_code\s*:\s*(\S+)/i)?.[1]?.trim();
  const deviceCode = text.match(/device_code\s*:\s*(\S+)/i)?.[1]?.trim();
  const pollIntervalText = text.match(/poll_interval\s*:\s*(\d+)\s*s?/i)?.[1];
  const expiresAt = text.match(/expires_at\s*:\s*([^\r\n]+)/i)?.[1]?.trim();
  return {
    qrPath: qr?.[1]?.trim(),
    verificationUri,
    loginUrl: verificationUri,
    userCode,
    deviceCode,
    pollInterval: pollIntervalText ? Number(pollIntervalText) : undefined,
    expiresAt,
    device: Boolean(verificationUri && userCode),
    success,
    reused,
  };
}

function makeSession(): LoginSession {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    state: "running",
    stdout: "",
    stderr: "",
    startTime: Date.now(),
  };
}

function login() {
  ensureInstalled();
  if (currentLogin && currentLogin.state !== "success" && currentLogin.state !== "failed") return Promise.resolve(currentLogin);

  currentLogin = makeSession();
  const session = currentLogin;

  return new Promise<LoginSession>((resolve, reject) => {
    const child = spawn(cliPath(), ["login"], {
      cwd: cliDir(),
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `${cliDir()}${path.delimiter}${process.env.PATH || ""}`,
      },
    });
    if (child.pid) activeCliProcesses.set(child.pid, { pid: child.pid, command: "login", startedAt: Date.now() });
    let resolved = false;
    const timer = setTimeout(() => {
      child.kill();
      session.state = "failed";
      session.message = "即梦登录超时，请重试。";
      session.endTime = Date.now();
      if (!resolved) reject(new Error(session.message));
    }, 900000);
    child.once("close", () => {
      if (child.pid) activeCliProcesses.delete(child.pid);
    });
    child.once("error", () => {
      if (child.pid) activeCliProcesses.delete(child.pid);
    });

    const updateFromOutput = () => {
      const markers = parseLoginMarkers(`${session.stdout}\n${session.stderr}`);
      if (markers.qrPath && !session.qrPath) {
        session.qrPath = markers.qrPath;
        session.state = "qr";
        if (fs.existsSync(markers.qrPath)) session.qrBase64 = fileToDataUrl(markers.qrPath);
        if (!resolved) {
          resolved = true;
          resolve({ ...session });
        }
      }
      if (markers.device && session.state !== "device") {
        session.state = "device";
        session.verificationUri = markers.verificationUri;
        session.loginUrl = markers.loginUrl;
        session.userCode = markers.userCode;
        session.deviceCode = markers.deviceCode;
        session.pollInterval = markers.pollInterval;
        session.expiresAt = markers.expiresAt;
        session.message = "请使用浏览器打开登录链接，并按即梦页面提示完成授权。";
        if (!resolved) {
          resolved = true;
          resolve({ ...session });
        }
      }
      if (markers.success || markers.reused) {
        session.state = "success";
        session.message = markers.reused ? "当前登录状态仍然有效。" : "即梦登录成功。";
      }
    };

    child.stdout?.on("data", (chunk) => {
      session.stdout += chunk.toString();
      updateFromOutput();
    });
    child.stderr?.on("data", (chunk) => {
      session.stderr += chunk.toString();
      updateFromOutput();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      session.state = "failed";
      session.message = normalizeError(err.message);
      session.endTime = Date.now();
      if (!resolved) reject(err);
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      updateFromOutput();
      session.endTime = Date.now();
      if (code !== 0 && session.state !== "success") {
        session.state = "failed";
        session.message = normalizeError(session.stderr || session.stdout || `即梦登录失败，退出码 ${code}`);
      } else if (code === 0 && session.state !== "failed") {
        const validation = await validateLoginState();
        session.state = validation.ok ? "success" : "failed";
        session.message = validation.ok ? "即梦登录成功。" : `浏览器授权已结束，但 ${validation.message}`;
      }
      if (!resolved) {
        resolved = true;
        resolve({ ...session });
      }
    });
  });
}

function flag(name: string, value: string | number | boolean | undefined | null) {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "boolean") return value ? [`--${name}`] : [];
  return [`--${name}=${String(value)}`];
}

function qualityToResolution(value: string) {
  const lower = String(value || "").toLowerCase();
  if (lower.includes("4")) return "4k";
  if (lower.includes("2")) return "2k";
  return "1k";
}

function extFromReference(ref: ReferenceItem) {
  if (ref.filePath) return path.extname(ref.filePath) || (ref.type === "video" ? ".mp4" : ref.type === "audio" ? ".bin" : ".png");
  const mime =
    ref.base64?.match(/^data:([^;]+);base64,/)?.[1]?.toLowerCase() ||
    (ref.type === "video" ? "video/mp4" : ref.type === "audio" ? "audio/mpeg" : "image/png");
  return (
    {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/webp": ".webp",
      "video/mp4": ".mp4",
      "video/quicktime": ".mov",
      "video/webm": ".webm",
      "audio/mpeg": ".mp3",
      "audio/mp3": ".mp3",
      "audio/mp4": ".m4a",
      "audio/x-m4a": ".m4a",
      "audio/aac": ".aac",
      "audio/wav": ".wav",
      "audio/wave": ".wav",
      "audio/x-wav": ".wav",
      "audio/flac": ".flac",
      "audio/ogg": ".ogg",
    }[mime] || (ref.type === "video" ? ".mp4" : ref.type === "audio" ? ".bin" : ".png")
  );
}

function writeReferenceFiles(refs: ReferenceItem[] = [], group: string) {
  const dir = tempDir("refs", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return refs.map((ref, index) => {
    if (ref.filePath) {
      if (!fs.existsSync(ref.filePath)) throw new Error(`参考素材原始文件不存在: ${ref.filePath}`);
      return ref.filePath;
    }
    if (!ref.base64) throw new Error(`参考素材 ${index + 1} 缺少文件路径或数据`);
    const ext = extFromReference(ref);
    const filePath = path.join(dir, `${group}-${index}${ext}`);
    fs.writeFileSync(filePath, Buffer.from(ref.base64.replace(/^data:[^;]+;base64,/, ""), "base64"));
    return filePath;
  });
}

function writeReferenceFileItems(refs: ReferenceItem[] = [], group: string) {
  const dir = tempDir("refs", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return refs.map((ref, index) => {
    if (ref.filePath) {
      const normalized = ref.filePath.replace(/\\/g, "/").toLowerCase();
      if (/^https?:\/\//i.test(ref.filePath) || ref.filePath.includes("?") || normalized.includes("/smallimage/")) {
        throw new Error(`Dreamina 只能接收本地原始素材文件: ${ref.filePath}`);
      }
      if (!fs.existsSync(ref.filePath) || !fs.statSync(ref.filePath).isFile()) {
        throw new Error(`参考素材原始文件不存在: ${ref.filePath}`);
      }
      return { type: ref.type, filePath: ref.filePath };
    }
    if (!ref.base64) throw new Error(`参考素材 ${index + 1} 缺少文件路径或数据`);
    const ext = extFromReference(ref);
    const filePath = path.join(dir, `${group}-${index}${ext}`);
    fs.writeFileSync(filePath, Buffer.from(ref.base64.replace(/^data:[^;]+;base64,/, ""), "base64"));
    return { type: ref.type, filePath };
  });
}

function parseModelName(modelName: string) {
  const [command, modelVersion] = modelName.split(/:(.+)/);
  return {
    command: command || "text2image",
    modelVersion: modelVersion && modelVersion !== "default" ? modelVersion : "",
  };
}

export function normalizeDreaminaModelVersion(modelName: string) {
  const { modelVersion } = parseModelName(modelName);
  const normalized = (modelVersion || "default").trim().toLowerCase().replace(/\s+/g, "");
  return (
    {
      "seedance2.0-fast": "seedance2.0fast",
      "seedance2.0_fast": "seedance2.0fast",
      "seedance2.0-mini": "seedance2.0mini",
      "seedance2.0_mini": "seedance2.0mini",
      "seedance2.0mini": "seedance2.0mini",
      "seedance2.0-fast-vip": "seedance2.0fast_vip",
      "seedance2.0-fast_vip": "seedance2.0fast_vip",
      "seedance2.0_fast_vip": "seedance2.0fast_vip",
      "seedance2.0fastvip": "seedance2.0fast_vip",
      "seedance2.0-vip": "seedance2.0_vip",
      "seedance2.0vip": "seedance2.0_vip",
    }[normalized] || normalized
  );
}

export function getDreaminaProviderModelKey(modelName: string) {
  return `dreamina:${normalizeDreaminaModelVersion(modelName)}`;
}

function extractSubmitId(output: string) {
  return (
    output.match(/submit_id["'\s:=]+([A-Za-z0-9_-]+)/)?.[1] ||
    output.match(/"submit_id"\s*:\s*"([^"]+)"/)?.[1] ||
    output.match(/submit_id=([A-Za-z0-9_-]+)/)?.[1]
  );
}

function isQuerying(output: string) {
  return /gen_status["'\s:=]+querying/i.test(output) || /"gen_status"\s*:\s*"querying"/i.test(output);
}

type DreaminaMediaType = "image" | "video" | "music";

function findNewestFile(dir: string, type: DreaminaMediaType) {
  const allowed =
    type === "image"
      ? new Set([".png", ".jpg", ".jpeg", ".webp"])
      : type === "video"
        ? new Set([".mp4", ".mov", ".webm"])
        : new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);
  const files: string[] = [];
  const walk = (current: string) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (allowed.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  };
  walk(dir);
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function extractUrl(output: string, type: DreaminaMediaType) {
  const urls = output.match(/https?:\/\/[^\s"'<>]+/g) || [];
  const preferred =
    type === "image" ? /\.(png|jpe?g|webp)(\?|$)/i : type === "video" ? /\.(mp4|mov|webm)(\?|$)/i : /\.(mp3|wav|m4a|aac|flac|ogg)(\?|$)/i;
  return urls.find((url) => preferred.test(url)) || urls[0];
}

async function queryResult(submitId: string, downloadDir: string, poll = 120) {
  return runRaw(["query_result", `--submit_id=${submitId}`, `--download_dir=${downloadDir}`], Math.max(60000, poll * 1000));
}

function outputText(result: CliResult) {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function compactDownloadError(error: unknown) {
  const cause = error as { message?: unknown; stderr?: unknown };
  const message = String(cause?.stderr || cause?.message || error || "unknown error")
    .replace(/\s+/g, " ")
    .trim();
  return message.slice(0, 800);
}

export async function validateDreaminaVideoFile(filePath: string) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error("Dreamina video download is empty or not a regular file");

  try {
    await runFile(
      ffmpegPath(),
      ["-v", "error", "-xerror", "-err_detect", "explode", "-i", filePath, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"],
      { maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (error) {
    throw new Error(`Dreamina video download is incomplete or corrupt: ${compactDownloadError(error)}`);
  }

  return { bytes: stat.size };
}

export async function downloadDreaminaVideoUrl(url: string, downloadDir: string) {
  await fs.promises.mkdir(downloadDir, { recursive: true });
  const partPath = path.join(downloadDir, "official-video.part");
  const videoPath = path.join(downloadDir, "official-video.mp4");
  await fs.promises.rm(partPath, { force: true });
  await fs.promises.rm(videoPath, { force: true });

  try {
    const response = await axios.get(url, {
      responseType: "stream",
      timeout: 180000,
      validateStatus: () => true,
    });
    if (response.status !== 200) {
      response.data?.destroy?.();
      throw new Error(`Dreamina video URL returned HTTP ${response.status}; a full 200 response is required`);
    }
    if (response.headers["content-range"]) {
      response.data?.destroy?.();
      throw new Error("Dreamina video URL returned Content-Range; partial responses are not accepted");
    }

    const rawLength = response.headers["content-length"];
    const expectedBytes = rawLength === undefined ? undefined : Number(Array.isArray(rawLength) ? rawLength[0] : rawLength);
    if (rawLength !== undefined && (expectedBytes === undefined || !Number.isFinite(expectedBytes) || expectedBytes < 0)) {
      response.data?.destroy?.();
      throw new Error("Dreamina video URL returned an invalid Content-Length");
    }

    let receivedBytes = 0;
    response.data.on("data", (chunk: Buffer) => {
      receivedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    });
    await pipeline(response.data, fs.createWriteStream(partPath));
    if (expectedBytes !== undefined && receivedBytes !== expectedBytes) {
      throw new Error(`Dreamina video URL size mismatch: expected ${expectedBytes} bytes, received ${receivedBytes}`);
    }
    await fs.promises.rename(partPath, videoPath);
    return videoPath;
  } catch (error) {
    await fs.promises.rm(partPath, { force: true }).catch(() => {});
    await fs.promises.rm(videoPath, { force: true }).catch(() => {});
    throw error;
  }
}

export class DreaminaVideoDownloadError extends Error {
  constructor(
    message: string,
    readonly diagnostics: string,
  ) {
    super(message);
    this.name = "DreaminaVideoDownloadError";
  }
}

type DreaminaVideoDownloadDependencies = {
  queryResult?: (submitId: string, downloadDir: string, poll?: number) => Promise<CliResult>;
  downloadUrl?: (url: string, downloadDir: string) => Promise<string>;
  validateFile?: (filePath: string) => Promise<{ bytes: number }>;
};

export async function retrieveValidatedDreaminaVideo(
  input: { submitId: string; fallbackUrl?: string; tempRoot?: string },
  dependencies: DreaminaVideoDownloadDependencies = {},
) {
  const diagnostics: string[] = [];
  const query = dependencies.queryResult || queryResult;
  const downloadUrl = dependencies.downloadUrl || downloadDreaminaVideoUrl;
  const validateFile = dependencies.validateFile || validateDreaminaVideoFile;

  for (let attempt = 1; attempt <= DREAMINA_VIDEO_DOWNLOAD_ATTEMPTS; attempt += 1) {
    const downloadDir = input.tempRoot
      ? path.join(input.tempRoot, `attempt-${attempt}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
      : tempDir("downloads", `${Date.now()}-${Math.random().toString(16).slice(2)}-attempt-${attempt}`);
    fs.mkdirSync(downloadDir, { recursive: true });
    try {
      const download = await query(input.submitId, downloadDir, 120);
      const downloadOutput = outputText(download);
      const file = findNewestFile(downloadDir, "video");
      const url = parseDreaminaTaskOutput(downloadOutput, input.submitId).videoUrl || input.fallbackUrl;
      const candidate = file || (url ? await downloadUrl(url, downloadDir) : undefined);
      if (!candidate) throw new Error("Dreamina task succeeded, but no downloadable video file or URL was returned");

      const result = await validateFile(candidate);
      diagnostics.push(`download attempt ${attempt}: accepted ${result.bytes} bytes from ${file ? "CLI file" : "official URL"}`);
      dreaminaLog.info("Dreamina video download validated", {
        event: "video.download.validated",
        submitId: input.submitId,
        attempt,
        bytes: result.bytes,
        source: file ? "cli_file" : "official_url",
      });
      return {
        file: candidate,
        rawOutput: `${downloadOutput}\n----- download integrity -----\n${diagnostics.join("\n")}`.trim(),
      };
    } catch (error) {
      const reason = compactDownloadError(error);
      diagnostics.push(`download attempt ${attempt}: rejected (${reason})`);
      dreaminaLog.warn("Dreamina video download rejected", {
        event: "video.download.rejected",
        submitId: input.submitId,
        attempt,
        message: reason,
      });
      await fs.promises.rm(downloadDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const diagnosticText = diagnostics.join("\n");
  throw new DreaminaVideoDownloadError(
    `Dreamina video result download remained incomplete after ${DREAMINA_VIDEO_DOWNLOAD_ATTEMPTS} attempts; the existing task will be polled again without regeneration. ${diagnosticText}`,
    diagnosticText,
  );
}

function dreaminaLogDir() {
  return path.join(os.homedir(), ".dreamina_cli", "logs");
}

function snapshotLogOffsets() {
  const offsets = new Map<string, number>();
  const dir = dreaminaLogDir();
  if (!fs.existsSync(dir)) return offsets;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    try {
      offsets.set(file, fs.statSync(file).size);
    } catch {}
  }
  return offsets;
}

function readLogDelta(offsets: Map<string, number>) {
  const dir = dreaminaLogDir();
  if (!fs.existsSync(dir)) return "";
  const chunks: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    try {
      const content = fs.readFileSync(file);
      const start = Math.min(offsets.get(file) || 0, content.length);
      if (content.length > start) chunks.push(content.subarray(start).toString("utf8"));
    } catch {}
  }
  return chunks.join("\n").slice(-128 * 1024);
}

async function runRawWithLogs(args: string[], timeoutMs: number) {
  const offsets = snapshotLogOffsets();
  const result = await runRaw(args, timeoutMs);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const logs = readLogDelta(offsets);
  if (logs || result.stdout || result.stderr) {
    const command = args[0] || "unknown";
    const diagnosticFile = writeDiagnosticFile(
      `${command}-${result.code ?? "unknown"}`,
      [
        `command: dreamina ${args.join(" ")}`,
        `code: ${result.code}`,
        "----- stdout -----",
        result.stdout,
        "----- stderr -----",
        result.stderr,
        "----- cli logs -----",
        logs,
      ].join("\n"),
      { provider: "dreamina", event: "command.diagnostic", model: args.find((arg) => arg.startsWith("--model_version=")) },
    );
    dreaminaLog.info("Dreamina CLI diagnostic captured", {
      event: "command.diagnostic",
      command,
      code: result.code,
      diagnosticFile,
      stdoutBytes: Buffer.byteLength(result.stdout || ""),
      stderrBytes: Buffer.byteLength(result.stderr || ""),
      logBytes: Buffer.byteLength(logs || ""),
    });
  }
  return {
    ...result,
    result,
    logs,
  };
}

export interface DreaminaRemoteEvidence {
  confirmed: boolean;
  officialTaskId?: string;
  historyRecordId?: string;
  providerAccountId?: string;
}

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractJsonValues(output: string) {
  const values: unknown[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const candidate = value.trim();
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    try {
      values.push(JSON.parse(candidate));
    } catch {}
  };
  add(output);
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const char = output[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        add(output.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return values;
}

function collectMatchingSubmitRecords(output: string, submitId: string) {
  const matches: JsonRecord[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isJsonRecord(value)) return;
    const valueSubmitId = value.submit_id ?? value.submitId;
    if (String(valueSubmitId || "") === submitId) matches.push(value);
    Object.values(value).forEach(visit);
  };
  extractJsonValues(output).forEach(visit);
  return matches;
}

function findNestedValue(records: JsonRecord[], names: Set<string>) {
  let result: unknown;
  const visit = (value: unknown) => {
    if (result !== undefined) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isJsonRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (names.has(key.toLowerCase()) && child !== undefined && child !== null && child !== "") {
        result = child;
        return;
      }
      visit(child);
    }
  };
  records.forEach(visit);
  return result;
}

function parseStructuredQueueInfo(records: JsonRecord[]): DreaminaQueueInfo {
  const numberValue = (names: string[]) => {
    const value = findNestedValue(records, new Set(names));
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  };
  return {
    status: numberValue(["queue_status"]),
    index: numberValue(["queue_idx"]),
    length: numberValue(["queue_length"]),
  };
}

function extractStructuredVideoUrl(records: JsonRecord[]) {
  let result: string | undefined;
  const visit = (value: unknown, pathParts: string[] = []) => {
    if (result) return;
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, pathParts));
      return;
    }
    if (!isJsonRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const pathText = [...pathParts, key].join(".").toLowerCase();
      if (
        typeof child === "string" &&
        /^https?:\/\//i.test(child) &&
        (/^video_?url$/i.test(key) || /^download_?url$/i.test(key) || (key.toLowerCase() === "url" && pathText.includes("video")))
      ) {
        result = child;
        return;
      }
      visit(child, [...pathParts, key]);
    }
  };
  records.forEach((record) => visit(record));
  return result;
}

export interface DreaminaTaskOutput {
  status: "unknown" | "generating" | "success" | "failed";
  evidence: DreaminaRemoteEvidence;
  queueInfo: DreaminaQueueInfo;
  providerCode?: string;
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
  failureReason?: string;
}

function extractStructuredMediaUrl(records: JsonRecord[], type: DreaminaMediaType) {
  let result: string | undefined;
  const extension =
    type === "image" ? /\.(png|jpe?g|webp)(\?|$)/i : type === "video" ? /\.(mp4|mov|webm)(\?|$)/i : /\.(mp3|wav|m4a|aac|flac|ogg)(\?|$)/i;
  const typeText = type.toLowerCase();
  const musicKeyPattern = /^(audio|music|song|track)_?url$/i;
  const visit = (value: unknown, pathParts: string[] = []) => {
    if (result) return;
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, pathParts));
      return;
    }
    if (!isJsonRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const pathText = [...pathParts, key].join(".").toLowerCase();
      if (
        typeof child === "string" &&
        /^https?:\/\//i.test(child) &&
        (new RegExp(`^${typeText}_?url$`, "i").test(key) ||
          (type === "music" && musicKeyPattern.test(key)) ||
          /^download_?url$/i.test(key) ||
          (key.toLowerCase() === "url" && (pathText.includes(typeText) || (type === "music" && /audio|music|song|track/.test(pathText)) || extension.test(child))))
      ) {
        result = child;
        return;
      }
      visit(child, [...pathParts, key]);
    }
  };
  records.forEach((record) => visit(record));
  return result;
}

export function parseDreaminaTaskOutput(output: string, submitId: string): DreaminaTaskOutput {
  const records = collectMatchingSubmitRecords(output, submitId);
  const queueInfo = parseStructuredQueueInfo(records);
  const historyRecordId = findNestedValue(records, new Set(["history_record_id", "historyrecordid"]));
  const officialTaskId = findNestedValue(records, new Set(["task_id", "taskid"]));
  const providerAccountId = findNestedValue(records, new Set(["user_id", "uid"]));
  const statusValues = records.flatMap((record) => {
    const values: string[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!isJsonRecord(value)) return;
      for (const [key, child] of Object.entries(value)) {
        if (["gen_status", "task_status", "status"].includes(key.toLowerCase()) && typeof child === "string") {
          values.push(child.toLowerCase());
        }
        visit(child);
      }
    };
    visit(record);
    return values;
  });
  const failureReason = findNestedValue(records, new Set(["fail_reason", "error_reason", "error_message", "message"]));
  let status: DreaminaTaskOutput["status"] = "unknown";
  if (failureReason || statusValues.some((value) => /failed|fail|error|cancelled|canceled/.test(value))) status = "failed";
  else if (statusValues.some((value) => /success|succeeded|done|completed/.test(value)) || queueInfo.status === 3) status = "success";
  else if (
    statusValues.some((value) => /querying|running|processing|pending|queue|queued|waiting|submitted/.test(value)) ||
    queueInfo.status === 1 ||
    queueInfo.status === 2
  ) {
    status = "generating";
  }
  return {
    status,
    evidence: {
      confirmed: Boolean(historyRecordId || officialTaskId || queueInfo.status !== undefined),
      historyRecordId: historyRecordId === undefined ? undefined : String(historyRecordId),
      officialTaskId: officialTaskId === undefined ? undefined : String(officialTaskId),
      providerAccountId: providerAccountId === undefined ? undefined : String(providerAccountId),
    },
    queueInfo,
    providerCode: parseDreaminaProviderCode(records.map((record) => JSON.stringify(record)).join("\n")),
    imageUrl: extractStructuredMediaUrl(records, "image"),
    videoUrl: extractStructuredMediaUrl(records, "video") || extractStructuredVideoUrl(records),
    audioUrl: extractStructuredMediaUrl(records, "music"),
    failureReason: failureReason === undefined ? undefined : normalizeError(String(failureReason)),
  };
}

export function parseDreaminaImagePollOutput(output: string, submitId: string) {
  const task = parseDreaminaTaskOutput(output, submitId);
  const normalized = task.status === "unknown" ? normalizeTaskOutputStatus(output) : task.status;
  return {
    status: normalized,
    evidence: task.evidence,
    queueInfo: task.queueInfo,
    providerCode: task.providerCode,
    imageUrl: task.imageUrl,
    errorReason: task.failureReason,
  };
}

export function parseDreaminaRemoteEvidence(output: string, submitId: string): DreaminaRemoteEvidence {
  const structured = parseDreaminaTaskOutput(output, submitId).evidence;
  if (structured.confirmed) return structured;
  const relevant = output.includes(submitId) ? output : "";
  const acceptedByLog =
    /\[MCP\.Generate\][^\r\n]*ret=0/i.test(relevant) &&
    /\[SubmitTask\][^\r\n]*submit generation task finished/i.test(relevant);
  return {
    ...structured,
    confirmed: acceptedByLog,
  };
}

export function parseDreaminaProviderCode(output: string) {
  if (isDreaminaCapacityLimit(output)) return "1310";
  const values = [
    ...[...output.matchAll(/\bret[=:]\s*(-?\d+)/gi)].map((match) => match[1]),
    ...[...output.matchAll(/"ret"\s*:\s*(-?\d+)/gi)].map((match) => match[1]),
    ...[...output.matchAll(/\bcode[=:]\s*(-?\d+)/gi)].map((match) => match[1]),
  ];
  return values.at(-1);
}

export function isDreaminaCapacityLimit(output: string) {
  return /ExceedConcurrencyLimit/i.test(output) || /\bret[=:]\s*1310\b/i.test(output) || /"ret"\s*:\s*1310\b/i.test(output);
}

export function parseDreaminaQueueInfo(output: string): DreaminaQueueInfo {
  const queueInfoText = output.match(/"queue_info"\s*:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/i)?.[1] || "";
  const readNumber = (name: string) => {
    const value = queueInfoText.match(new RegExp(`"${name}"\\s*:\\s*(-?\\d+)`, "i"))?.[1];
    return value === undefined ? undefined : Number(value);
  };
  return {
    status: readNumber("queue_status"),
    index: readNumber("queue_idx"),
    length: readNumber("queue_length"),
  };
}

export function normalizeTaskOutputStatus(output: string) {
  const lower = output.toLowerCase();
  if (/gen_status["'\s:=]+(?:failed|fail|error)|"gen_status"\s*:\s*"(?:failed|fail|error)"/i.test(output)) return "failed";
  if (/"fail_reason"\s*:\s*"(?!\s*")[^"]+"/i.test(output)) return "failed";
  if (/(?:task_status|status)["'\s:=]+(?:failed|fail|cancelled|canceled)/i.test(output)) return "failed";
  if (/(?:任务|生成).{0,16}(?:失败|已取消)|\b(?:cancelled|canceled)\b/i.test(output)) return "failed";
  if (/gen_status["'\s:=]+(?:success|succeeded|done|completed)|"gen_status"\s*:\s*"(?:success|succeeded|done|completed)"/i.test(output)) return "success";
  if (/(?:success|succeeded|completed|done|已完成|成功)/i.test(output) && extractUrl(output, "video")) return "success";
  if (/(?:querying|running|processing|pending|queue|queued|waiting|submitted|排队|处理中|生成中|等待)/i.test(lower)) return "generating";
  return "unknown";
}

function extractFailureReason(output: string) {
  const line =
    output
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => /(error|failed|failure|reason|失败|错误|原因)/i.test(item)) || output;
  return normalizeError(line.slice(0, 1000));
}

const VIDEO_SUBMIT_FAILURE_PATTERN =
  /(execute submit failed|upload file failed|upload result contains error|ApplyImageUpload|bad gateway|upload resource|request to backend service failed)/i;

export function getDreaminaVideoSubmitFailureReason(rawOutput: string, exitCode?: number | null) {
  const hasSubmitFailure = VIDEO_SUBMIT_FAILURE_PATTERN.test(rawOutput);
  if (!hasSubmitFailure && (exitCode === undefined || exitCode === null || exitCode === 0)) return undefined;

  const lines = rawOutput
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const matchedLine =
    lines.find((item) => VIDEO_SUBMIT_FAILURE_PATTERN.test(item)) ||
    lines.find((item) => /err=<Error:|Error:/i.test(item)) ||
    "";
  const errorMatch =
    matchedLine.match(/err=<Error:\s*([^>]+)>/i) ||
    matchedLine.match(/Error:\s*([^\r\n]+)/i);
  let reason = normalizeError((errorMatch?.[1] || matchedLine || extractFailureReason(rawOutput)).slice(0, 1000));
  reason = reason
    .replace(/^.*upload resource\s+"[^"]+":\s*/i, "")
    .replace(/^.*upload file failed\s+/i, "")
    .replace(/^.*execute submit failed\s*/i, "")
    .replace(/^.*upload result contains error\s*/i, "")
    .trim();
  if (/bad gateway/i.test(rawOutput) && !/bad gateway/i.test(reason)) {
    reason = reason ? `${reason}; bad gateway` : "bad gateway";
  }
  if (hasSubmitFailure) {
    return `参考图上传到即梦失败：${reason || "供应商上传服务异常"}`;
  }
  return reason || `即梦 CLI 提交失败${exitCode === undefined || exitCode === null ? "" : `，退出码 ${exitCode}`}`;
}

export function buildVideoArgs(config: VideoConfig, model: ToonflowModel) {
  const { command, modelVersion } = parseModelName(model.modelName);
  const refs = writeReferenceFileItems(config.referenceList || [], "media");
  const args = [...flag("prompt", config.prompt)];

  if (command === "text2video") {
    args.push(...flag("duration", config.duration), ...flag("ratio", config.aspectRatio), ...flag("video_resolution", config.resolution || "720p"), ...flag("model_version", modelVersion));
  } else if (command === "image2video") {
    const image = refs.find((ref) => ref.type === "image");
    if (!image) throw new Error("即梦图生视频需要一张参考图。");
    args.push(...flag("image", image.filePath), ...flag("duration", config.duration), ...flag("video_resolution", config.resolution || "720p"), ...flag("model_version", modelVersion));
  } else if (command === "multiframe2video") {
    const images = refs.filter((ref) => ref.type === "image").map((ref) => ref.filePath);
    if (images.length < 2) throw new Error("即梦多帧视频需要至少两张参考图。");
    args.push(...flag("images", images.join(",")), ...flag("duration", config.duration), ...flag("model_version", modelVersion));
  } else if (command === "multimodal2video") {
    const images = refs.filter((ref) => ref.type === "image");
    const videos = refs.filter((ref) => ref.type === "video");
    const audios = refs.filter((ref) => ref.type === "audio");
    if (!images.length && !videos.length && !audios.length) throw new Error("即梦多模态视频需要至少一个图片、视频或音频参考素材。");
    for (const ref of images.slice(0, 9)) args.push(...flag("image", ref.filePath));
    for (const ref of videos.slice(0, 3)) args.push(...flag("video", ref.filePath));
    for (const ref of audios.slice(0, 3)) args.push(...flag("audio", ref.filePath));
    args.push(...flag("duration", config.duration), ...flag("ratio", config.aspectRatio), ...flag("video_resolution", config.resolution || "720p"), ...flag("model_version", modelVersion));
  } else {
    throw new Error(`不支持的即梦视频命令: ${command}`);
  }
  return { command, args };
}

async function videoSubmit(config: VideoConfig, model: ToonflowModel): Promise<DreaminaSubmitResult> {
  const { command, args } = buildVideoArgs(config, model);
  if (!COMMANDS.includes(command as any) || !command.endsWith("video")) throw new Error(`不支持的即梦视频命令: ${command}`);
  const submit = await runRawWithLogs([command, ...args, "--poll=0"], 180000);
  const submitOutput = outputText(submit.result);
  const rawSubmit = `${submitOutput}\n----- cli logs (diagnostic only) -----\n${submit.logs}`.trim();
  const providerCode = parseDreaminaProviderCode(submitOutput);
  const providerAccountId =
    submitOutput.match(/\buser_id[=:]\s*([A-Za-z0-9_-]+)/i)?.[1] ||
    submitOutput.match(/\buid[=:]\s*([A-Za-z0-9_-]+)/i)?.[1];
  if (isDreaminaCapacityLimit(submitOutput)) {
    return {
      state: "capacity_wait",
      rawOutput: rawSubmit,
      providerAccountId,
      providerCode: providerCode || "1310",
    };
  }
  const submitId = extractSubmitId(submitOutput);
  const submitFailureReason = getDreaminaVideoSubmitFailureReason(rawSubmit, submit.code);
  if (submitFailureReason && submitId) {
    return {
      state: "failed",
      submitId,
      rawOutput: rawSubmit,
      errorReason: submitFailureReason,
      providerAccountId,
      providerCode,
    };
  }
  if (submitFailureReason) {
    throw new Error(`${submitFailureReason}\n${rawSubmit}`.trim());
  }
  if (!submitId) {
    const message = submit.code === 0 ? "即梦 CLI 未返回 submit_id，无法进入异步轮询。" : cliFailureMessage(submit, `即梦 CLI 退出码 ${submit.code}`);
    throw new Error(`${message}\n${rawSubmit}`.trim());
  }
  const evidence = parseDreaminaRemoteEvidence(submitOutput, submitId);
  return {
    state: "submitted",
    submitId,
    confirmed: evidence.confirmed,
    rawOutput: rawSubmit,
    officialTaskId: evidence.officialTaskId,
    historyRecordId: evidence.historyRecordId,
    providerAccountId: evidence.providerAccountId || providerAccountId,
    providerCode,
  };
}

async function queryVideoTask(submitId: string): Promise<DreaminaPollResult> {
  const query = await runRawWithLogs(["query_result", `--submit_id=${submitId}`], 90000);
  const queryOutput = outputText(query.result);
  const queryTask = parseDreaminaTaskOutput(queryOutput, submitId);
  let rawOutput = `${queryOutput}\n----- query_result cli logs (diagnostic only) -----\n${query.logs}`.trim();
  let listOutput = "";
  let listTask: DreaminaTaskOutput | undefined;

  if (queryTask.status !== "success" && queryTask.status !== "failed") {
    const list = await runRawWithLogs(["list_task", `--submit_id=${submitId}`], 60000);
    listOutput = outputText(list.result);
    listTask = parseDreaminaTaskOutput(listOutput, submitId);
    rawOutput =
      `${rawOutput}\n----- list_task stdout/stderr -----\n${listOutput}\n----- list_task cli logs (diagnostic only) -----\n${list.logs}`.trim();
  }
  const evidence: DreaminaRemoteEvidence = {
    confirmed: queryTask.evidence.confirmed || Boolean(listTask?.evidence.confirmed),
    officialTaskId: queryTask.evidence.officialTaskId || listTask?.evidence.officialTaskId,
    historyRecordId: queryTask.evidence.historyRecordId || listTask?.evidence.historyRecordId,
    providerAccountId: queryTask.evidence.providerAccountId || listTask?.evidence.providerAccountId,
  };
  const queueInfo =
    listTask?.queueInfo.status !== undefined || listTask?.queueInfo.index !== undefined
      ? listTask.queueInfo
      : queryTask.queueInfo;
  const providerCode = queryTask.providerCode || listTask?.providerCode;
  const status =
    queryTask.status === "failed" || listTask?.status === "failed"
      ? "failed"
      : queryTask.status === "success" || listTask?.status === "success"
        ? "success"
        : "generating";
  const semanticOutput = `${queryOutput}\n${listOutput}`.trim();

  if (status === "failed") {
    return {
      state: "failed",
      rawOutput,
      errorReason: extractFailureReason(semanticOutput),
      providerAccountId: evidence.providerAccountId,
      providerCode,
      evidence,
      queueInfo,
    };
  }

  if (status !== "success") {
    return {
      state: "generating",
      rawOutput,
      providerAccountId: evidence.providerAccountId,
      providerCode,
      evidence,
      queueInfo,
    };
  }

  const downloaded = await retrieveValidatedDreaminaVideo({ submitId, fallbackUrl: queryTask.videoUrl });
  rawOutput = `${rawOutput}\n----- query_result download stdout/stderr -----\n${downloaded.rawOutput}`.trim();
  return {
    state: "success",
    data: downloaded.file,
    dataType: "file",
    rawOutput,
    providerAccountId: evidence.providerAccountId,
    providerCode,
    evidence,
    queueInfo,
  };
}

async function videoConfirm(submitId: string) {
  return queryVideoTask(submitId);
}

async function videoPoll(submitId: string) {
  return queryVideoTask(submitId);
}

function hasSupportedFlag(model: ToonflowModel, flagName: string) {
  const flags = model.supportedFlags;
  if (!Array.isArray(flags) || flags.length === 0) return true;
  return flags.includes(flagName);
}

function firstSupportedFlag(model: ToonflowModel, candidates: string[]) {
  return candidates.find((name) => hasSupportedFlag(model, name));
}

export function buildMusicArgs(config: MusicConfig, model: ToonflowModel) {
  const { command, modelVersion } = parseModelName(model.modelName);
  if (!MUSIC_COMMAND_CANDIDATES.includes(command as any)) throw new Error(`Unsupported Dreamina music command: ${command}`);
  const refs = writeReferenceFileItems(config.referenceList || [], "music");
  const args = [...flag("prompt", config.prompt)];
  if (modelVersion && hasSupportedFlag(model, "model_version")) args.push(...flag("model_version", modelVersion));

  const duration = Number(config.durationSec ?? config.duration ?? 0);
  const durationFlag = firstSupportedFlag(model, ["duration", "duration_sec", "seconds"]);
  if (duration > 0 && durationFlag) args.push(...flag(durationFlag, Math.round(duration)));

  if (config.lyrics && hasSupportedFlag(model, "lyrics")) args.push(...flag("lyrics", config.lyrics));
  if (config.vocalMode && hasSupportedFlag(model, "vocal_mode")) args.push(...flag("vocal_mode", config.vocalMode));
  if (config.negativePrompt && hasSupportedFlag(model, "negative_prompt")) args.push(...flag("negative_prompt", config.negativePrompt));
  if (config.outputFormat && hasSupportedFlag(model, "output_format")) args.push(...flag("output_format", config.outputFormat));
  if (config.seed != null && hasSupportedFlag(model, "seed")) args.push(...flag("seed", config.seed));

  const audioFlag = firstSupportedFlag(model, ["audio", "reference_audio", "ref_audio"]);
  if (audioFlag) {
    for (const ref of refs.filter((item) => item.type === "audio").slice(0, 3)) args.push(...flag(audioFlag, ref.filePath));
  }
  return { command, args };
}

async function musicSubmit(config: MusicConfig, model: ToonflowModel): Promise<DreaminaSubmitResult> {
  const { command, args } = buildMusicArgs(config, model);
  const submit = await runRawWithLogs([command, ...args, "--poll=0"], 180000);
  const submitOutput = outputText(submit.result);
  const rawSubmit = `${submitOutput}\n----- cli logs (diagnostic only) -----\n${submit.logs}`.trim();
  const providerCode = parseDreaminaProviderCode(submitOutput);
  const providerAccountId =
    submitOutput.match(/\buser_id[=:]\s*([A-Za-z0-9_-]+)/i)?.[1] ||
    submitOutput.match(/\buid[=:]\s*([A-Za-z0-9_-]+)/i)?.[1];
  if (isDreaminaCapacityLimit(submitOutput)) {
    return {
      state: "capacity_wait",
      rawOutput: rawSubmit,
      providerAccountId,
      providerCode: providerCode || "1310",
    };
  }
  const submitId = extractSubmitId(submitOutput);
  if (!submitId) {
    const message = submit.code === 0 ? "Dreamina CLI did not return submit_id for music generation." : cliFailureMessage(submit, `Dreamina CLI exited with code ${submit.code}`);
    throw new Error(`${message}\n${rawSubmit}`.trim());
  }
  const evidence = parseDreaminaRemoteEvidence(submitOutput, submitId);
  return {
    state: "submitted",
    submitId,
    confirmed: evidence.confirmed,
    rawOutput: rawSubmit,
    officialTaskId: evidence.officialTaskId,
    historyRecordId: evidence.historyRecordId,
    providerAccountId: evidence.providerAccountId || providerAccountId,
    providerCode,
  };
}

async function queryMusicTask(submitId: string): Promise<DreaminaPollResult> {
  const query = await runRawWithLogs(["query_result", `--submit_id=${submitId}`], 90000);
  const queryOutput = outputText(query.result);
  const queryTask = parseDreaminaTaskOutput(queryOutput, submitId);
  let rawOutput = `${queryOutput}\n----- query_result cli logs (diagnostic only) -----\n${query.logs}`.trim();
  let listOutput = "";
  let listTask: DreaminaTaskOutput | undefined;

  if (queryTask.status !== "success" && queryTask.status !== "failed") {
    const list = await runRawWithLogs(["list_task", `--submit_id=${submitId}`], 60000);
    listOutput = outputText(list.result);
    listTask = parseDreaminaTaskOutput(listOutput, submitId);
    rawOutput =
      `${rawOutput}\n----- list_task stdout/stderr -----\n${listOutput}\n----- list_task cli logs (diagnostic only) -----\n${list.logs}`.trim();
  }
  const evidence: DreaminaRemoteEvidence = {
    confirmed: queryTask.evidence.confirmed || Boolean(listTask?.evidence.confirmed),
    officialTaskId: queryTask.evidence.officialTaskId || listTask?.evidence.officialTaskId,
    historyRecordId: queryTask.evidence.historyRecordId || listTask?.evidence.historyRecordId,
    providerAccountId: queryTask.evidence.providerAccountId || listTask?.evidence.providerAccountId,
  };
  const queueInfo =
    listTask?.queueInfo.status !== undefined || listTask?.queueInfo.index !== undefined
      ? listTask.queueInfo
      : queryTask.queueInfo;
  const providerCode = queryTask.providerCode || listTask?.providerCode;
  const status =
    queryTask.status === "failed" || listTask?.status === "failed"
      ? "failed"
      : queryTask.status === "success" || listTask?.status === "success"
        ? "success"
        : "generating";
  const semanticOutput = `${queryOutput}\n${listOutput}`.trim();

  if (status === "failed") {
    return {
      state: "failed",
      rawOutput,
      errorReason: extractFailureReason(semanticOutput),
      providerAccountId: evidence.providerAccountId,
      providerCode,
      evidence,
      queueInfo,
    };
  }
  if (status !== "success") {
    return {
      state: "generating",
      rawOutput,
      providerAccountId: evidence.providerAccountId,
      providerCode,
      evidence,
      queueInfo,
    };
  }

  const downloadDir = tempDir("downloads", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const download = await queryResult(submitId, downloadDir, 120);
  const downloadOutput = outputText(download);
  rawOutput = `${rawOutput}\n----- query_result download stdout/stderr -----\n${downloadOutput}`.trim();
  const file = findNewestFile(downloadDir, "music");
  if (file) {
    return {
      state: "success",
      data: file,
      dataType: "file",
      rawOutput,
      providerAccountId: evidence.providerAccountId,
      providerCode,
      evidence,
      queueInfo,
    };
  }
  const parsedDownload = parseDreaminaTaskOutput(downloadOutput, submitId);
  const url = parsedDownload.audioUrl || queryTask.audioUrl || listTask?.audioUrl || extractUrl(`${queryOutput}\n${listOutput}\n${downloadOutput}`, "music");
  if (url) {
    return {
      state: "success",
      data: url,
      dataType: "url",
      rawOutput,
      providerAccountId: evidence.providerAccountId,
      providerCode,
      evidence,
      queueInfo,
    };
  }
  return {
    state: "failed",
    rawOutput,
    errorReason: "Dreamina music task succeeded, but no downloadable audio file was found.",
    providerCode,
    evidence,
    queueInfo,
  };
}

async function musicRequest(config: MusicConfig, model: ToonflowModel) {
  const queueConfig = normalizeQueueConfig(model.queueConfig, 1);
  const submit = await musicSubmit(config, model);
  if (submit.state === "capacity_wait") throw new Error("Dreamina music capacity is currently full; please retry later.");
  if (!submit.submitId) throw new Error("Dreamina CLI did not return submit_id.");
  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, queueConfig.pollInitialDelaySec * 1000));
  while (Date.now() - startedAt < queueConfig.maxWorkHours * 60 * 60 * 1000) {
    const poll = await queryMusicTask(submit.submitId);
    if (poll.state === "failed") throw new Error(poll.errorReason || poll.rawOutput || "Dreamina music generation failed");
    if (poll.state === "success" && poll.data) {
      return poll.dataType === "file" ? fileToDataUrl(poll.data) : poll.data;
    }
    const interval = Math.max(queueConfig.pollMinIntervalSec, Math.min(queueConfig.pollMaxIntervalSec, queueConfig.pollMinIntervalSec));
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }
  throw new Error(`Dreamina music task timed out, submit_id=${submit.submitId}`);
}

function getQueueKey(command: string, args: string[]) {
  const modelArg = args.find((arg) => arg.startsWith("--model_version="))?.slice("--model_version=".length) || "default";
  return `${command}:${modelArg || "default"}`;
}

function getQueueLimit(command: string, modelName: string) {
  const lower = `${command}:${modelName}`.toLowerCase();
  if (/seedance\s*2|seedance2|2\.0|multimodal/.test(lower)) return 1;
  if (command.includes("video")) return 1;
  return 2;
}

function defaultVideoQueueConfig(maxConcurrent = 1): NormalizedQueueConfig {
  return {
    maxConcurrent,
    pollInitialDelaySec: 20,
    pollMinIntervalSec: 20,
    pollMaxIntervalSec: 60,
    maxWorkHours: 6,
    maxWaitHours: 6,
  };
}

export function normalizeQueueConfig(config?: QueueConfig, fallbackMaxConcurrent = 1): NormalizedQueueConfig {
  const maxWorkHours = Math.max(1, Math.min(72, Number(config?.maxWorkHours ?? config?.maxWaitHours ?? 6)));
  return {
    maxConcurrent: Math.max(1, Math.min(20, Number(config?.maxConcurrent || fallbackMaxConcurrent))),
    pollInitialDelaySec: Math.max(0, Math.min(3600, Number(config?.pollInitialDelaySec ?? 20))),
    pollMinIntervalSec: Math.max(15, Math.min(3600, Number(config?.pollMinIntervalSec ?? 20))),
    pollMaxIntervalSec: Math.max(30, Math.min(7200, Number(config?.pollMaxIntervalSec ?? 60))),
    maxWorkHours,
    maxWaitHours: maxWorkHours,
  };
}

async function enqueue<T>(key: string, limit: number, fn: () => Promise<T>): Promise<T> {
  const state = queueState.get(key) || { running: 0, waiting: 0, limit };
  state.limit = limit;
  state.waiting += 1;
  queueState.set(key, state);

  while ((queueState.get(key)?.running || 0) >= limit) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  state.waiting = Math.max(0, state.waiting - 1);
  state.running += 1;
  queueState.set(key, state);
  try {
    return await fn();
  } finally {
    state.running = Math.max(0, state.running - 1);
    queueState.set(key, state);
  }
}

async function runGeneration(command: string, args: string[], type: "image" | "video") {
  if (!ALLOWED_COMMANDS.has(command) || !COMMANDS.includes(command as any)) throw new Error(`不支持的即梦生成命令: ${command}`);
  const modelArg = args.find((arg) => arg.startsWith("--model_version="))?.slice("--model_version=".length) || "default";
  const queueKey = getQueueKey(command, args);
  const limit = getQueueLimit(command, modelArg);
  return enqueue(queueKey, limit, async () => {
  const downloadDir = tempDir("downloads", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const submit = await run([command, ...args, "--poll=30"], 180000);
  let output = `${submit.stdout}\n${submit.stderr}`;
  let file = findNewestFile(downloadDir, type);
  const submitId = extractSubmitId(output);

  if (!file && submitId) {
    const query = await queryResult(submitId, downloadDir, 180);
    output += `\n${query.stdout}\n${query.stderr}`;
    file = findNewestFile(downloadDir, type);
  }

  if (file) return fileToDataUrl(file);
  const url = extractUrl(output, type);
  if (url) return url;
  throw new Error(normalizeError(output || "即梦生成完成但未找到输出文件。"));
  });
}

export function buildImageArgs(config: ImageConfig, model: ToonflowModel) {
  const { command, modelVersion } = parseModelName(model.modelName);
  const refs = writeReferenceFiles(config.referenceList || [], "image");
  const args = [
    ...flag("prompt", config.prompt),
    ...flag("ratio", config.aspectRatio),
    ...flag("resolution_type", qualityToResolution(config.size)),
    ...flag("model_version", modelVersion),
  ];

  if (command === "image2image") {
    if (!refs.length) throw new Error("即梦图生图需要至少一张参考图。");
    args.push(...flag("images", refs.join(",")));
  }
  return { command, args };
}

async function imageSubmit(config: ImageConfig, model: ToonflowModel) {
  const { command, args } = buildImageArgs(config, model);
  if (!COMMANDS.includes(command as any) || !command.endsWith("image")) throw new Error(`涓嶆敮鎸佺殑鍗虫ⅵ鍥剧墖鍛戒护: ${command}`);
  const submit = await runRawWithLogs([command, ...args, "--poll=0"], 180000);
  const submitOutput = outputText(submit.result);
  const rawSubmit = `${submitOutput}\n----- cli logs (diagnostic only) -----\n${submit.logs}`.trim();
  const providerCode = parseDreaminaProviderCode(submitOutput);
  if (isDreaminaCapacityLimit(submitOutput)) {
    throw new Error("Dreamina image capacity is currently full; please retry later.");
  }
  const submitId = extractSubmitId(submitOutput);
  if (!submitId) {
    const message =
      submit.code === 0
        ? "Dreamina CLI did not return submit_id for image generation."
        : cliFailureMessage(submit.result, `Dreamina CLI exited with code ${submit.code}`);
    throw new Error(`${message}\n${rawSubmit}`.trim());
  }
  return {
    providerTaskId: submitId,
    taskId: submitId,
    pollIntervalMs: 30000,
    providerCode,
  };
}

async function imagePoll(submitId: string) {
  const downloadDir = tempDir("downloads", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const query = await runRawWithLogs(["query_result", `--submit_id=${submitId}`, `--download_dir=${downloadDir}`], 90000);
  const queryOutput = outputText(query.result);
  const rawOutput = `${queryOutput}\n----- query_result cli logs (diagnostic only) -----\n${query.logs}`.trim();
  const parsed = parseDreaminaImagePollOutput(queryOutput, submitId);
  const file = findNewestFile(downloadDir, "image");
  if (file) {
    return {
      completed: true,
      data: fileToDataUrl(file),
      progress: 100,
    };
  }
  if (parsed.imageUrl) {
    return {
      completed: true,
      data: parsed.imageUrl,
      progress: 100,
    };
  }
  if (parsed.status === "failed" || (query.code !== 0 && parsed.status !== "generating")) {
    return {
      completed: true,
      error: parsed.errorReason || cliFailureMessage(query.result, "Dreamina image generation failed."),
    };
  }
  if (parsed.status === "success") {
    return {
      completed: true,
      error: "Dreamina image task succeeded, but no downloadable image was found.",
    };
  }
  return {
    completed: false,
    nextPollMs: 30000,
    progress: 50,
    rawOutput,
  };
}

async function imageRequest(config: ImageConfig, model: ToonflowModel) {
  const submit = await imageSubmit(config, model);
  const submitId = submit.providerTaskId;
  const startedAt = Date.now();
  const timeoutMs = Math.min(normalizeQueueConfig(model.queueConfig, 1).maxWorkHours * 60 * 60 * 1000, 30 * 60 * 1000);
  if (!submitId) throw new Error("Dreamina CLI did not return submit_id for image generation.");

  while (Date.now() - startedAt < timeoutMs) {
    const poll = await imagePoll(submitId);
    if (poll.completed) {
      if (poll.error) throw new Error(poll.error);
      if (!poll.data) throw new Error("Dreamina image generation completed without image data.");
      return poll.data;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(1000, Number(poll.nextPollMs || submit.pollIntervalMs || 30000))));
  }
  throw new Error(`Dreamina image task timed out, submit_id=${submitId}`);
}

async function videoRequest(config: VideoConfig, model: ToonflowModel) {
  const queueConfig = normalizeQueueConfig(model.queueConfig, 1);
  const submit = await videoSubmit(config, model);
  if (submit.state === "capacity_wait") {
    throw new Error("即梦当前模型并发槽位已满，请稍后重试。");
  }
  if (!submit.submitId) throw new Error("即梦 CLI 未返回 submit_id。");
  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, queueConfig.pollInitialDelaySec * 1000));

  while (Date.now() - startedAt < queueConfig.maxWorkHours * 60 * 60 * 1000) {
    const poll = await videoPoll(submit.submitId);
    if (poll.state === "success" && poll.data) {
      return poll.dataType === "file" ? fileToDataUrl(poll.data) : poll.data;
    }
    if (poll.state === "failed") throw new Error(poll.errorReason || poll.rawOutput || "即梦视频生成失败");
    await new Promise((resolve) => setTimeout(resolve, queueConfig.pollMinIntervalSec * 1000));
  }
  throw new Error(`即梦视频任务工作超过 ${queueConfig.maxWorkHours} 小时，submit_id=${submit.submitId}`);
}

function cleanModelToken(value: string) {
  return value
    .trim()
    .replace(/^["'`]+|["'`,，。；;]+$/g, "")
    .replace(/[，。；;]$/g, "");
}

function splitSupportedValues(text: string) {
  return text
    .split(/[,，;；]|\s+or\s+/i)
    .map((value) => cleanModelToken(value))
    .filter((value) => value && !/^(default|omit|all|other|models?|supported|values?|by|model)$/i.test(value));
}

function extractFlagValues(help: string, flagName: string) {
  const values = new Set<string>();
  const lines = help.split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes(`--${flagName}`)) continue;
    const supported = line.match(/supported values(?: by model)?\s*:\s*([^;\n]+)/i)?.[1];
    if (supported) splitSupportedValues(supported).forEach((value) => values.add(value));
  }
  return [...values];
}

export function extractSupportedFlags(help: string) {
  const flags = new Set<string>();
  for (const match of help.matchAll(/--([A-Za-z][A-Za-z0-9_-]*)/g)) {
    flags.add(match[1]);
  }
  return [...flags];
}

export function discoverMusicCommandsFromHelp(help: string) {
  const available = new Set<string>();
  for (const candidate of MUSIC_COMMAND_CANDIDATES) {
    const pattern = new RegExp(`(^|\\s)${candidate}(\\s|$)`, "m");
    if (pattern.test(help)) available.add(candidate);
  }
  return [...available];
}

export function extractMusicDurationRange(help: string) {
  const durations = new Set<number>();
  const durationLines = help
    .split(/\r?\n/)
    .filter((line) => /duration|duration_sec|seconds|\u65f6\u957f|\u79d2/i.test(line));
  for (const line of durationLines) {
    for (const match of line.matchAll(/(\d+)\s*(?:-|~|to|\u81f3)\s*(\d+)\s*(?:s|sec|secs|second|seconds|\u79d2)?/gi)) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (Number.isFinite(start) && start > 0 && start <= 600) durations.add(start);
      if (Number.isFinite(end) && end > 0 && end <= 600) durations.add(end);
    }
    const supported = line.match(/supported values(?: by model)?\s*:\s*([^;\n]+)/i)?.[1];
    if (supported) {
      for (const value of supported.matchAll(/\d+/g)) {
        const parsed = Number(value[0]);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 600) durations.add(parsed);
      }
    }
  }
  if (!durations.size) return undefined;
  const values = [...durations];
  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function canonicalModelVersion(value: string) {
  return cleanModelToken(value).toLowerCase().replace(/^(\d+(?:\.\d+)?)_(fast|pro)$/i, "$1$2");
}

function extractModelVersions(help: string) {
  const values = new Set<string>();
  const lines = help.split(/\r?\n/);
  for (const line of lines) {
    const fromCombination = line.match(/-\s*(?:advanced\s+)?model_version(?: values)?\s*:\s*([^\n]+)/i)?.[1];
    const fromFlag = line.includes("--model_version") ? line.match(/supported values\s*:\s*([^;\n]+)/i)?.[1] : undefined;
    const raw = fromCombination || fromFlag;
    if (!raw) continue;
    for (const value of splitSupportedValues(raw)) {
      const canonical = canonicalModelVersion(value);
      if (/^\d+(?:\.\d+)?(?:fast|pro)?$/i.test(canonical) || /^seed(?:ance|music)[\w.-]+$/i.test(canonical)) values.add(canonical);
    }
  }
  return [...values];
}

function inferDisplayName(id: string) {
  if (id === "default") return "默认模型（由 CLI 决定）";
  if (/^\d/.test(id)) return `即梦 ${id}`;
  if (id.startsWith("seedmusic")) {
    return id
      .replace(/^seedmusic/i, "SeedMusic ")
      .replace(/1\.0/i, "1.0")
      .replace(/preview/i, "Preview");
  }
  if (id.startsWith("seedance")) {
    return id
      .replace(/^seedance/i, "Seedance ")
      .replace(/2\.0fast_vip/i, "2.0 Fast VIP")
      .replace(/2\.0mini/i, "2.0 Mini")
      .replace(/2\.0_vip/i, "2.0 VIP")
      .replace(/2\.0fast/i, "2.0 Fast");
  }
  return id
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/\b(seedream|seedance|wan|dreamina)\b/gi, (m) => m[0].toUpperCase() + m.slice(1).toLowerCase());
}

function findLineMeta(help: string, modelId: string): Omit<ModelMeta, "id" | "displayName"> {
  const lines = help.split(/\r?\n/);
  const matched = lines.find((line) => modelId !== "default" && line.toLowerCase().includes(modelId.toLowerCase())) || "";
  const cost =
    matched.match(/(?:费用|消耗|价格|cost|credit|积分|点数)[：:\s]*([^，,；;\n]+)/i)?.[1]?.trim() ||
    matched.match(/(\d+(?:\.\d+)?\s*(?:积分|点|credits?|credit|元|¥|￥|tokens?))/i)?.[1]?.trim();
  const queue = matched.match(/(排队[^，,；;\n]*|queue[^，,；;\n]*|capacity[^，,；;\n]*|限流[^，,；;\n]*|并发[^，,；;\n]*)/i)?.[1]?.trim();
  const concurrencyText = matched.match(/(?:并发|concurrency|concurrent)[^\d]*(\d+)/i)?.[1];
  const concurrency = concurrencyText ? Number(concurrencyText) : undefined;
  return {
    cost,
    queue,
    concurrency: Number.isFinite(concurrency) ? concurrency : undefined,
  };
}

function extractModelMetas(help: string): ModelMeta[] {
  const ids = new Set(extractModelVersions(help));

  return [...ids].map((id) => {
    const meta = findLineMeta(help, id);
    return {
      id,
      displayName: inferDisplayName(id),
      ...meta,
    };
  });
}

function describeMeta(command: string, meta: ModelMeta, video: boolean) {
  const parts = [
    `命令: ${command}`,
    `模型版本: ${meta.id === "default" ? "CLI 默认" : meta.id}`,
    `费用: ${meta.cost || "CLI help 未提供费用，提交前请以即梦账号页/余额变化为准"}`,
    `排队/并发: ${meta.queue || (video ? "视频任务本地按 1 并发排队提交，避免触发平台限制" : "图片任务本地默认最多 2 并发提交")}`,
  ];
  if (meta.concurrency) parts.push(`CLI 提示并发: ${meta.concurrency}`);
  if (/seedance\s*2|seedance2|2\.0|multimodal/i.test(`${command}:${meta.id}`)) parts.push("提示: Seedance 2.0/多模态类模型通常更容易排队，已按 1 并发保护。");
  return parts.join("；");
}

function extractDurations(help: string) {
  const values = new Set<number>();
  for (const line of help.split(/\r?\n/)) {
    if (!/duration/i.test(line)) continue;
    for (const match of line.matchAll(/(\d+)\s*-\s*(\d+)\s*s?/gi)) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        for (let i = start; i <= end && i <= 30; i++) values.add(i);
      }
    }
  }
  for (const value of extractFlagValues(help, "duration")) {
    const n = Number(value.replace(/s$/i, ""));
    if (Number.isFinite(n) && n > 0 && n <= 30) values.add(n);
  }
  return values.size ? [...values] : [5];
}

function extractResolutions(help: string, video: boolean) {
  const values = new Set<string>();
  const key = video ? /video_resolution|resolution/i : /resolution_type|resolution/i;
  for (const line of help.split(/\r?\n/)) {
    if (!key.test(line)) continue;
    for (const match of line.matchAll(/\b(\d+)([kp])\b/gi)) {
      const unit = match[2].toLowerCase();
      values.add(unit === "k" ? `${match[1]}K` : `${match[1]}p`);
    }
  }
  return values.size ? [...values] : video ? ["720p"] : ["1K", "2K"];
}

export function getDreaminaVideoResolutions(help: string, modelName: string) {
  const normalized = normalizeDreaminaModelVersion(modelName.includes(":") ? modelName : `video:${modelName}`);
  if (normalized === "seedance2.0mini") return ["720p"];
  const resolutions = new Set(extractResolutions(help, true));
  if (normalized === "seedance2.0_vip") {
    resolutions.add("720p");
    resolutions.add("1080p");
    resolutions.add("4K");
  }
  return [...resolutions];
}

export function discoverDreaminaMediaModels(command: (typeof MEDIA_COMMANDS)[number], help: string): ToonflowModel[] {
  const models: ToonflowModel[] = [];
  const commandModels = extractModelMetas(help);
  const modelValues = commandModels.length ? commandModels : [{ id: "default", displayName: "默认模型（由 CLI 决定）" }];
  const isImage = command.endsWith("image");
  for (const modelMeta of modelValues) {
    const modelValue = modelMeta.id;
    const label = modelMeta.displayName;
    if (isImage) {
      models.push({
        name: `即梦 ${command} · ${label}`,
        modelName: `${command}:${modelValue}`,
        type: "image",
        mode: command === "text2image" ? ["text"] : ["singleImage", "multiReference"],
        associationSkills: describeMeta(command, modelMeta, false),
      });
      continue;
    }
    const mode =
      command === "text2video"
        ? ["text"]
        : command === "image2video"
          ? ["singleImage"]
          : command === "multiframe2video"
            ? ["startFrameOptional", ["imageReference:9"]]
            : ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]];
    models.push({
      name: `即梦 ${command} · ${label}`,
      modelName: `${command}:${modelValue}`,
      type: "video",
      mode,
      associationSkills: describeMeta(command, modelMeta, true),
      audio: command === "multimodal2video" ? "optional" : false,
      durationResolutionMap: [{ duration: extractDurations(help), resolution: getDreaminaVideoResolutions(help, modelValue) }],
      queueConfig: defaultVideoQueueConfig(modelMeta.concurrency || 1),
    });
  }
  return models;
}

export function discoverDreaminaMusicModels(command: string, help: string): ToonflowModel[] {
  const supportedFlags = extractSupportedFlags(help);
  const commandModels = extractModelMetas(help);
  const modelValues = commandModels.length ? commandModels : [{ id: "default", displayName: "SeedMusic" }];
  return modelValues.map((modelMeta) => ({
    name: `Dreamina ${command} - ${modelMeta.displayName}`,
    modelName: `${command}:${modelMeta.id}`,
    type: "music" as const,
    associationSkills: `${describeMeta(command, modelMeta, false)}; type: music`,
    durationRange: extractMusicDurationRange(help),
    durationParameter: ["duration", "duration_sec", "seconds"].some((flagName) => supportedFlags.includes(flagName)),
    outputFormats: [...new Set([...extractFlagValues(help, "output_format"), ...extractFlagValues(help, "format")])],
    vocal: supportedFlags.includes("vocal_mode") || supportedFlags.includes("lyrics") ? "optional" as const : false,
    lyrics: supportedFlags.includes("lyrics") ? "optional" as const : false,
    referenceAudio: supportedFlags.some((flagName) => ["audio", "reference_audio", "ref_audio"].includes(flagName)) ? "optional" as const : false,
    loop: supportedFlags.includes("loop") ? "optional" as const : false,
    supportedFlags,
    queueConfig: defaultVideoQueueConfig(modelMeta.concurrency || 1),
  }));
}

async function discoverModels() {
  ensureInstalled();
  const models: ToonflowModel[] = [];
  let rootHelp = "";
  try {
    const root = await run(["-h"], 30000);
    rootHelp = `${root.stdout}\n${root.stderr}`;
  } catch {}
  for (const command of MEDIA_COMMANDS) {
    let help = "";
    try {
      const result = await run([command, "-h"], 30000);
      help = `${result.stdout}\n${result.stderr}`;
    } catch (err) {
      help = "";
    }
    models.push(...discoverDreaminaMediaModels(command, help));
  }
  const musicCommands = discoverMusicCommandsFromHelp(rootHelp);
  for (const command of musicCommands) {
    let help = "";
    try {
      const result = await run([command, "-h"], 30000);
      if (result.code !== 0) continue;
      help = `${result.stdout}\n${result.stderr}`;
    } catch {
      continue;
    }
    models.push(...discoverDreaminaMusicModels(command, help));
  }
  return models;
}

async function refreshModels() {
  const models = await discoverModels();
  return models;
}

async function status() {
  const installed = isInstalled();
  const latest = installed ? await fetchLatestVersion() : null;
  let helpOk = false;
  let help = "";
  let musicCommands: string[] = [];
  let login = currentLogin ? { ...currentLogin } : null;
  if (installed) {
    try {
      const result = await run(["-h"], 30000);
      helpOk = result.code === 0;
      help = result.stdout || result.stderr;
      musicCommands = discoverMusicCommandsFromHelp(help);
    } catch (err) {
      help = normalizeError((err as Error).message);
    }
    if (!login || login.state === "success" || login.state === "failed") {
      try {
        const validation = await validateLoginState();
        login = {
          id: login?.id ?? "credential",
          state: validation.ok ? "success" : "failed",
          message: validation.message,
          stdout: "",
          stderr: "",
          startTime: login?.startTime ?? Date.now(),
          endTime: Date.now(),
        };
      } catch (err) {
        login = {
          id: login?.id ?? "credential",
          state: "failed",
          message: normalizeError((err as Error).message),
          stdout: "",
          stderr: "",
          startTime: login?.startTime ?? Date.now(),
          endTime: Date.now(),
        };
      }
    }
  }
  return {
    installed,
    executablePath: cliPath(),
    installDir: cliDir(),
    meta: readMeta(),
    latest,
    helpOk,
    help,
    musicAvailable: musicCommands.length > 0,
    musicCommands,
    musicUnavailableReason:
      installed && musicCommands.length === 0
        ? "\u5f53\u524d\u5373\u68a6 CLI \u672a\u66b4\u9732\u97f3\u4e50\u751f\u6210\u547d\u4ee4\uff0c\u8bf7\u66f4\u65b0\u5373\u68a6 CLI \u540e\u5237\u65b0\u6a21\u578b\u3002"
        : undefined,
    login,
    queue: getQueueStatus(),
  };
}

function getQueueStatus() {
  return [...queueState.entries()].map(([key, value]) => ({ key, ...value }));
}

async function logout() {
  return run(["logout"], 60000);
}

async function userCredit() {
  const result = await run(["user_credit"], 60000);
  return {
    raw: `${result.stdout}\n${result.stderr}`.trim(),
  };
}

async function listTask(args: string[] = []) {
  const result = await run(["list_task", ...args], 60000);
  return {
    raw: `${result.stdout}\n${result.stderr}`.trim(),
  };
}

async function queryTask(submitId: string, download = false) {
  const downloadDir = tempDir("manual-query", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const args = ["query_result", `--submit_id=${submitId}`];
  if (download) args.push(`--download_dir=${downloadDir}`);
  const result = await run(args, 180000);
  return {
    raw: `${result.stdout}\n${result.stderr}`.trim(),
    downloadDir,
  };
}

export default {
  install,
  update: () => install(true),
  uninstall,
  status,
  login,
  logout,
  userCredit,
  listTask,
  queryTask,
  refreshModels,
  getQueueStatus,
  imageRequest,
  imageSubmit,
  imagePoll,
  videoRequest,
  videoSubmit,
  videoConfirm,
  videoPoll,
  musicRequest,
  getDreaminaProviderModelKey,
  normalizeQueueConfig,
  getActiveCliProcesses,
  run,
};
