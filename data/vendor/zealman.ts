/**
 * Toonflow AI vendor: Zealman ComfyUI workflow controller.
 * @version 2.3
 */

type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
  queueConfig: {
    maxConcurrent: number;
    pollInitialDelaySec: number;
    pollMinIntervalSec: number;
    pollMaxIntervalSec: number;
    maxWorkHours: number;
  };
}

interface VendorConfig {
  id: string;
  version: string;
  name: string;
  author: string;
  description?: string;
  inputs: { key: string; label: string; type: "text" | "password" | "url" | "textarea"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: VideoModel[];
}

declare const exports: {
  vendor: VendorConfig;
  textRequest: () => never;
  imageRequest: () => Promise<never>;
  videoRequest: () => Promise<never>;
  resolveVideoPromptModelId?: (model: VideoModel) => string | undefined;
  ttsRequest: () => Promise<never>;
};

const vendor: VendorConfig = {
  id: "zealman",
  version: "2.3",
  author: "Toonflow",
  name: "Zealman 工作流",
  description:
    "通过 Zealman/ComfyUI 已部署工作流生成视频。每个任务从选中实例读取最新工作流并提交临时执行图；每个健康实例共享一个 MiniMax H3 并发槽。仅暴露 U06 与 Light2v 多参考工作流，不包含 U4。",
  inputs: [
    {
      key: "instanceUrls",
      label: "实例地址（每行一个）",
      type: "textarea",
      required: true,
      placeholder: "https://example-1:8443\nhttps://example-2:8443",
    },
  ],
  inputValues: { instanceUrls: "", zealmanWorkflowExecutionSettings: "{}" },
  models: [
    {
      name: "MiniMax H3 U06 多参考视频",
      modelName: "minimax-h3-u06",
      type: "video",
      mode: [["imageReference:9", "videoReference:3", "audioReference:3"]],
      associationSkills: "MiniMax H3 U06 multi-reference video: up to 9 images, 3 videos, and 3 audios. At least one image reference is required.",
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768P"] }],
      queueConfig: {
        maxConcurrent: 20,
        pollInitialDelaySec: 2,
        pollMinIntervalSec: 15,
        pollMaxIntervalSec: 30,
        maxWorkHours: 6,
      },
    },
    {
      name: "MiniMax H3 Light2v U06 多参考视频",
      modelName: "minimax-h3-u06-light2v",
      type: "video",
      mode: [["imageReference:9", "videoReference:3", "audioReference:3"]],
      associationSkills: "MiniMax H3 Light2v U06 multi-reference video: up to 9 images, 3 videos, and 3 audios. At least one image reference is required.",
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768P"] }],
      queueConfig: {
        maxConcurrent: 20,
        pollInitialDelaySec: 2,
        pollMinIntervalSec: 15,
        pollMaxIntervalSec: 30,
        maxWorkHours: 6,
      },
    },
  ],
};

const unavailable = () => {
  throw new Error("Zealman U06 uses Toonflow's persistent video queue and cannot be called through the synchronous vendor runtime.");
};

const resolveVideoPromptModelId = (model: VideoModel): string | undefined =>
  /^minimax-h3-u06(?:-light2v)?$/i.test(model.modelName) ? "minimax-h3" : undefined;

exports.vendor = vendor;
exports.textRequest = unavailable;
exports.imageRequest = async () => unavailable();
exports.videoRequest = async () => unavailable();
exports.resolveVideoPromptModelId = resolveVideoPromptModelId;
exports.ttsRequest = async () => unavailable();

export {};
