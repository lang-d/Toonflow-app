/**
 * Toonflow AI供应商：T8Star
 * @version 2.2
 */

// ============================================================
// 类型定义
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
// 全局声明
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
  imageSubmit?: (c: ImageConfig, m: ImageModel) => Promise<{ providerTaskId: string; pollIntervalMs?: number }>;
  imagePoll?: (
    providerTaskId: string,
    m: ImageModel,
  ) => Promise<PollResult & { progress?: number; nextPollMs?: number }>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>;
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};

// ============================================================
// 供应商配置
// ============================================================

const vendor: VendorConfig = {
  id: "t8star",
  version: "2.2",
  author: "Toonflow",
  name: "T8Star",
  description:
    "## T8Star AI\n\nOpenAI 兼容接口供应商，支持文本模型与 GPT Image 2 生图模型。\n\n生图默认使用同步低价通道；旧异步通道代码仍保留在模板中。默认地址会自动补全 `/v1`，API Key 请填写平台生成的密钥。",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "https://ai.t8star.org" },
  ],
  inputValues: { apiKey: "", baseUrl: "https://ai.t8star.org" },
  models: [
    { name: "Claude Sonnet 4.6", modelName: "claude-sonnet-4-6", type: "text", think: false },
    { name: "Claude Sonnet 4.6 Thinking", modelName: "claude-sonnet-4-6-thinking", type: "text", think: true },
    { name: "Claude Opus 4.6", modelName: "claude-opus-4-6", type: "text", think: false },
    { name: "Claude Opus 4.6 Thinking", modelName: "claude-opus-4-6-thinking", type: "text", think: true },
    { name: "GPT-5.5", modelName: "gpt-5.5", type: "text", think: false },
    { name: "GPT-5.5 2026-04-23", modelName: "gpt-5.5-2026-04-23", type: "text", think: false },
    { name: "GPT-5.5 Pro", modelName: "gpt-5.5-pro", type: "text", think: false },
    { name: "GPT-5.5 Pro 2026-04-23", modelName: "gpt-5.5-pro-2026-04-23", type: "text", think: false },
    {
      name: "GPT Image 2",
      modelName: "gpt-image-2",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      associationSkills: "文本生图、参考图生图、多图参考",
    },
    {
      name: "GPT Image 2 All",
      modelName: "gpt-image-2-all",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      associationSkills: "文本生图、参考图生图、多图参考",
    },
  ],
};

// ============================================================
// 辅助工具
// ============================================================

const getApiKey = (): string => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  return vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
};

const getBaseUrl = (): string => {
  const baseUrl = (vendor.inputValues.baseUrl || "https://ai.t8star.org").replace(/\/+$/g, "");
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
};

const getHeaders = (): Record<string, string> => {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
};

const getImageUrlFromResponse = (data: any): string => {
  return (
    data?.data?.[0]?.url ||
    data?.data?.data?.[0]?.url ||
    data?.data?.data?.data?.[0]?.url ||
    data?.data?.result?.images?.[0]?.url?.[0] ||
    data?.result?.images?.[0]?.url?.[0] ||
    data?.url ||
    ""
  );
};

const getImageBase64FromResponse = (data: any): string => {
  return (
    data?.data?.[0]?.b64_json ||
    data?.data?.data?.[0]?.b64_json ||
    data?.data?.data?.data?.[0]?.b64_json ||
    data?.b64_json ||
    ""
  );
};

const getTaskIdFromResponse = (data: any): string => {
  return data?.data?.[0]?.task_id || data?.data?.task_id || data?.task_id || data?.id || "";
};

const getTaskStatusFromResponse = (data: any): string => {
  return String(data?.data?.status || data?.status || "").toUpperCase();
};

const getTaskProgressFromResponse = (data: any): number | undefined => {
  const value = data?.data?.progress ?? data?.progress;
  const progress = Number(value);
  return Number.isFinite(progress) ? progress : undefined;
};

const getTaskErrorFromResponse = (data: any): string => {
  return (
    data?.data?.fail_reason ||
    data?.data?.error?.message ||
    data?.data?.error ||
    data?.error?.message ||
    data?.message ||
    ""
  );
};

const getErrorMessage = (err: any): string => {
  return err?.response?.data?.error?.message || err?.response?.data?.message || err?.response?.data?.msg || err?.message || "请求失败";
};

const parseAspectRatio = (aspectRatio: string): { width: number; height: number } => {
  const [rawWidth, rawHeight] = String(aspectRatio || "1:1").split(":").map(Number);
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth <= 0 || rawHeight <= 0) {
    return { width: 1, height: 1 };
  }
  return { width: rawWidth, height: rawHeight };
};

const roundTo16 = (value: number): number => Math.max(512, Math.round(value / 16) * 16);

const getCheapChannelImageSize = (config: ImageConfig): string => {
  const ratio = parseAspectRatio(config.aspectRatio);
  if (ratio.width === ratio.height) {
    if (config.size === "4K") return "2880x2880";
    if (config.size === "2K") return "2048x2048";
    return "1024x1024";
  }

  const longEdge = config.size === "4K" ? 3840 : config.size === "2K" ? 2048 : 1536;
  let width: number;
  let height: number;
  if (ratio.width > ratio.height) {
    width = longEdge;
    height = roundTo16((longEdge * ratio.height) / ratio.width);
  } else {
    height = longEdge;
    width = roundTo16((longEdge * ratio.width) / ratio.height);
  }

  const maxPixels = 8294400;
  if (width * height > maxPixels) {
    const scale = Math.sqrt(maxPixels / (width * height));
    width = Math.max(512, Math.floor((width * scale) / 16) * 16);
    height = Math.max(512, Math.floor((height * scale) / 16) * 16);
  }
  return `${width}x${height}`;
};

