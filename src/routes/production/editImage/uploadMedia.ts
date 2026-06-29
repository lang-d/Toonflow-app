import express from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

const AUDIO_EXT_BY_MIME: Record<string, string> = {
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/m4a": "m4a",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-m4a": "m4a",
  "audio/x-wav": "wav",
  "audio/aiff": "aiff",
  "audio/x-aiff": "aiff",
};

function parseAudioDataUrl(value: string) {
  const match = value.match(/^data:([^;]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new Error("音频数据格式无效");
  const mime = match[1].toLowerCase();
  if (!mime.startsWith("audio/")) throw new Error("仅支持音频媒体上传");
  const ext = AUDIO_EXT_BY_MIME[mime];
  if (!ext) throw new Error(`不支持的音频格式：${mime}`);
  return { mime, ext, buffer: Buffer.from(match[2].replace(/\s/g, ""), "base64") };
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    type: z.literal("audio"),
    base64Data: z.string(),
    name: z.string().optional(),
  }),
  async (req, res) => {
    try {
      const { projectId, scriptId, base64Data, name } = req.body;
      const parsed = parseAudioDataUrl(base64Data);
      const savePath = `/${projectId}/imageFlow/${scriptId}/media/${uuid()}.${parsed.ext}`;
      await u.oss.writeFile(savePath, parsed.buffer);
      const media = await u.mediaRef.toMediaRef(savePath, {
        id: u.mediaRef.normalizeMediaPath(savePath),
        type: "audio",
        source: "local",
        sourceId: u.mediaRef.normalizeMediaPath(savePath),
        name,
        preview: false,
      });
      if (!media) throw new Error("音频上传失败");
      media.previewUrl = media.url;
      media.mime = parsed.mime;
      res.status(200).send(success({ media }));
    } catch (cause) {
      res.status(400).send(error(u.error(cause).message));
    }
  },
);
