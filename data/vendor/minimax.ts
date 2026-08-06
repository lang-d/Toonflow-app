/**
 * Toonflow AI供应商模板 - MiniMax(海螺AI)
 * @version 2.0
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
  uploadReference: (base64: string, fileType: "image" | "audio" | "video") => Promise<ReferenceList>;
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>;
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};

// ============================================================
// 供应商配置
// ============================================================

const vendor: VendorConfig = {
  id: "minimax",
  version: "2.2",
  author: "Toonflow",
  name: "MiniMax(海螺AI)",
  description: "MiniMax官方接口适配，支持M系列推理文本模型、文生图/图生图，以及 MiniMax-H3 多模态视频和 Hailuo 2.3 视频生成能力 \n [前往平台](https://minimaxi.com/)",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "示例：https://api.minimaxi.com" },
  ],
  inputValues: { apiKey: "", baseUrl: "https://api.minimaxi.com" },
  models: [
    // 文本模型
    { name: "MiniMax-M2.7 (推理版)", modelName: "MiniMax-M2.7", type: "text", think: true },
    { name: "MiniMax-M2.7 极速版 (推理版)", modelName: "MiniMax-M2.7-highspeed", type: "text", think: true },
    { name: "MiniMax-M2.5 (推理版)", modelName: "MiniMax-M2.5", type: "text", think: true },
    { name: "MiniMax-M2.5 极速版 (推理版)", modelName: "MiniMax-M2.5-highspeed", type: "text", think: true },
    { name: "MiniMax-M2.1 (编程版)", modelName: "MiniMax-M2.1", type: "text", think: true },
    { name: "MiniMax-M2.1 极速版 (编程版)", modelName: "MiniMax-M2.1-highspeed", type: "text", think: true },
    { name: "MiniMax-M2 (Agent版)", modelName: "MiniMax-M2", type: "text", think: false },
    // 图片模型
    { name: "海螺图像V1", modelName: "image-01", type: "image", mode: ["text", "singleImage"] },
    { name: "海螺图像V1 Live版", modelName: "image-01-live", type: "image", mode: ["text", "singleImage"], associationSkills: "支持自定义画风" },
    // 视频模型
    {
      name: "MiniMax H3",
      modelName: "MiniMax-H3",
      type: "video",
      mode: ["text", "singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      associationSkills: "MiniMax H3 text, first/last-frame, and multimodal reference video generation",
      audio: true,
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768P", "2K"] }],
    },
    {
      name: "海螺2.3",
      modelName: "MiniMax-Hailuo-2.3",
      type: "video",
      mode: ["text", "singleImage"],
      audio: false,
      durationResolutionMap: [
        { duration: [6], resolution: ["768P", "1080P"] },
        { duration: [10], resolution: ["768P"] },
      ],
    },
    {
      name: "海螺2.3极速版",
      modelName: "MiniMax-Hailuo-2.3-Fast",
      type: "video",
      mode: ["singleImage"],
      audio: false,
      durationResolutionMap: [
        { duration: [6], resolution: ["768P", "1080P"] },
        { duration: [10], resolution: ["768P"] },
      ],
    },
  ],
};

// ============================================================
// 辅助工具
// ============================================================

/**
 * 获取请求头
 */
const getHeaders = (): Record<string, string> => {
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
};

/**
 * 获取基础请求地址
 */
const getBaseUrl = (): string => {
  return vendor.inputValues.baseUrl.replace(/\/$/, "");
};

/**
 * 从 ReferenceList 条目中提取有头 base64 字符串
 */
const extractBase64WithHead = (ref: ReferenceList): string => {
  return ref.base64.startsWith("data:") ? ref.base64 : `data:image/png;base64,${ref.base64}`;
};

const H3_MODEL_NAME = "MiniMax-H3";
const H3_MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const H3_MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const H3_MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const H3_MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const H3_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const H3_VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime"]);
const H3_AUDIO_MIME_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"]);

const getProviderError = (error: any, fallback: string): string => {
  return String(error?.response?.data?.error?.message || error?.response?.data?.message || error?.message || fallback);
};

const decodedDataUriByteLength = (encoded: string): number => {
  const normalized = encoded.replace(/\s/g, "");
  return Math.floor((normalized.length * 3) / 4) - (normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0);
};

const parseDataUri = (value: string, label: string): { value: string; mime: string; bytes: number } => {
  const match = String(value || "").match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new Error(`MiniMax H3 ${label} must be a Base64 Data URL`);
  return { value, mime: match[1].toLowerCase(), bytes: decodedDataUriByteLength(match[2]) };
};