const buildCheapChannelImageRequestBody = (config: ImageConfig, model: ImageModel): Record<string, any> => {
  if (!config.prompt) throw new Error("缺少提示词");
  const body: Record<string, any> = {
    model: model.modelName,
    prompt: config.prompt,
    n: 1,
    size: getCheapChannelImageSize(config),
    quality: "auto",
  };
  const images = (config.referenceList || []).map((item) => item.base64).filter(Boolean).slice(0, 16);
  if (images.length > 0) body.image = images;
  return body;
};

const buildLegacyAsyncImageRequestBody = (config: ImageConfig, model: ImageModel): Record<string, any> => {
  if (!config.prompt) throw new Error("缺少提示词");
  const body: Record<string, any> = {
    model: model.modelName,
    prompt: config.prompt,
    n: 1,
    size: config.aspectRatio || "1:1",
    resolution: config.size.toLowerCase(),
    quality: "auto",
  };
  const imageUrls = (config.referenceList || []).map((item) => item.base64).filter(Boolean).slice(0, 16);
  if (imageUrls.length > 0) body.image_urls = imageUrls;
  return body;
};

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  const apiKey = getApiKey();
  return createOpenAI({ baseURL: getBaseUrl(), apiKey }).chat(model.modelName);
};

const legacyImageSubmit = async (
  config: ImageConfig,
  model: ImageModel,
): Promise<{ providerTaskId: string; pollIntervalMs: number }> => {
  logger(`开始提交异步图片生成任务，模型：${model.modelName}`);
  try {
    const resp = await axios.post(
      `${getBaseUrl()}/images/generations?async=true`,
      buildLegacyAsyncImageRequestBody(config, model),
      { headers: getHeaders() },
    );
    const taskId = getTaskIdFromResponse(resp.data);
    if (!taskId) throw new Error(resp.data?.message || "图片生成接口未返回任务ID");
    logger(`图片任务提交成功，任务ID：${taskId}`);
    return { providerTaskId: taskId, pollIntervalMs: 5000 };
  } catch (err: any) {
    throw new Error(getErrorMessage(err));
  }
};

const legacyImagePoll = async (
  providerTaskId: string,
  model: ImageModel,
): Promise<PollResult & { progress?: number; nextPollMs?: number }> => {
  if (!providerTaskId) throw new Error("缺少图片任务ID");
  try {
    const resp = await axios.get(`${getBaseUrl()}/images/tasks/${encodeURIComponent(providerTaskId)}`, {
      headers: getHeaders(),
    });
    const status = getTaskStatusFromResponse(resp.data);
    if (status === "SUCCESS") {
      const taskBase64 = getImageBase64FromResponse(resp.data);
      if (taskBase64) {
        return {
          completed: true,
          data: taskBase64.startsWith("data:") ? taskBase64 : `data:image/png;base64,${taskBase64}`,
        };
      }
      const taskUrl = getImageUrlFromResponse(resp.data);
      return taskUrl
        ? { completed: true, data: taskUrl }
        : { completed: true, error: "图片任务完成但未找到图片结果" };
    }
    if (status === "FAILURE") {
      return { completed: true, error: getTaskErrorFromResponse(resp.data) || "图片生成失败" };
    }
    const progress = getTaskProgressFromResponse(resp.data);
    logger(`图片任务生成中，任务ID：${providerTaskId}${progress == null ? "" : `，进度：${progress}%`}`);
    return { completed: false, progress, nextPollMs: 5000 };
  } catch (err: any) {
    throw new Error(getErrorMessage(err));
  }
};

const legacyImageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  const submit = await legacyImageSubmit(config, model);
  const result = await pollTask(
    () => legacyImagePoll(submit.providerTaskId, model),
    submit.pollIntervalMs,
    600000,
  );
  if (result.error) throw new Error(result.error);
  if (!result.data) throw new Error("图片生成失败：未返回图片结果");
  return result.data.startsWith("data:") ? result.data : await urlToBase64(result.data);
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  logger(`开始使用同步低价通道生成图片，模型：${model.modelName}`);
  try {
    const resp = await axios.post(
      `${getBaseUrl()}/images/generations`,
      buildCheapChannelImageRequestBody(config, model),
      { headers: getHeaders() },
    );
    const imageBase64 = getImageBase64FromResponse(resp.data);
    if (imageBase64) {
      return imageBase64.startsWith("data:") ? imageBase64 : `data:image/png;base64,${imageBase64}`;
    }
    const imageUrl = getImageUrlFromResponse(resp.data);
    if (imageUrl) return imageUrl;
    throw new Error(resp.data?.message || "图片生成接口未返回图片结果");
  } catch (err: any) {
    throw new Error(getErrorMessage(err));
  }
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  return "";
};

const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: "2.2", notice: "## 当前已是最新版本" };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

// ============================================================
// 导出
// ============================================================

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = legacyImageRequest;
// 恢复旧异步通道时：将上一行改为 exports.imageRequest = legacyImageRequest，并取消下面两行注释。
exports.imageSubmit = legacyImageSubmit;
exports.imagePoll = legacyImagePoll;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

export {};
