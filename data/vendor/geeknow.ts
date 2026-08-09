/**
 * Toonflow AI vendor: Geeknow API
 * @version 2.1
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

declare const axios: any;
declare const logger: (msg: string) => void;
declare const urlToBase64: (url: string) => Promise<string>;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const createOpenAI: any;
declare const Buffer: any;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t: boolean, tl: 0 | 1 | 2 | 3) => any;
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  resolveVideoPromptModelId?: (model: VideoModel) => string | undefined;
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>;
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};

const vendor: VendorConfig = {
  id: "geeknow",
  version: "1.2",
  author: "Toonflow",
  name: "Geeknow API",
  description:
    "## Geeknow API\n\nLatest Geeknow text, image, and video models. Images use the async generation API; videos use task submission and polling.",
  inputs: [
    { key: "apiKey", label: "API Key", type: "password", required: true },
    { key: "baseUrl", label: "Base URL", type: "url", required: true, placeholder: "https://www.geeknow.top" },
  ],
  inputValues: { apiKey: "", baseUrl: "https://www.geeknow.top" },
  models: [
    { name: "DeepSeek V4 Pro", modelName: "deepseek-v4-pro", type: "text", think: false },
    { name: "DeepSeek V4 Flash", modelName: "deepseek-v4-flash", type: "text", think: false },
    { name: "Qwen3 Max", modelName: "qwen3-max", type: "text", think: false },
    { name: "Claude Sonnet 4.6", modelName: "claude-sonnet-4-6", type: "text", think: false },
    { name: "Claude Opus 4.7", modelName: "claude-opus-4-7", type: "text", think: false },
    { name: "Gemini 3.1 Pro Preview", modelName: "gemini-3.1-pro-preview", type: "text", think: false },
    {
      name: "GPT Image 2 Pro",
      modelName: "gpt-image-2-pro",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      associationSkills: "Async high-resolution image generation",
    },
    {
      name: "GPT Image 2 VIP",
      modelName: "gpt-image-2-vip",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      associationSkills: "Async VIP image generation with 1K/2K/4K size tables",
    },
    {
      name: "Doubao Seedream 5.0",
      modelName: "doubao-seedream-5-0-260128",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      associationSkills: "Async Seedream image generation",
    },
    {
      name: "Gemini 3 Pro Image Preview",
      modelName: "gemini-3-pro-image-preview",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      associationSkills: "Async Gemini image generation",
    },
    {
      name: "Gemini 3.1 Flash Image Preview",
      modelName: "gemini-3.1-flash-image-preview",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      associationSkills: "Async Gemini flash image generation",
    },
    {
      name: "Grok 4.2 Image",
      modelName: "grok-4-2-image",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      associationSkills: "Grok image generation through Geeknow async image API",
    },
    {
      name: "Manxue 2.0",
      modelName: "manxue-2.0",
      type: "video",
      mode: ["text", "singleImage", "startEndRequired", ["imageReference:4", "audioReference:1"]],
      associationSkills: "Special-offer video model; reference media is uploaded to public URLs",
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480P", "720P"] }],
    },
    {
      name: "Seedance 2.0 Pro",
      modelName: "seedance-2.0-pro",
      type: "video",
      mode: ["text", "singleImage", "startEndRequired", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      associationSkills: "Seedance 2.0 video generation",
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      name: "Seedance 2.0 Fast",
      modelName: "seedance-2.0-fast",
      type: "video",
      mode: ["text", "singleImage", "startEndRequired", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      associationSkills: "Fast Seedance 2.0 video generation",
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] }],
    },
    {
      name: "Omni Fast",
      modelName: "omni-fast",
      type: "video",
      mode: ["text", "singleImage", "startEndRequired", ["imageReference:5"]],
      associationSkills: "Omni JSON video generation",
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 15, 20, 30], resolution: ["480p", "720p"] }],
    },
    {
      name: "Grok Video 3",
      modelName: "grok-video-3",
      type: "video",
      mode: ["text", "singleImage", "startEndRequired", ["imageReference:4"]],
      associationSkills: "Grok Video 3 task generation",
      audio: "optional",
      durationResolutionMap: [{ duration: [10, 15], resolution: ["720p"] }],
    },
    {
      name: "Grok Video 3 Pro",
      modelName: "grok-video-3-pro",
      type: "video",
      mode: ["text", "singleImage", "startEndRequired", ["imageReference:4"]],
      associationSkills: "Grok Video 3 Pro task generation",
      audio: "optional",
      durationResolutionMap: [{ duration: [10], resolution: ["720p"] }],
    },
    {
      name: "Hailuo 2.3 Fast",
      modelName: "Hailuo-2.3-fast",
      type: "video",
      mode: ["text", "singleImage"],
      associationSkills: "Hailuo 2.3 Fast video generation",
      audio: "optional",
      durationResolutionMap: [{ duration: [6, 10], resolution: ["768P", "1080P"] }],
    },
    {
      name: "Veo 3.1 Fast",
      modelName: "veo_3_1-fast",
      type: "video",
      mode: ["text", "singleImage", "startEndRequired", ["imageReference:4"]],
      associationSkills: "Veo 3.1 Fast task generation",
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 6, 8], resolution: ["720p", "1080p"] }],
    },
  ],
};

const getApiKey = (): string => {
  if (!vendor.inputValues.apiKey) throw new Error("Missing API Key");
  return vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
};

const getRootBaseUrl = (): string => {
  return (vendor.inputValues.baseUrl || "https://www.geeknow.top").replace(/\/+$/g, "").replace(/\/v1$/i, "");
};

const getBaseUrl = (): string => `${getRootBaseUrl()}/v1`;

const getHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${getApiKey()}`,
  "Content-Type": "application/json",
  Accept: "application/json",
});

const getErrorMessage = (err: any): string => {
  return err?.response?.data?.error?.message || err?.response?.data?.message || err?.response?.data?.msg || err?.message || "Request failed";
};

const readByPath = (data: any, path: string): any => {
  return path.split(".").reduce((value, key) => {
    if (value === undefined || value === null) return undefined;
    const match = key.match(/^(.+)\[(\d+)\]$/);
    if (match) return value[match[1]]?.[Number(match[2])];
    return value[key];
  }, data);
};

const pickFirst = (values: any[]): any => values.find((item) => item !== undefined && item !== null && item !== "");

const stripDataUri = (value: string): { base64: string; mime: string } => {
  const match = String(value || "").match(/^data:([^;]+);base64,(.*)$/);
  if (!match) return { base64: value, mime: "application/octet-stream" };
  return { mime: match[1], base64: match[2] };
};

const ensureImageDataUri = (value: string): string => {
  if (!value) return value;
  return value.startsWith("data:") ? value : `data:image/png;base64,${value}`;
};

const toDataImage = (base64: string): string => {
  return base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
};

const getImageBase64FromResponse = (data: any): string => {
  return pickFirst([readByPath(data, "data[0].b64_json"), readByPath(data, "data.data[0].b64_json"), data?.b64_json]) || "";
};

const getImageUrlFromResponse = (data: any): string => {
  return pickFirst([readByPath(data, "data[0].url"), readByPath(data, "data.data[0].url"), data?.url]) || "";
};

const resolveImageResult = async (data: any): Promise<string> => {
  const imageBase64 = getImageBase64FromResponse(data);
  if (imageBase64) return toDataImage(imageBase64);
  const imageUrl = getImageUrlFromResponse(data);
  if (imageUrl) return await urlToBase64(imageUrl);
  return "";
};

const getTaskIdFromResponse = (data: any): string => {
  return String(data?.id || data?.task_id || data?.taskId || data?.data?.id || data?.data?.task_id || data?.data?.taskId || "");
};

const getStatus = (data: any): string => {
  return String(data?.status || data?.data?.status || data?.state || data?.data?.state || "").toLowerCase();
};

const getProviderError = (data: any): string => {
  return data?.error?.message || data?.data?.error?.message || data?.error || data?.data?.error || data?.message || data?.data?.message || "";
};

const clampDuration = (duration: number, min: number, max: number, fallback: number): number => {
  const value = Number(duration);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
};

const normalizeResolution = (resolution: string, fallback: string): string => {
  return String(resolution || fallback);
};

const getGenericImageSize = (config: ImageConfig): string => {
  const ratio = String(config.aspectRatio || "1:1");
  const oneK: Record<string, string> = {
    "1:1": "1024x1024",
    "4:3": "1024x768",
    "3:4": "768x1024",
    "3:2": "1008x672",
    "2:3": "672x1008",
    "16:9": "1280x720",
    "9:16": "720x1280",
    "21:9": "1344x576",
  };
  const twoK: Record<string, string> = {
    "1:1": "2048x2048",
    "4:3": "2304x1728",
    "3:4": "1728x2304",
    "3:2": "2496x1664",
    "2:3": "1664x2496",
    "16:9": "2560x1440",
    "9:16": "1440x2560",
    "21:9": "3024x1296",
  };
  const fourK: Record<string, string> = {
    "1:1": "2880x2880",
    "4:3": "3264x2448",
    "3:4": "2448x3264",
    "3:2": "3504x2336",
    "2:3": "2336x3504",
    "16:9": "3840x2160",
    "9:16": "2160x3840",
    "21:9": "3808x1632",
  };
  const table = config.size === "4K" ? fourK : config.size === "1K" ? oneK : twoK;
  return table[ratio] || table["1:1"];
};

const getImageSize = (config: ImageConfig, model: ImageModel): string => {
  const ratio = String(config.aspectRatio || "1:1");
  if (model.modelName === "gpt-image-2-pro") {
    const twoK: Record<string, string> = {
      "1:1": "2048x2048",
      "4:3": "2048x1536",
      "3:2": "2560x1712",
      "2:3": "1712x2560",
      "16:9": "2048x1152",
      "9:16": "1152x2048",
    };
    const fourK: Record<string, string> = {
      "1:1": "2880x2880",
      "4:3": "3840x2880",
      "3:2": "3840x2560",
      "2:3": "2560x3840",
      "16:9": "3840x2160",
      "9:16": "2160x3840",
    };
    const table = config.size === "4K" ? fourK : twoK;
    return table[ratio] || table["1:1"];
  }
  return getGenericImageSize(config);
};

const buildImageAsyncBody = (config: ImageConfig, model: ImageModel): Record<string, any> => {
  if (!config.prompt) throw new Error("Missing image prompt");
  const imageRefs = (config.referenceList || []).map((item) => ensureImageDataUri(item.base64)).filter(Boolean).slice(0, 16);
  const body: Record<string, any> = {
    model: model.modelName,
    prompt: config.prompt,
    n: 1,
    size: getImageSize(config, model),
    quality: model.modelName.includes("pro") || model.modelName.includes("vip") ? "high" : "auto",
  };
  if (model.modelName !== "gpt-image-2-vip") body.response_format = "b64_json";
  if (imageRefs.length > 0) body.image = imageRefs;
  return body;
};

const uploadReferenceToUrl = async (ref: ReferenceList, index: number): Promise<string> => {
  if (/^https?:\/\//i.test(ref.base64)) return ref.base64;
  const parsed = stripDataUri(ref.base64);
  const mime =
    parsed.mime === "application/octet-stream"
      ? ref.type === "audio"
        ? "audio/mpeg"
        : ref.type === "video"
          ? "video/mp4"
          : "image/png"
      : parsed.mime;
  const ext = mime.split("/")[1]?.replace("jpeg", "jpg") || "bin";
  const presignResp = await axios.post(
    `${getRootBaseUrl()}/api/upload/presign`,
    {
      file_name: `toonflow-${ref.type}-${Date.now()}-${index}.${ext}`,
      content_type: mime,
      expires_in: 900,
    },
    { headers: getHeaders() },
  );
  if (presignResp.data?.success === false) throw new Error(presignResp.data?.message || "Geeknow upload presign failed");
  const uploadUrl = presignResp.data?.data?.upload_url;
  const publicUrl = presignResp.data?.data?.public_url;
  if (!uploadUrl || !publicUrl) throw new Error("Geeknow upload presign response missing upload_url/public_url");
  await axios.put(uploadUrl, Buffer.from(parsed.base64, "base64"), {
    headers: { "Content-Type": mime },
  });
  return publicUrl;
};

const uploadRefsByType = async (config: VideoConfig, type: ReferenceList["type"]): Promise<string[]> => {
  const refs = (config.referenceList || []).filter((item) => item.type === type);
  const urls: string[] = [];
  for (let i = 0; i < refs.length; i += 1) {
    urls.push(await uploadReferenceToUrl(refs[i], i + 1));
  }
  return urls;
};

const getVideoSize = (config: VideoConfig): string => {
  const resolution = String(config.resolution || "720p").toLowerCase();
  if (resolution.includes("1080")) return config.aspectRatio === "9:16" ? "1080x1920" : "1920x1080";
  if (resolution.includes("480")) return config.aspectRatio === "9:16" ? "480x854" : "854x480";
  return config.aspectRatio === "9:16" ? "720x1280" : "1280x720";
};

const buildManxueBody = async (config: VideoConfig, model: VideoModel): Promise<Record<string, any>> => {
  if (!config.prompt) throw new Error("Missing video prompt");
  const imageUrls = await uploadRefsByType(config, "image");
  const audioUrls = await uploadRefsByType(config, "audio");
  const body: Record<string, any> = {
    model: model.modelName,
    prompt: config.prompt,
    seconds: String(clampDuration(config.duration, 4, 15, 8)),
    ratio: config.aspectRatio || "16:9",
    resolution: normalizeResolution(config.resolution, "720P").toUpperCase(),
    generate_audio: model.audio === true || (model.audio === "optional" && (config.audio === true || audioUrls.length > 0)),
  };
  if (imageUrls.length > 0 || audioUrls.length > 0) {
    body.content = [{ type: "text", text: config.prompt }];
    imageUrls.forEach((url, index) => {
      const role = config.mode.includes("startEndRequired") && index === 0 ? "first_frame" : config.mode.includes("startEndRequired") && index === 1 ? "last_frame" : imageUrls.length === 1 && config.mode.includes("singleImage") ? "first_frame" : "reference_image";
      body.content.push({ type: "image_url", role, image_url: { url } });
    });
    audioUrls.slice(0, 1).forEach((url) => {
      body.content.push({ type: "audio_url", role: "reference_audio", audio_url: { url } });
    });
  }
  return body;
};

const buildSeedanceBody = async (config: VideoConfig, model: VideoModel): Promise<Record<string, any>> => {
  if (!config.prompt) throw new Error("Missing video prompt");
  const imageUrls = await uploadRefsByType(config, "image");
  const videoUrls = await uploadRefsByType(config, "video");
  const audioUrls = await uploadRefsByType(config, "audio");
  const body: Record<string, any> = {
    model: model.modelName,
    prompt: config.prompt,
    duration: clampDuration(config.duration, 4, 15, 8),
    aspect_ratio: config.aspectRatio || "16:9",
    resolution: normalizeResolution(config.resolution, model.modelName.includes("fast") ? "720p" : "1080p"),
    generate_audio: model.audio === true || (model.audio === "optional" && (config.audio === true || audioUrls.length > 0)),
  };
  if (config.mode.includes("startEndRequired") && imageUrls.length >= 2) {
    body.first_image = imageUrls[0];
    body.last_image = imageUrls[1];
    if (imageUrls.length > 2) body.reference_image_urls = imageUrls.slice(2);
  } else if (imageUrls.length === 1 && config.mode.includes("singleImage")) {
    body.first_image = imageUrls[0];
  } else if (imageUrls.length > 0) {
    body.reference_image_urls = imageUrls;
  }
  if (videoUrls.length > 0) body.reference_video_urls = videoUrls;
  if (audioUrls.length > 0) body.reference_audio_urls = audioUrls;
  return body;
};

const buildOmniBody = async (config: VideoConfig, model: VideoModel): Promise<Record<string, any>> => {
  const imageUrls = await uploadRefsByType(config, "image");
  const body: Record<string, any> = {
    model: model.modelName,
    prompt: config.prompt,
    duration: clampDuration(config.duration, 4, 30, 8),
    aspect_ratio: config.aspectRatio || "16:9",
    resolution: normalizeResolution(config.resolution, "720p"),
  };
  if (config.mode.includes("startEndRequired") && imageUrls.length >= 2) {
    body.first_image_url = imageUrls[0];
    body.last_image_url = imageUrls[1];
    if (imageUrls.length > 2) body.images = imageUrls.slice(2, 7);
  } else if (imageUrls.length === 1 && config.mode.includes("singleImage")) {
    body.first_image_url = imageUrls[0];
  } else if (imageUrls.length > 0) {
    body.images = imageUrls.slice(0, 5);
  }
  return body;
};

const buildGenericVideoBody = async (config: VideoConfig, model: VideoModel): Promise<Record<string, any>> => {
  if (!config.prompt) throw new Error("Missing video prompt");
  const imageUrls = await uploadRefsByType(config, "image");
  const body: Record<string, any> = {
    model: model.modelName,
    prompt: config.prompt,
    seconds: String(clampDuration(config.duration, 4, 15, model.modelName.includes("grok") ? 10 : 8)),
    duration: clampDuration(config.duration, 4, 15, 8),
    size: getVideoSize(config),
    aspect_ratio: config.aspectRatio || "16:9",
    resolution: normalizeResolution(config.resolution, "720p"),
  };
  if (imageUrls.length === 1) {
    body.image = imageUrls[0];
    body.input_reference = imageUrls[0];
  } else if (imageUrls.length > 1) {
    body.images = imageUrls;
    body.input_reference = imageUrls;
  }
  if (model.modelName === "Hailuo-2.3-fast") {
    body.metadata = { output_config: { resolution: body.resolution } };
  }
  return body;
};

const buildVideoBody = async (config: VideoConfig, model: VideoModel): Promise<Record<string, any>> => {
  if (model.modelName === "manxue-2.0") return await buildManxueBody(config, model);
  if (model.modelName.startsWith("seedance-2.0")) return await buildSeedanceBody(config, model);
  if (model.modelName.startsWith("omni-fast")) return await buildOmniBody(config, model);
  return await buildGenericVideoBody(config, model);
};

const resolveVideoPromptModelId = (model: VideoModel): string | undefined =>
  model.modelName.startsWith("seedance-2.0") ? "seedance-2" : undefined;

const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  return createOpenAI({ baseURL: getBaseUrl(), apiKey: getApiKey() }).chat(model.modelName);
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  logger(`Submitting Geeknow async image request: ${model.modelName}`);
  try {
    const submitResp = await axios.post(`${getBaseUrl()}/images/generations/async`, buildImageAsyncBody(config, model), {
      headers: getHeaders(),
    });
    const directResult = await resolveImageResult(submitResp.data);
    if (directResult) return directResult;
    const taskId = getTaskIdFromResponse(submitResp.data);
    if (!taskId) throw new Error(submitResp.data?.message || "Geeknow image async API did not return a task id");

    const result = await pollTask(
      async (): Promise<PollResult> => {
        const queryResp = await axios.get(`${getBaseUrl()}/images/generations/async/${encodeURIComponent(taskId)}`, {
          headers: getHeaders(),
        });
        const taskResult = await resolveImageResult(queryResp.data);
        if (taskResult) return { completed: true, data: taskResult };
        const status = getStatus(queryResp.data);
        if (status === "completed" || status === "succeeded" || status === "success") {
          return { completed: true, error: "Geeknow image generation completed without image result" };
        }
        if (status === "failed" || status === "failure" || status === "error" || status === "cancelled") {
          return { completed: true, error: getProviderError(queryResp.data) || "Geeknow image generation failed" };
        }
        logger(`Geeknow image task processing: ${taskId}${status ? `, status=${status}` : ""}`);
        return { completed: false };
      },
      5000,
      20 * 60 * 1000,
    );
    if (result.error) throw new Error(result.error);
    if (!result.data) throw new Error("Geeknow image generation failed: missing result");
    return result.data;
  } catch (err: any) {
    throw new Error(getErrorMessage(err));
  }
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  logger(`Submitting Geeknow video request: ${model.modelName}`);
  try {
    const submitResp = await axios.post(`${getBaseUrl()}/videos`, await buildVideoBody(config, model), {
      headers: getHeaders(),
    });
    const taskId = getTaskIdFromResponse(submitResp.data);
    if (!taskId) throw new Error(submitResp.data?.message || "Geeknow video API did not return a task id");

    const result = await pollTask(
      async (): Promise<PollResult> => {
        const queryResp = await axios.get(`${getBaseUrl()}/videos/${encodeURIComponent(taskId)}`, {
          headers: getHeaders(),
        });
        const status = getStatus(queryResp.data);
        const videoUrl = pickFirst([
          queryResp.data?.video_url,
          queryResp.data?.data?.video_url,
          queryResp.data?.url,
          queryResp.data?.data?.url,
        ]);
        if (videoUrl) return { completed: true, data: videoUrl };
        if (status === "completed" || status === "success" || status === "succeeded") {
          return { completed: true, data: `${getBaseUrl()}/videos/${encodeURIComponent(taskId)}/content` };
        }
        if (status === "failed" || status === "failure" || status === "error" || status === "cancelled") {
          return { completed: true, error: getProviderError(queryResp.data) || "Geeknow video generation failed" };
        }
        logger(`Geeknow video task processing: ${taskId}${status ? `, status=${status}` : ""}`);
        return { completed: false };
      },
      5000,
      30 * 60 * 1000,
    );
    if (result.error) throw new Error(result.error);
    if (!result.data) throw new Error("Geeknow video generation failed: missing result");
    return result.data.startsWith("http") ? await urlToBase64(result.data) : result.data;
  } catch (err: any) {
    throw new Error(getErrorMessage(err));
  }
};

const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: "1.2", notice: "Geeknow API vendor is up to date." };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.resolveVideoPromptModelId = resolveVideoPromptModelId;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

export {};
