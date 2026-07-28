import fs from "node:fs/promises";
import path from "node:path";
import u from "@/utils";

export type MusicDownloadTargetType = "libraryVersion" | "cueAsset";

export interface MusicDownloadAsset {
  filePath: string;
  localPath: string;
  size: number;
  mimeType: string;
  filename: string;
}

const AUDIO_MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
};

function safeFilename(value: unknown, fallback: string) {
  const filename = path.basename(String(value || "").replace(/[\\/]+/g, "_"))
    .replace(/[\r\n\0]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .trim();
  return filename || fallback;
}

export function musicDownloadContentDisposition(filename: string) {
  const asciiFallback = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .trim() || "music-download";
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function resolveMusicDownloadAsset(input: {
  projectId: number;
  targetType: MusicDownloadTargetType;
  targetId: number;
}): Promise<MusicDownloadAsset> {
  const sourceTable = input.targetType === "libraryVersion" ? "o_musicLibraryVersion" : "o_musicCueAsset";
  const target = await u.db(sourceTable).where({ projectId: input.projectId, id: input.targetId }).first();
  if (!target) throw new Error(input.targetType === "libraryVersion" ? "Music library version does not exist" : "Music cue asset does not exist");
  if (target.state !== "complete") throw new Error("Only completed music audio can be downloaded");
  if (!target.childAssetId) throw new Error("Music audio asset does not exist");

  const childAsset = await u.db("o_assets").where({
    id: target.childAssetId,
    projectId: input.projectId,
    type: "audio",
  }).first();
  if (!childAsset?.imageId) throw new Error("Music audio asset does not exist");
  if (target.assetsId != null && childAsset.assetsId !== target.assetsId) throw new Error("Music audio asset is invalid");

  const media = await u.db("o_image").where({
    id: childAsset.imageId,
    assetsId: childAsset.id,
    type: "audio",
    state: "complete",
  }).first();
  if (!media?.filePath) throw new Error("Music audio file does not exist");

  let localPath: string;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    localPath = await u.oss.getLocalFilePath(media.filePath);
    stat = await fs.stat(localPath);
  } catch {
    throw new Error("Music audio file does not exist");
  }
  if (!stat.isFile()) throw new Error("Music audio file does not exist");
  const extension = path.extname(media.filePath).toLowerCase();
  const fallback = `music-${input.targetType}-${input.targetId}${extension || ".audio"}`;
  return {
    filePath: media.filePath,
    localPath,
    size: stat.size,
    mimeType: AUDIO_MIME_TYPES[extension] || "application/octet-stream",
    filename: safeFilename(childAsset.name, fallback),
  };
}
