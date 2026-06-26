/**
 * Toonflow AI vendor: Agnes AI
 * @version 1.0
 */

// ============================================================
// Types
// ============================================================

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
  associationSkills?: string;
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

// ============================================================
// Globals
// ============================================================

declare const axios: any;
declare const logger: (msg: string) => void;
declare const jsonwebtoken: any;
declare const zipImage: (base64: string, size: number) => Promise<string>;
declare const zipImageResolution: (base64: string, w: number, h: number) => Promise<string>;
declare const mergeImages: (base64Arr: string[], maxSize?: string) => Promise<string>;
declare const urlToBase64: (url: string) => Promise<string>;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const createOpenAI: any;
declare const createDeepSeek: any;
declare const createZhipu: any;
declare const createQwen: any;
declare const createAnthropic: any;
declare const createOpenAICompatible: any;
declare const createXai: any;
declare const createMinimax: any;
declare const createGoogleGenerativeAI: any;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t: boolean, tl: 0 | 1 | 2 | 3) => any;
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>;
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};

// ============================================================
// Vendor config
// ============================================================

const vendor: VendorConfig = {
  id: "agnes",
  version: "1.0",
  author: "Toonflow",
  name: "Agnes AI",
  description:
    "## Agnes AI\n\nOpenAI-compatible multimodal API. Supports Agnes 2.0 Flash text, Agnes Image 2.1 Flash image generation/editing, and Agnes Video V2.0 text-to-video.",
  inputs: [
    { key: "apiKey", label: "API Key", type: "password", required: true },
    { key: "baseUrl", label: "Base URL", type: "url", required: true, placeholder: "https://apihub.agnes-ai.com/v1" },
  ],
  inputValues: { apiKey: "", baseUrl: "https://apihub.agnes-ai.com/v1" },
  models: [
    { name: "Agnes 2.0 Flash", modelName: "agnes-2.0-flash", type: "text", think: false },
    {
      name: "Agnes Image 2.1 Flash",
      modelName: "agnes-image-2.1-flash",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      associationSkills: "Text-to-image, image-to-image, multi-reference image generation",
    },
    {
      name: "Agnes Video V2.0",
      modelName: "agnes-video-v2.0",
      type: "video",
      mode: ["text"],
      associationSkills: "Text-to-video. Image-to-video is reserved until a public temporary image URL service is configured.",
      audio: false,
      durationResolutionMap: [
        { duration: [3, 5, 10, 18], resolution: ["480p", "720p", "1080p"] },
      ],
    },
  ],
};

// ============================================================
// Helpers
// ============================================================

const getApiKey = (): string => {
  if (!vendor.inputValues.apiKey) throw new Error("Missing API Key");
  return vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
};

const getBaseUrl = (): string => {
  const baseUrl = (vendor.inputValues.baseUrl || "https://apihub.agnes-ai.com/v1").replace(/\/+$/g, "");
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
};

const getRootBaseUrl = (): string => getBaseUrl().replace(/\/v1$/i, "");

const getHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${getApiKey()}`,
  "Content-Type": "application/json",
  Accept: "application/json",
});

const getErrorMessage = (err: any): string => {
  return err?.response?.data?.error?.message || err?.response?.data?.message || err?.response?.data?.msg || err?.message || "Request failed";
};

const ensureDataUri = (value: string): string => {
  if (!value) return value;
  return value.startsWith("data:") ? value : `data:image/png;base64,${value}`;
};

const getImageBase64FromResponse = (data: any): string => {
  return data?.data?.[0]?.b64_json || data?.data?.data?.[0]?.b64_json || data?.b64_json || "";
};

const getImageUrlFromResponse = (data: any): string => {
  return data?.data?.[0]?.url || data?.data?.data?.[0]?.url || data?.url || "";
};

const parseAspectRatio = (aspectRatio: string): { width: number; height: number } => {
  const [rawWidth, rawHeight] = String(aspectRatio || "1:1").split(":").map(Number);
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth <= 0 || rawHeight <= 0) {
    return { width: 1, height: 1 };
  }
  return { width: rawWidth, height: rawHeight };
};

const roundTo8 = (value: number): number => Math.max(512, Math.round(value / 8) * 8);

const getImageSize = (config: ImageConfig): string => {
  const ratio = parseAspectRatio(config.aspectRatio);
  const longEdge = config.size === "4K" ? 2048 : config.size === "2K" ? 1536 : 1024;
  if (ratio.width === ratio.height) return `${longEdge}x${longEdge}`;
  if (ratio.width > ratio.height) return `${longEdge}x${roundTo8((longEdge * ratio.height) / ratio.width)}`;
  return `${roundTo8((longEdge * ratio.width) / ratio.height)}x${longEdge}`;
};

const buildImageRequestBody = (config: ImageConfig, model: ImageModel): Record<string, any> => {
  if (!config.prompt) throw new Error("Missing image prompt");
  const imageRefs = (config.referenceList || []).map((item) => ensureDataUri(item.base64)).filter(Boolean).slice(0, 16);
  const body: Record<string, any> = {
    model: model.modelName,
    prompt: config.prompt,
    size: getImageSize(config),
  };
  if (imageRefs.length > 0) {
    body.image = imageRefs;
    body.extra_body = { response_format: "b64_json" };
  } else {
    body.return_base64 = true;
  }
  return body;
};

const getVideoDimensions = (config: VideoConfig): { width: number; height: number } => {
  const resolution = String(config.resolution || "720p").toLowerCase();
  const shortEdge = resolution.includes("1080") ? 1080 : resolution.includes("480") ? 480 : 720;
  if (config.aspectRatio === "9:16") return { width: shortEdge, height: Math.round((shortEdge * 16) / 9) };
  return { width: Math.round((shortEdge * 16) / 9), height: shortEdge };
};

const getVideoFrames = (duration: number): number => {
  const seconds = Number(duration || 5);
  if (seconds <= 3) return 81;
  if (seconds <= 5) return 121;
  if (seconds <= 10) return 241;
  return 441;
};

const buildAgnesVideoImages = (config: VideoConfig): string[] => {
  // Reserved for future image-to-video support. Agnes Video needs public image URLs,
  // while Toonflow references are local/base64 today.
  return [];
};

const getVideoTaskId = (data: any): string => {
  return String(data?.video_id || data?.task_id || data?.id || data?.data?.video_id || data?.data?.task_id || data?.data?.id || "");
};

const getVideoUrlFromResponse = (data: any): string => {
  return (
    data?.remixed_from_video_id ||
    data?.video_url ||
    data?.url ||
    data?.output?.video_url ||
    data?.output?.url ||
    data?.data?.remixed_from_video_id ||
    data?.data?.video_url ||
    data?.data?.url ||
    data?.data?.output?.video_url ||
    data?.data?.output?.url ||
    ""
  );
};

const getVideoStatus = (data: any): string => {
  return String(data?.status || data?.data?.status || data?.state || data?.data?.state || "").toLowerCase();
};

const getVideoError = (data: any): string => {
  return data?.error?.message || data?.error || data?.message || data?.data?.error?.message || data?.data?.error || data?.data?.message || "";
};

const buildVideoRequestBody = (config: VideoConfig, model: VideoModel): Record<string, any> => {
  if (!config.prompt) throw new Error("Missing video prompt");
  const dimensions = getVideoDimensions(config);
  const images = buildAgnesVideoImages(config);
  const body: Record<string, any> = {
    model: model.modelName,
    prompt: config.prompt,
    width: dimensions.width,
    height: dimensions.height,
    num_frames: getVideoFrames(config.duration),
    frame_rate: 24,
  };
  if (images.length > 0) {
    body.image = images.length === 1 ? images[0] : images;
    body.mode = images.length > 1 ? "keyframes" : "ti2vid";
    if (images.length > 1) body.extra_body = { image: images, mode: "keyframes" };
  }
  return body;
};

// ============================================================
// Adapter functions
// ============================================================

const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  const apiKey = getApiKey();
  return createOpenAI({ baseURL: getBaseUrl(), apiKey }).chat(model.modelName);
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  logger(`Submitting Agnes image request: ${model.modelName}`);
  try {
    const resp = await axios.post(`${getBaseUrl()}/images/generations`, buildImageRequestBody(config, model), {
      headers: getHeaders(),
    });
    const imageBase64 = getImageBase64FromResponse(resp.data);
    if (imageBase64) return imageBase64.startsWith("data:") ? imageBase64 : `data:image/png;base64,${imageBase64}`;
    const imageUrl = getImageUrlFromResponse(resp.data);
    if (imageUrl) return await urlToBase64(imageUrl);
    throw new Error(resp.data?.message || "Agnes image API did not return an image result");
  } catch (err: any) {
    throw new Error(getErrorMessage(err));
  }
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  logger(`Submitting Agnes video request: ${model.modelName}`);
  try {
    const submitResp = await axios.post(`${getBaseUrl()}/videos`, buildVideoRequestBody(config, model), {
      headers: getHeaders(),
    });
    const taskId = getVideoTaskId(submitResp.data);
    if (!taskId) throw new Error(submitResp.data?.message || "Agnes video API did not return a task id");
    logger(`Agnes video task submitted: ${taskId}`);

    const result = await pollTask(
      async (): Promise<PollResult> => {
        const queryResp = await axios.get(`${getRootBaseUrl()}/agnesapi`, {
          headers: getHeaders(),
          params: { video_id: taskId, model_name: model.modelName },
        });
        const status = getVideoStatus(queryResp.data);
        if (status === "completed" || status === "success" || status === "succeeded") {
          const videoUrl = getVideoUrlFromResponse(queryResp.data);
          return videoUrl
            ? { completed: true, data: videoUrl }
            : { completed: true, error: "Agnes video task completed without a video URL" };
        }
        if (status === "failed" || status === "failure" || status === "error") {
          return { completed: true, error: getVideoError(queryResp.data) || "Agnes video generation failed" };
        }
        logger(`Agnes video task processing: ${taskId}${status ? `, status=${status}` : ""}`);
        return { completed: false };
      },
      5000,
      20 * 60 * 1000,
    );
    if (result.error) throw new Error(result.error);
    if (!result.data) throw new Error("Agnes video generation failed: missing result");
    return result.data.startsWith("http") ? await urlToBase64(result.data) : result.data;
  } catch (err: any) {
    throw new Error(getErrorMessage(err));
  }
};

const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: "1.0", notice: "Agnes AI vendor is up to date." };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

// ============================================================
// Exports
// ============================================================

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

export {};
