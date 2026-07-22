import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const localRequire = createRequire(typeof __filename === "string" ? __filename : path.resolve(process.cwd(), "package.json"));

function unpackedExecutablePath(value: unknown) {
  const resolved = String(value || "").replace(/([\\/])app\.asar([\\/])/i, "$1app.asar.unpacked$2");
  if (!resolved || !fs.existsSync(resolved)) throw new Error("Audio metadata runtime is unavailable: packaged executable is missing");
  return resolved;
}

function ffprobePath() {
  const ffprobeModule = localRequire("ffprobe-static");
  return unpackedExecutablePath(ffprobeModule?.path || ffprobeModule);
}

export async function probeAudioDurationMs(filePath: string) {
  const { stdout } = await runFile(ffprobePath(), [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const seconds = Number(String(stdout).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Unable to read generated audio duration");
  return Math.round(seconds * 1000);
}

export async function inspectGeneratedMusicFile(input: {
  filePath: string;
  model: string;
  maxDurationSec?: number;
}) {
  const durationMs = await probeAudioDurationMs(input.filePath);
  const maxDurationSec = Number(input.maxDurationSec || 0);
  if (maxDurationSec > 0 && durationMs > maxDurationSec * 1000 + 1000) {
    throw new Error(
      `Music provider returned ${Math.ceil(durationMs / 1000)} seconds for ${input.model}, exceeding the declared maximum of ${maxDurationSec} seconds`,
    );
  }
  return {
    durationMs,
    durationSec: Math.max(1, Math.round(durationMs / 1000)),
  };
}
