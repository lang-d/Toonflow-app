import path from "node:path";
import oss from "@/utils/oss";
import replaceUrl from "@/utils/replaceUrl";
import { RUNTIME_API_HOST, RUNTIME_API_PORT } from "@/runtime/runtimeProtocol";

export type MediaRefType = "image" | "video" | "audio" | "file";
export type MediaRefSource = "storyboard" | "assets" | "merged" | "local" | "generated" | "directorAsset";

export interface MediaRef {
  id?: number | string;
  type: MediaRefType;
  path: string;
  url: string;
  previewUrl?: string;
  mime?: string;
  name?: string;
  width?: number;
  height?: number;
  duration?: number;
  source?: MediaRefSource;
  sourceId?: number | string;
}

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".svg", ".ico"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);
const AUDIO_EXT = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".aiff", ".aif"]);

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
};

export function normalizeMediaPath(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) return "";
  const withoutQuery = input.trim().split("?")[0];
  return replaceUrl(withoutQuery)
    .replace(/\\/g, "/")
    .replace(/^\/?(oss|smallImage)\//i, "");
}

export function inferMediaType(input: string): MediaRefType {
  const ext = path.extname(normalizeMediaPath(input)).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return "file";
}

export function mediaMime(input: string): string | undefined {
  return MIME_BY_EXT[path.extname(normalizeMediaPath(input)).toLowerCase()];
}

export function publicFileUrl(userRelPath: string, prefix = "oss"): string {
  const safePath = normalizeMediaPath(userRelPath).split(path.sep).join("/");
  const base = `http://${RUNTIME_API_HOST}:${RUNTIME_API_PORT}/${prefix}/`;
  return `${base}${safePath}`;
}

