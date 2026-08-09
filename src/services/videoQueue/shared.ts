import fs from "node:fs/promises";
import path from "node:path";
import type { ReferenceList } from "@/utils/ai";
import getPath from "@/utils/getPath";
import {
  resolveQueuedWorkbenchReferences,
  type ResolvedLocalWorkbenchReference,
} from "@/services/workbenchReference";
import type { ResolvedVideoReference, StoredVideoRequest, VideoQueueRow } from "./contracts";

export const VIDEO_RAW_OUTPUT_LIMIT = 32 * 1024;
export const VIDEO_CAPACITY_RETRY_MS = 90_000;

export function truncateVideoDiagnostic(value?: string | null) {
  if (!value) return "";
  return value.length > VIDEO_RAW_OUTPUT_LIMIT ? value.slice(-VIDEO_RAW_OUTPUT_LIMIT) : value;
}

export function mergeVideoDiagnostics(previous?: string | null, current?: string | null) {
  if (!previous) return truncateVideoDiagnostic(current);
  if (!current) return truncateVideoDiagnostic(previous);
  if (previous.includes(current)) return truncateVideoDiagnostic(previous);
  if (current.includes(previous)) return truncateVideoDiagnostic(current);
  return truncateVideoDiagnostic(`${previous}\n----- latest provider diagnostic -----\n${current}`);
}

export function summarizeVideoError(value: string) {
  if (value.length <= 4096) return value;
  const firstLine = value.split(/\r?\n/, 1)[0].slice(0, 1024);
  return `${firstLine}\n\nDiagnostic tail:\n${value.slice(-3000)}`;
}

export function parseVideoModelKey(model: string) {
  const [vendorId, modelName] = model.split(/:(.+)/);
  return { vendorId, modelName };
}

export function scopedVideoProviderCapacityKey(vendorId: string, modelKey: string) {
  const vendor = String(vendorId || "legacy");
  const key = String(modelKey || "unknown");
  return key.startsWith(`${vendor}:`) ? key : `${vendor}:${key}`;
}

export function videoCapacityRetryAt(now = Date.now()) {
  return now + VIDEO_CAPACITY_RETRY_MS + Math.floor(Math.random() * 15_001);
}

export function providerWorkElapsedMs(
  row: Pick<VideoQueueRow, "providerSubmittedAt" | "confirmStartedAt" | "remoteConfirmedAt">,
  now = Date.now(),
) {
  const submittedAt = Number(row.providerSubmittedAt || row.confirmStartedAt || row.remoteConfirmedAt || 0);
  return submittedAt > 0 ? Math.max(0, now - submittedAt) : 0;
}

export function isProviderWorkTimedOut(
  row: Pick<VideoQueueRow, "providerSubmittedAt" | "confirmStartedAt" | "remoteConfirmedAt">,
  maxWorkHours: number,
  now = Date.now(),
) {
  const elapsed = providerWorkElapsedMs(row, now);
  return elapsed > 0 && elapsed >= maxWorkHours * 60 * 60 * 1000;
}

export async function resolveVideoReferences(row: VideoQueueRow, request: StoredVideoRequest): Promise<ResolvedVideoReference[]> {
  if (request.references?.length) {
    const trackId = Number(request.relatedObjects?.trackId || 0) || undefined;
    const items = await resolveQueuedWorkbenchReferences(request.references, {
      projectId: row.projectId,
      scriptId: row.scriptId,
      trackId,
    });
    return items.map((item: ResolvedLocalWorkbenchReference) => ({
      type: item.fileType,
      filePath: item.localFilePath,
    }));
  }
  if (request.legacyReferences?.length) {
    for (const item of request.legacyReferences) {
      const stat = await fs.stat(item.filePath);
      if (!stat.isFile()) throw new Error(`Legacy video reference does not exist: ${item.filePath}`);
    }
    return request.legacyReferences;
  }
  return [];
}

function mimeFromPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
    ".gif": "image/gif", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
    ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg", ".aiff": "audio/aiff",
  } as Record<string, string>)[ext] || "application/octet-stream";
}

export async function toLegacyVideoReferences(items: ResolvedVideoReference[]) {
  const result: ReferenceList[] = [];
  for (const item of items) {
    const data = await fs.readFile(item.filePath);
    result.push({
      type: item.type,
      base64: `data:${mimeFromPath(item.filePath)};base64,${data.toString("base64")}`,
    } as ReferenceList);
  }
  return result;
}

export async function cleanupLegacyVideoReferences(row: VideoQueueRow) {
  try {
    const request = JSON.parse(row.requestJson || "{}") as StoredVideoRequest;
    const legacyRoot = getPath(["temp", "video-queue-legacy"]);
    const dirs = new Set(
      (request.legacyReferences || [])
        .map((item) => path.dirname(item.filePath))
        .filter((dir) => dir === legacyRoot || dir.startsWith(`${legacyRoot}${path.sep}`)),
    );
    await Promise.all([...dirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  } catch {
    // Compatibility cleanup must not change the task result.
  }
}