const flattenMode = (mode: any): string[] => {
  if (!Array.isArray(mode)) return typeof mode === "string" ? [mode] : [];
  const result: string[] = [];
  for (const entry of mode) {
    if (Array.isArray(entry)) result.push(...flattenMode(entry));
    else if (typeof entry === "string") result.push(entry);
  }
  return result;
};

const h3ReferenceLimit = (modeEntries: string[], type: "image" | "video" | "audio", fallback: number): number => {
  const entry = modeEntries.find((item) => item.startsWith(`${type}Reference:`));
  if (!entry) return fallback;
  const value = Number(entry.split(":")[1]);
  return Number.isInteger(value) && value >= 0 ? Math.min(value, fallback) : fallback;
};

const validateH3Reference = (reference: ReferenceList) => {
  const parsed = parseDataUri(reference.base64, `${reference.type} reference`);
  if (reference.type === "image") {
    if (!H3_IMAGE_MIME_TYPES.has(parsed.mime)) throw new Error("MiniMax H3 image references support JPG, PNG, WebP, HEIC, or HEIF only");
    if (parsed.bytes > H3_MAX_IMAGE_BYTES) throw new Error("MiniMax H3 image references must not exceed 30 MB each");
  } else if (reference.type === "video") {
    if (!H3_VIDEO_MIME_TYPES.has(parsed.mime)) throw new Error("MiniMax H3 video references support MP4 or MOV only");
    if (parsed.bytes > H3_MAX_VIDEO_BYTES) throw new Error("MiniMax H3 video references must not exceed 50 MB each");
  } else {
    if (!H3_AUDIO_MIME_TYPES.has(parsed.mime)) throw new Error("MiniMax H3 audio references support WAV or MP3 only");
    if (parsed.bytes > H3_MAX_AUDIO_BYTES) throw new Error("MiniMax H3 audio references must not exceed 15 MB each");
  }
  return parsed.value;
};

const h3MediaItem = (reference: ReferenceList, role: string) => {
  const url = validateH3Reference(reference);
  if (reference.type === "image") return { type: "image_url", image_url: { url }, role };
  if (reference.type === "video") return { type: "video_url", video_url: { url }, role };
  return { type: "audio_url", audio_url: { url }, role };
};

const buildH3VideoRequest = (config: VideoConfig, model: VideoModel): Record<string, any> => {
  const prompt = String(config.prompt || "").trim();
  if (!prompt) throw new Error("MiniMax H3 requires a video prompt");
  if (Array.from(prompt).length > 7000) throw new Error("MiniMax H3 prompts must not exceed 7000 characters");
  const duration = Number(config.duration);
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error("MiniMax H3 supports durations from 4 to 15 seconds");
  if (config.resolution !== "768P" && config.resolution !== "2K") throw new Error("MiniMax H3 supports 768P or 2K resolution only");
  if (config.aspectRatio !== "16:9" && config.aspectRatio !== "9:16") throw new Error("MiniMax H3 supports the current workbench ratios 16:9 and 9:16 only");

  const modeEntries = flattenMode(config.mode);
  const keyframeMode = modeEntries.find((item) => ["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional"].includes(item));
  const referenceMode = modeEntries.some((item) => /^(image|video|audio)Reference:\d+$/.test(item));
  if (keyframeMode && referenceMode) throw new Error("MiniMax H3 keyframe and multimodal reference modes cannot be combined");

  const references = config.referenceList || [];
  const images = references.filter((item) => item.type === "image");
  const videos = references.filter((item) => item.type === "video");
  const audios = references.filter((item) => item.type === "audio");
  const content: any[] = [{ type: "text", text: prompt }];

  if (keyframeMode) {
    if (videos.length || audios.length) throw new Error("MiniMax H3 keyframe modes accept image references only");
    if (images.length > 2) throw new Error("MiniMax H3 keyframe modes accept at most two images");
    if (keyframeMode === "singleImage") {
      if (images.length !== 1) throw new Error("MiniMax H3 single-image mode requires exactly one image");
      content.push(h3MediaItem(images[0], "first_frame"));
    } else if (keyframeMode === "startEndRequired") {
      if (images.length !== 2) throw new Error("MiniMax H3 first-and-last-frame mode requires exactly two images");
      content.push(h3MediaItem(images[0], "first_frame"), h3MediaItem(images[1], "last_frame"));
    } else if (keyframeMode === "endFrameOptional") {
      if (!images.length) throw new Error("MiniMax H3 end-frame-optional mode requires a first-frame image");
      content.push(h3MediaItem(images[0], "first_frame"));
      if (images[1]) content.push(h3MediaItem(images[1], "last_frame"));
    } else {
      if (!images.length) throw new Error("MiniMax H3 start-frame-optional mode requires a last-frame image");
      if (images[1]) content.push(h3MediaItem(images[0], "first_frame"), h3MediaItem(images[1], "last_frame"));
      else content.push(h3MediaItem(images[0], "last_frame"));
    }
  } else if (referenceMode) {
    if (!references.length) throw new Error("MiniMax H3 multimodal reference mode requires at least one reference");
    if (images.length > h3ReferenceLimit(modeEntries, "image", 9) || videos.length > h3ReferenceLimit(modeEntries, "video", 3) || audios.length > h3ReferenceLimit(modeEntries, "audio", 3)) {
      throw new Error("MiniMax H3 reference count exceeds the selected mode limit");
    }
    if (images.length > 9 || videos.length > 3 || audios.length > 3 || references.length > 12) throw new Error("MiniMax H3 supports at most 9 images, 3 videos, 3 audios, and 12 references in total");
    if (audios.length && !images.length && !videos.length) throw new Error("MiniMax H3 audio references require at least one image or video reference");
    for (const reference of images) content.push(h3MediaItem(reference, "reference_image"));
    for (const reference of videos) content.push(h3MediaItem(reference, "reference_video"));
    for (const reference of audios) content.push(h3MediaItem(reference, "reference_audio"));
  } else if (references.length) {
    throw new Error("MiniMax H3 text mode does not accept references; select a keyframe or multimodal reference mode");
  }

  const body = { model: model.modelName, content, resolution: config.resolution, duration, ratio: config.aspectRatio, aigc_watermark: false };
  if (JSON.stringify(body).length > H3_MAX_REQUEST_BYTES) throw new Error("MiniMax H3 request body must not exceed 64 MB; use smaller references");
  return body;
};

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  const baseUrl = getBaseUrl();

  const openaiBaseUrl = `${baseUrl}/v1`;
  const extraBody = model.think ? { reasoning_split: true } : {};
  return createOpenAI({ baseURL: openaiBaseUrl, apiKey, extraBody }).chat(model.modelName);
};