export function isMediaLike(input: unknown): input is string {
  if (typeof input !== "string" || !input.trim()) return false;
  const value = input.trim();
  if (/^data:/i.test(value)) return false;
  if (/^https?:\/\//i.test(value) && !/^https?:\/\/[^/]+\/(oss|assets|skills)\//i.test(value)) return false;
  const normalized = normalizeMediaPath(value);
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  if (lower.includes("/smallimage/") || lower.startsWith("smallimage/")) return true;
  if (/^https?:\/\/[^/]+\/(oss|assets|skills)\//i.test(value)) return true;
  if (/^\/?(oss|assets|skills)\//i.test(value)) return true;
  const ext = path.extname(lower);
  return IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext);
}

export async function toMediaRef(
  input: unknown,
  options: {
    id?: number | string;
    type?: MediaRefType;
    source?: MediaRefSource;
    sourceId?: number | string;
    name?: string;
    preview?: boolean;
  } = {},
): Promise<MediaRef | null> {
  const mediaPath = normalizeMediaPath(input);
  if (!mediaPath) return null;
  const type = options.type || inferMediaType(mediaPath);
  const ref: MediaRef = {
    type,
    path: mediaPath,
    url: await oss.getFileUrl(mediaPath),
    mime: mediaMime(mediaPath),
  };
  if (options.id != null) ref.id = options.id;
  if (options.source) ref.source = options.source;
  if (options.sourceId != null) ref.sourceId = options.sourceId;
  if (options.name) ref.name = options.name;
  if (options.preview !== false && (type === "image" || type === "video")) {
    ref.previewUrl = type === "image" ? await oss.getSmallImageUrl(mediaPath) : ref.url;
  }
  return ref;
}

export function toMediaRefSync(
  input: unknown,
  options: {
    id?: number | string;
    type?: MediaRefType;
    source?: MediaRefSource;
    sourceId?: number | string;
    name?: string;
    preview?: boolean;
  } = {},
): MediaRef | null {
  const mediaPath = normalizeMediaPath(input);
  if (!mediaPath) return null;
  const type = options.type || inferMediaType(mediaPath);
  const ref: MediaRef = {
    type,
    path: mediaPath,
    url: publicFileUrl(mediaPath),
    mime: mediaMime(mediaPath),
  };
  if (options.id != null) ref.id = options.id;
  if (options.source) ref.source = options.source;
  if (options.sourceId != null) ref.sourceId = options.sourceId;
  if (options.name) ref.name = options.name;
  if (options.preview !== false && (type === "image" || type === "video")) {
    ref.previewUrl = type === "image" ? `${publicFileUrl(mediaPath)}?size=20` : ref.url;
  }
  return ref;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function isEmptyLegacyMediaValue(value: unknown): boolean {
  return value == null || (typeof value === "string" && !value.trim());
}

function looksLikeMediaRef(value: Record<string, unknown>) {
  return typeof value.path === "string" && typeof value.url === "string" && typeof value.type === "string";
}

async function legacyValueToMedia(
  value: unknown,
  source?: MediaRefSource,
  sourceId?: number | string,
): Promise<MediaRef | null> {
  if (!isMediaLike(value)) return null;
  return toMediaRef(value, { source, sourceId });
}

export async function normalizeMediaResponse<T>(value: T): Promise<T> {
  if (Array.isArray(value)) {
    return (await Promise.all(value.map((item) => normalizeMediaResponse(item)))) as T;
  }
  if (!isPlainObject(value) || looksLikeMediaRef(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    output[key] = await normalizeMediaResponse(raw);
  }

  const source = typeof output.source === "string" ? (output.source as MediaRefSource) : undefined;
  const sourceId = (output.sourceId ?? output.id) as number | string | undefined;

  const primaryMedia =
    (await legacyValueToMedia(value.filePath, source, sourceId)) ||
    (await legacyValueToMedia(value.fileUrl, source, sourceId)) ||
    (await legacyValueToMedia(value.src, source, sourceId)) ||
    (await legacyValueToMedia(value.imageUrl, source, sourceId)) ||
    (await legacyValueToMedia(value.image, source, sourceId)) ||
    (await legacyValueToMedia(value.avatar, source, sourceId)) ||
    (await legacyValueToMedia(value.bigImageUrl, source, sourceId));
  if (primaryMedia) {
    output.media = primaryMedia;
    delete output.filePath;
    delete output.fileUrl;
    delete output.src;
    delete output.imageUrl;
    delete output.image;
    delete output.avatar;
    delete output.bigImageUrl;
  }
  for (const key of ["filePath", "fileUrl", "src", "imageUrl", "image", "avatar", "bigImageUrl", "displayUrl"] as const) {
    if (Object.prototype.hasOwnProperty.call(value, key) && isEmptyLegacyMediaValue(value[key])) {
      delete output[key];
    }
  }

  const generatedMedia = await legacyValueToMedia(value.generatedImage, "generated", sourceId);
  if (generatedMedia) {
    output.resultMedia = generatedMedia;
    delete output.generatedImage;
  }
  if (Object.prototype.hasOwnProperty.call(value, "generatedImage") && isEmptyLegacyMediaValue(value.generatedImage)) {
    delete output.generatedImage;
  }

  const selectedMedia = await legacyValueToMedia(value.selectedImageUrl, source, sourceId);
  if (selectedMedia) {
    output.selectedMedia = selectedMedia;
    delete output.selectedImageUrl;
  }
  if (Object.prototype.hasOwnProperty.call(value, "selectedImageUrl") && isEmptyLegacyMediaValue(value.selectedImageUrl)) {
    delete output.selectedImageUrl;
  }

  const previewMedia = await legacyValueToMedia(value.previewImage);
  if (previewMedia) {
    const media = isPlainObject(output.media) ? { ...output.media } : null;
    if (media) {
      media.previewUrl = previewMedia.previewUrl || previewMedia.url;
      output.media = media;
    } else {
      output.previewMedia = previewMedia;
    }
    delete output.previewImage;
  }
  if (Object.prototype.hasOwnProperty.call(value, "previewImage") && isEmptyLegacyMediaValue(value.previewImage)) {
    delete output.previewImage;
  }

  if (Array.isArray(output.historyImages)) {
    output.historyMediaList = output.historyImages;
    delete output.historyImages;
  }

  if (isPlainObject(output.result)) {
    const result = { ...output.result };
    const resultUrlMedia = await legacyValueToMedia(result.url);
    if (resultUrlMedia) {
      result.media = resultUrlMedia;
      delete result.url;
    }
    output.result = result;
  }

  const urlMedia = await legacyValueToMedia(value.url);
  if (urlMedia && !output.media && !("verification_url" in output)) {
    output.media = urlMedia;
    delete output.url;
  }

  return output as T;
}

export function normalizeTaskResultSync(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return value;
  const result = { ...value };
  const media = toMediaRefSync(result.url);
  if (media) {
    result.media = media;
    delete result.url;
  }
  return result;
}
