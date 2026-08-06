/**
 * Toonflow AI vendor: XLCSH Seedance 2
 * @version 2.0
 */

type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];

interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}

interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
}

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}

interface TTSModel {
  name: string;
  modelName: string;
  type: "tts";
  voices: { title: string; voice: string }[];
}

interface VendorConfig {
  id: string;
  version: string;
  name: string;
  author: string;
  description?: string;
  icon?: string;
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: (TextModel | ImageModel | VideoModel | TTSModel)[];
}

type ReferenceList =
  | { type: "image"; sourceType: "base64"; base64: string }
  | { type: "audio"; sourceType: "base64"; base64: string }
  | { type: "video"; sourceType: "base64"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
  referenceList?: Extract<ReferenceList, { type: "audio" }>[];
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

interface ParsedMedia {
  mimeType: string;
  buffer: any;
  bytes: number;
  extension: string;
}

declare const axios: any;
declare const Buffer: any;
declare const FormData: any;
declare const logger: (msg: string) => void;
declare const urlToBase64: (url: string) => Promise<string>;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t: boolean, tl: 0 | 1 | 2 | 3) => any;
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>;
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};

const DURATIONS = Array.from({ length: 60 }, (_, index) => index + 1);
const RESOLUTIONS = ["480p", "720p", "1080p", "4k"];
const MAX_IMAGE_COUNT = 9;
const MAX_AUDIO_COUNT = 3;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_BYTES = 12 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AUDIO_MIME_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4", "audio/aac", "audio/ogg", "audio/webm", "audio/flac"]);

const videoModel = (name: string, modelName: string): VideoModel => ({
  name,
  modelName,
  type: "video",
  mode: ["text", "singleImage", "startEndRequired", ["imageReference:9", "audioReference:3"]],
  associationSkills: "Seedance 2.0 text, keyframe, image-reference, and audio-reference video generation",
  audio: "optional",
  durationResolutionMap: [{ duration: DURATIONS, resolution: RESOLUTIONS }],
});

const vendor: VendorConfig = {
  id: "xlcsh",
  version: "2.0",
  author: "Toonflow",
  name: "XLCSH Seedance 2",
  description: "Seedance 2.0 video generation through the XLCSH task API.",
  inputs: [
    { key: "apiKey", label: "API Key", type: "password", required: true },
    { key: "baseUrl", label: "Base URL", type: "url", required: true, placeholder: "https://new.xlcsh.top/v1" },
  ],
  inputValues: { apiKey: "", baseUrl: "https://new.xlcsh.top/v1" },
  models: [
    videoModel("Seedance 2.0", "seedance-2.0"),
    videoModel("Seedance 2.0 Unlimited", "seedance-2.0-unlimited"),
    videoModel("Seedance 2.0 Mini", "seedance-2.0-mini"),
  ],
};

const getApiKey = (): string => {
  const apiKey = String(vendor.inputValues.apiKey || "").trim().replace(/^Bearer\s+/i, "");
  if (!apiKey) throw new Error("Missing API Key");
  return apiKey;
};

const getBaseUrl = (): string => {
  const baseUrl = String(vendor.inputValues.baseUrl || "https://new.xlcsh.top/v1").trim().replace(/\/+$/, "");
  return /\/v1$/i.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
};

const getHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${getApiKey()}`,
  Accept: "application/json",
});

const getErrorMessage = (error: any): string => String(
  error?.response?.data?.error?.message
  || error?.response?.data?.message
  || error?.message
  || "XLCSH Seedance 2 request failed",
);

const normalizeResolution = (value: string): string => {
  const resolution = String(value || "").toLowerCase();
  if (!RESOLUTIONS.includes(resolution)) throw new Error("XLCSH Seedance 2 supports 480p, 720p, 1080p, or 4k resolution");
  return resolution;
};

const getVideoSize = (resolution: string, aspectRatio: VideoConfig["aspectRatio"]): string => {
  const shortSide = { "480p": 480, "720p": 720, "1080p": 1080, "4k": 2160 }[resolution];
  const longSide = Math.round((shortSide * 16) / 9 / 2) * 2;
  return aspectRatio === "9:16" ? `${shortSide}x${longSide}` : `${longSide}x${shortSide}`;
};

const parseMediaDataUri = (value: string, kind: "image" | "audio"): ParsedMedia => {
  const match = String(value || "").match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new Error(`XLCSH Seedance 2 requires ${kind} Data URIs`);
  const mimeType = match[1].toLowerCase();
  const supported = kind === "image" ? IMAGE_MIME_TYPES : AUDIO_MIME_TYPES;
  if (!supported.has(mimeType)) throw new Error(`XLCSH Seedance 2 does not support ${kind} MIME type: ${mimeType}`);
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (buffer.length > MAX_FILE_BYTES) throw new Error("XLCSH Seedance 2 media files must not exceed 10 MiB each");
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1].replace(/^x-/, "");
  return { mimeType, buffer, bytes: buffer.length, extension };
};

const buildRequestFields = (config: VideoConfig, model: VideoModel) => {
  const prompt = String(config.prompt || "").trim();
  if (!prompt) throw new Error("Missing video prompt");
  const seconds = Number(config.duration);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error("XLCSH Seedance 2 supports video durations from 1 to 60 seconds");
  if (config.aspectRatio !== "16:9" && config.aspectRatio !== "9:16") throw new Error("XLCSH Seedance 2 supports 16:9 or 9:16 aspect ratios only");
  const resolution = normalizeResolution(config.resolution);
  return {
    model: model.modelName,
    prompt,
    seconds,
    size: getVideoSize(resolution, config.aspectRatio),
    aspect_ratio: config.aspectRatio,
    resolution,
    generate_audio: config.audio !== false,
    stream: false,
  };
};

const appendTextFields = (form: any, fields: Record<string, string | number | boolean>) => {
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
};

const buildVideoRequest = (config: VideoConfig, model: VideoModel) => {
  const fields = buildRequestFields(config, model);
  const references = config.referenceList || [];
  if (references.some((item) => item.type === "video")) throw new Error("XLCSH Seedance 2 does not support local video references");
  const imageRefs = references.filter((item) => item.type === "image");
  const audioRefs = references.filter((item) => item.type === "audio");
  if (imageRefs.length > MAX_IMAGE_COUNT) throw new Error("XLCSH Seedance 2 supports at most 9 images across keyframes and references");
  if (audioRefs.length > MAX_AUDIO_COUNT) throw new Error("XLCSH Seedance 2 supports at most 3 audio references");
  if (!imageRefs.length && !audioRefs.length) return { body: fields, headers: { ...getHeaders(), "Content-Type": "application/json" } };

  const images = imageRefs.map((item) => parseMediaDataUri(item.base64, "image"));
  const audios = audioRefs.map((item) => parseMediaDataUri(item.base64, "audio"));
  const mediaBytes = [...images, ...audios].reduce((total, item) => total + item.bytes, 0);
  if (mediaBytes > MAX_MULTIPART_BYTES) throw new Error("XLCSH Seedance 2 multipart media must not exceed 12 MiB in total");

  const form = new FormData();
  appendTextFields(form, fields);
  const startEnd = config.mode.includes("startEndRequired");
  const singleImage = config.mode.includes("singleImage");
  let imageIndex = 0;
  if (startEnd) {
    if (images.length < 2) throw new Error("XLCSH Seedance 2 start-end mode requires a start image and an end image");
    form.append("input_start_image", images[0].buffer, { filename: `start.${images[0].extension}`, contentType: images[0].mimeType });
    form.append("input_end_image", images[1].buffer, { filename: `end.${images[1].extension}`, contentType: images[1].mimeType });
    imageIndex = 2;
  } else if (singleImage && images.length) {
    form.append("input_start_image", images[0].buffer, { filename: `start.${images[0].extension}`, contentType: images[0].mimeType });
    imageIndex = 1;
  }
  for (const image of images.slice(imageIndex)) {
    form.append("input_reference", image.buffer, { filename: `reference.${image.extension}`, contentType: image.mimeType });
  }
  for (const audio of audios) {
    form.append("input_audio", audio.buffer, { filename: `reference.${audio.extension}`, contentType: audio.mimeType });
  }
  return { body: form, headers: { ...getHeaders(), ...form.getHeaders() } };
};

const taskIdFrom = (payload: any): string => String(payload?.id || payload?.task_id || "").trim();
const failureFrom = (payload: any): string => String(payload?.error?.message || payload?.message || "XLCSH Seedance 2 video generation failed");

const textRequest = (_model: TextModel, _think: boolean, _thinkLevel: 0 | 1 | 2 | 3) => {
  throw new Error("XLCSH Seedance 2 only provides video generation");
};

const imageRequest = async (_config: ImageConfig, _model: ImageModel): Promise<string> => {
  throw new Error("XLCSH Seedance 2 does not provide image generation");
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  logger(`Submitting XLCSH Seedance 2 video task: ${model.modelName}`);
  try {
    const request = buildVideoRequest(config, model);
    const created = await axios.post(`${getBaseUrl()}/videos`, request.body, { headers: request.headers, timeout: 900000 });
    const taskId = taskIdFrom(created.data);
    if (!taskId) throw new Error("XLCSH Seedance 2 video submission did not return a task ID");

    const result = await pollTask(
      async (): Promise<PollResult> => {
        const response = await axios.get(`${getBaseUrl()}/videos/${encodeURIComponent(taskId)}`, { headers: getHeaders(), timeout: 900000 });
        const status = String(response.data?.status || "").toLowerCase();
        if (status === "completed") {
          const url = String(response.data?.metadata?.url || "").trim();
          return url ? { completed: true, data: url } : { completed: true, error: "XLCSH Seedance 2 completed without a downloadable video URL" };
        }
        if (status === "failed") return { completed: true, error: failureFrom(response.data) };
        if (status === "queued" || status === "in_progress") return { completed: false };
        return { completed: true, error: `XLCSH Seedance 2 returned an unsupported task status: ${status || "missing"}` };
      },
      3000,
      30 * 60 * 1000,
    );
    if (result.error) throw new Error(result.error);
    if (!result.data) throw new Error("XLCSH Seedance 2 video generation failed: missing result");
    return await urlToBase64(result.data);
  } catch (error: any) {
    throw new Error(getErrorMessage(error));
  }
};

const ttsRequest = async (_config: TTSConfig, _model: TTSModel): Promise<string> => {
  throw new Error("XLCSH Seedance 2 does not provide text-to-speech");
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => ({
  hasUpdate: false,
  latestVersion: "2.0",
  notice: "XLCSH Seedance 2 vendor is up to date.",
});

const updateVendor = async (): Promise<string> => "";

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

export {};
