/**
 * Dreamina official CLI vendor adapter.
 * @version 1.0
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
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string; disabled?: boolean }[];
  inputValues: Record<string, string>;
  models: (TextModel | ImageModel | VideoModel | TTSModel)[];
}

type ReferenceList =
  | { type: "image"; sourceType?: "base64"; base64: string }
  | { type: "audio"; sourceType?: "base64"; base64: string }
  | { type: "video"; sourceType?: "base64"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K" | string;
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

declare const dreaminaCli: {
  imageRequest: (config: ImageConfig, model: ImageModel) => Promise<string>;
  videoRequest: (config: VideoConfig, model: VideoModel) => Promise<string>;
};

declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t: boolean, tl: 0 | 1 | 2 | 3) => any;
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  ttsRequest: (c: any, m: TTSModel) => Promise<string>;
};

const vendor: VendorConfig = {
  id: "dreamina",
  version: "1.0",
  author: "ByteDance Dreamina",
  name: "即梦官方 CLI",
  description:
    "通过即梦官方 dreamina CLI 接入图片和视频生成。Toonflow 负责安装、扫码登录、余额检查、动态刷新模型，并以本机 CLI help 为模型能力准绳。",
  inputs: [],
  inputValues: {},
  models: [],
};

const textRequest = () => {
  throw new Error("即梦官方 CLI 供应商暂不提供文本模型。");
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  return dreaminaCli.imageRequest(config, model);
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  return dreaminaCli.videoRequest(config, model);
};

const ttsRequest = async (): Promise<string> => {
  throw new Error("即梦官方 CLI 供应商暂不提供 TTS 模型。");
};

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;

export {};