const uploadReference = async (base64: string, fileType: "image" | "audio" | "video"): Promise<ReferenceList> => {
  // MiniMax的图片接口直接接受 base64，压缩后原样返回
  if (fileType === "image") {
    const compressed = await zipImage(base64, 10 * 1024);
    return { type: "image", sourceType: "base64", base64: compressed };
  }
  // 视频接口的图片参数也是 base64，压缩到20MB
  return { type: fileType, sourceType: "base64", base64 } as ReferenceList;
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const baseUrl = getBaseUrl();
  const headers = getHeaders();

  const reqBody: any = {
    model: model.modelName,
    prompt: config.prompt,
    aspect_ratio: config.aspectRatio,
    response_format: "base64",
    n: 1,
    prompt_optimizer: true,
    aigc_watermark: false,
  };

  // 处理图生图参考
  const imageRefs = config.referenceList || [];
  if (imageRefs.length > 0) {
    const refBase64 = extractBase64WithHead(imageRefs[0]);
    reqBody.subject_reference = [{ type: "character", image_file: refBase64 }];
  }

  logger("开始提交MiniMax图像生成任务");
  const resp = await axios.post(`${baseUrl}/v1/image_generation`, reqBody, { headers });
  if (resp.data.base_resp.status_code !== 0) {
    throw new Error(`图像生成失败：${resp.data.base_resp.status_msg}`);
  }
  if (resp.data.metadata.success_count === 0) {
    throw new Error("图像生成被安全策略拦截，请调整prompt或参考图");
  }

  const imgBase64 = resp.data.data.image_base64[0];
  return imgBase64.startsWith("data:") ? imgBase64 : `data:image/png;base64,${imgBase64}`;
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const baseUrl = getBaseUrl();
  const headers = getHeaders();

  if (model.modelName === H3_MODEL_NAME) {
    try {
      const reqBody = buildH3VideoRequest(config, model);
      logger(`Submitting MiniMax H3 video task: ${model.modelName}`);
      const submitResp = await axios.post(`${baseUrl}/v2/video_generation`, reqBody, { headers });
      const taskId = String(submitResp.data?.task_id || "");
      if (!taskId) throw new Error(submitResp.data?.error?.message || "MiniMax H3 task submission did not return a task_id");
      logger(`MiniMax H3 video task submitted: ${taskId}`);

      const pollResult = await pollTask(
        async (): Promise<PollResult> => {
          const queryResp = await axios.get(`${baseUrl}/v2/query/video_generation/${encodeURIComponent(taskId)}`, { headers });
          const task = queryResp.data?.task;
          const status = String(task?.status || "").toLowerCase();
          if (status === "succeeded") {
            const url = String(task?.content?.url || "");
            return url ? { completed: true, data: url } : { completed: true, error: "MiniMax H3 task succeeded without a video URL" };
          }
          if (status === "failed" || status === "cancelled") {
            return { completed: true, error: String(task?.error?.message || task?.error || `MiniMax H3 task ${status}`) };
          }
          logger(`MiniMax H3 video task processing: ${taskId}${status ? `, status=${status}` : ""}`);
          return { completed: false };
        },
        5000,
        20 * 60 * 1000,
      );
      if (pollResult.error) throw new Error(pollResult.error);
      if (!pollResult.data) throw new Error("MiniMax H3 task completed without a video result");
      return pollResult.data.startsWith("http") ? await urlToBase64(pollResult.data) : pollResult.data;
    } catch (error: any) {
      throw new Error(getProviderError(error, "MiniMax H3 video generation failed"));
    }
  }

  if (model.modelName !== "MiniMax-Hailuo-2.3" && model.modelName !== "MiniMax-Hailuo-2.3-Fast") {
    throw new Error(`Unsupported MiniMax video model: ${model.modelName}`);
  }

  const reqBody: any = {
    model: model.modelName,
    prompt: config.prompt,
    duration: config.duration,
    resolution: config.resolution,
    aigc_watermark: false,
    prompt_optimizer: true,
  };

  // 提取图片类型的引用
  const imageRefs = (config.referenceList || []).filter((r) => r.type === "image");

  if (model.modelName === "MiniMax-Hailuo-2.3-Fast" && imageRefs.length !== 1) {
    throw new Error("MiniMax-Hailuo-2.3-Fast supports image-to-video and requires exactly one first-frame image");
  }

  if (imageRefs.length > 0) {
    // 压缩图片到20MB以内
    const compressedImages: string[] = [];
    for (const ref of imageRefs) {
      const base64 = extractBase64WithHead(ref);
      const compressed = await zipImage(base64, 20 * 1024);
      compressedImages.push(compressed);
    }

    if (config.mode.includes("startEndRequired")) {
      if (compressedImages.length < 2) throw new Error("首尾帧模式需要上传两张图片");
      reqBody.first_frame_image = compressedImages[0];
      reqBody.last_frame_image = compressedImages[1];
    } else if (config.mode.includes("singleImage")) {
      reqBody.first_frame_image = compressedImages[0];
    }
  }

  logger("开始提交MiniMax视频生成任务");
  const submitResp = await axios.post(`${baseUrl}/v1/video_generation`, reqBody, { headers });
  if (submitResp.data.base_resp.status_code !== 0) {
    throw new Error(`任务提交失败：${submitResp.data.base_resp.status_msg}`);
  }
  const taskId = submitResp.data.task_id;
  logger(`视频任务提交成功，任务ID: ${taskId}`);

  // 轮询任务状态
  const pollResult = await pollTask(
    async () => {
      const queryResp = await axios.get(`${baseUrl}/v1/query/video_generation`, {
        headers: getHeaders(),
        params: { task_id: taskId },
      });
      if (queryResp.data.base_resp.status_code !== 0) {
        return { completed: true, error: queryResp.data.base_resp.status_msg };
      }
      const status = queryResp.data.status;
      if (status === "Success") {
        return { completed: true, data: queryResp.data.file_id };
      }
      if (status === "Fail") {
        return { completed: true, error: "视频生成失败" };
      }
      logger(`视频任务生成中，当前状态：${status}`);
      return { completed: false };
    },
    5000,
    600000,
  );

  if (pollResult.error) throw new Error(pollResult.error);
  const fileId = pollResult.data!;
  logger(`视频任务生成成功，文件ID: ${fileId}`);

  // 获取下载地址
  const fileResp = await axios.get(`${baseUrl}/v1/files/retrieve`, {
    headers: getHeaders(),
    params: { file_id: fileId },
  });
  if (fileResp.data.base_resp.status_code !== 0) {
    throw new Error(`获取文件地址失败：${fileResp.data.base_resp.status_msg}`);
  }
  const downloadUrl = fileResp.data.file.download_url;
  logger(`视频下载地址获取成功，开始转Base64`);

  return await urlToBase64(downloadUrl);
};

const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return {
    hasUpdate: false,
    latestVersion: "2.2",
    notice:
      "## 新版本更新公告\n1. 新增 MiniMax-H3 V2 多模态视频生成\n2. 保留 Hailuo 2.3 与 Hailuo 2.3 Fast，淘汰 Hailuo-02\n3. H3 支持首尾帧和图、视频、音频参考输入",
  };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

// ============================================================
// 导出
// ============================================================

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.uploadReference = uploadReference;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

// 这行代码用于确保当前文件被识别为模块，避免全局变量冲突
export {};
