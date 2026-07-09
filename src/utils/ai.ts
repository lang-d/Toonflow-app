import { generateText, streamText, wrapLanguageModel, stepCountIs, extractReasoningMiddleware } from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import axios from "axios";
import crypto from "node:crypto";
import u from "@/utils";
import { updateUnifiedTask } from "@/services/taskCoordinator";
import { createLogger } from "@/logger";

type AiType =
  | "scriptAgent"
  | "productionAgent"
  | "musicProductionAgent"
  | "storyAgent"
  | "universalAi"
  | "storyAgent:decisionAgent"
  | "scriptAgent:decisionAgent"
  | "scriptAgent:supervisionAgent"
  | "scriptAgent:storySkeletonAgent"
  | "scriptAgent:adaptationStrategyAgent"
  | "scriptAgent:scriptAgent"
  | "productionAgent:decisionAgent"
  | "musicProductionAgent:decisionAgent"
  | "productionAgent:supervisionAgent"
  | "productionAgent:deriveAssetsAgent"
  | "productionAgent:generateAssetsAgent"
  | "productionAgent:directorPlanAgent"
  | "productionAgent:storyboardGenAgent"
  | "productionAgent:storyboardPanelAgent"
  | "productionAgent:storyboardTableAgent";

type FnName = "textRequest" | "imageRequest" | "imageSubmit" | "imagePoll" | "videoRequest" | "ttsRequest" | "musicRequest";
const IMAGE_PROVIDER_TIMEOUT_MS = 10 * 60 * 1000;
const IMAGE_PROVIDER_SUBMIT_SOFT_WARN_MS = 90 * 1000;
const IMAGE_PROVIDER_SUBMIT_HARD_TIMEOUT_MS = 10 * 60 * 1000;
const IMAGE_PROVIDER_LEASE_RENEW_MS = 30 * 1000;
const IMAGE_PROVIDER_LEASE_MS = 120 * 1000;
const IMAGE_PROVIDER_SUBMIT_RETRY_DELAY_MS = 15 * 1000;
const IMAGE_PROVIDER_POLL_RETRY_DELAY_MS = 15 * 1000;
const aiLog = createLogger("ai");

const AiTypeValues: AiType[] = [
  "scriptAgent",
  "productionAgent",
  "musicProductionAgent",
  "storyAgent",
  "universalAi",
  "storyAgent:decisionAgent",
  "scriptAgent:decisionAgent",
  "scriptAgent:supervisionAgent",
  "scriptAgent:storySkeletonAgent",
  "scriptAgent:adaptationStrategyAgent",
  "scriptAgent:scriptAgent",
  "productionAgent:decisionAgent",
  "musicProductionAgent:decisionAgent",
  "productionAgent:supervisionAgent",
  "productionAgent:deriveAssetsAgent",
  "productionAgent:generateAssetsAgent",
  "productionAgent:directorPlanAgent",
  "productionAgent:storyboardGenAgent",
  "productionAgent:storyboardPanelAgent",
  "productionAgent:storyboardTableAgent",
  "universalAi",
];
async function resolveModelName(value: AiType | `${string}:${string}`): Promise<`${string}:${string}`> {
  if (AiTypeValues.includes(value as AiType)) {
    const agentUseModeVal = await u.db("o_setting").where("key", "agentUseMode").first();

    //正常流程
    //高级配置
    if (agentUseModeVal?.value == "1") {
      const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
      if (!agentDeployData?.modelName) throw new Error(`高级配置模式下，未找到对应的模型配置 ${value}`);
      return agentDeployData?.modelName as `${number}:${string}`;
    }
    //简易配置
    if (agentUseModeVal?.value == "0") {
      const [mainly] = value!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`简易配置模式下，未找到部署配置 ${value}`);
      return mainlyData?.modelName as `${number}:${string}`;
    }

    //未查到agentUseModeVal 维持原判断
    const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
    let modelName = null;

    if (!agentDeployData?.modelName) {
      const [mainly] = agentDeployData!.key!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`未找到部署配置 ${value}`);
      modelName = mainlyData.modelName;
    }
    modelName = agentDeployData?.modelName || modelName;
    return modelName as `${number}:${string}`;
  }
  return value as `${number}:${string}`;
}

async function getModelConfig(value: AiType | `${string}:${string}`) {
  if (AiTypeValues.includes(value as AiType)) {
    const agentUseModeVal = await u.db("o_setting").where("key", "agentUseMode").first();
    //正常流程
    //高级配置
    if (agentUseModeVal?.value == "1") {
      const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
      if (!agentDeployData?.modelName) throw new Error(`高级配置模式下，未找到对应的模型配置 ${value}`);
      return agentDeployData;
    }
    //简易配置
    if (agentUseModeVal?.value == "0") {
      const [mainly] = value!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`简易配置模式下，未找到部署配置 ${value}`);
      return mainlyData;
    }

    //未查到 agentUseModelVal 维持原流程
    const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();

    if (!agentDeployData?.modelName) {
      const [mainly] = agentDeployData!.key!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`未找到部署配置 ${value}`);
      return mainlyData;
    }
    return agentDeployData;
  }
  return null;
}

async function getVendorTemplateFn(
  fnName: "textRequest",
  modelName: `${string}:${string}`,
): Promise<(think?: boolean, thinkLevel?: 0 | 1 | 2 | 3) => any>;
async function getVendorTemplateFn(fnName: Exclude<FnName, "textRequest">, modelName: `${string}:${string}`): Promise<(input: any) => any>;
async function getVendorTemplateFn(fnName: FnName, modelName: `${string}:${string}`): Promise<any> {
  const [id, name] = modelName.split(/:(.+)/);
  const vendorConfigData = await u.db("o_vendorConfig").where("id", id).first();
  if (!vendorConfigData) throw new Error(`未找到供应商配置 id=${id}`);
  const modelList = await u.vendor.getModelList(id);
  const selectedModel = modelList.find((i: any) => i.modelName == name);
  if (!selectedModel) throw new Error(`未找到模型 ${name} id=${id}`);
  const runtimeVariant = crypto
    .createHash("sha1")
    .update(`${vendorConfigData.inputValues ?? "{}"}\n${vendorConfigData.models ?? "[]"}`)
    .digest("hex");
  const running = u.vendor.getRuntime(id, runtimeVariant);
  if (running.vendor) {
    Object.assign(running.vendor.inputValues, JSON.parse(vendorConfigData.inputValues ?? "{}"));
    running.vendor.models = modelList;
  }
  const fn = running[fnName];
  if (!fn) throw new Error(`未找到供应商配置中的函数 ${fnName} id=${id}`);
  if (fnName == "textRequest")
    return (think?: boolean, thinkLevel: 0 | 1 | 2 | 3 = 0) => {
      const effectiveThink = think ?? !!selectedModel.think;
      return fn(selectedModel, effectiveThink, thinkLevel);
    };
  else return <T>(input: T) => fn(input, selectedModel);
}

async function getOptionalVendorTemplateFn(fnName: Exclude<FnName, "textRequest">, modelName: `${string}:${string}`): Promise<((input: any) => any) | null> {
  try {
    return await getVendorTemplateFn(fnName, modelName);
  } catch (error) {
    const message = u.error(error).message;
    if (message.includes(fnName)) return null;
    throw error;
  }
}

async function withTaskRecord<T>(
  modelKey: AiType | `${string}:${string}`,
  taskClass: string,
  describe: string,
  relatedObjects: string,
  projectId: number,
  fn: (modelName: `${string}:${string}`, think: Boolean, thinkLevel: 0 | 1 | 2 | 3) => Promise<T>,
): Promise<T> {
  const modelName = await resolveModelName(modelKey);
  const [_, model] = modelName.split(/:(.+)/);
  const taskRecord = await u.task(projectId, taskClass, model, { describe: describe, content: relatedObjects });
  try {
    const result = await fn(modelName, false, 0);

    await taskRecord(1);
    return result;
  } catch (e) {
    await taskRecord(-1, u.error(e).message);
    throw new Error(u.error(e).message);
  }
}

async function urlToBase64(url: string, retries = 3, delay = 1000): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, { responseType: "arraybuffer" });
      const base64 = Buffer.from(res.data).toString("base64");
      return `${base64}`;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise((resolve) => setTimeout(resolve, delay * attempt));
    }
  }
  throw new Error("urlToBase64 failed");
}
class AiText {
  private AiType: AiType | `${string}:${string}`;
  private think?: boolean;
  private thinkLevel: 0 | 1 | 2 | 3;
  constructor(AiType: AiType | `${string}:${string}`, think?: boolean, thinkLevel: 0 | 1 | 2 | 3 = 0) {
    this.AiType = AiType;
    this.think = think;
    this.thinkLevel = thinkLevel;
  }
  private async resolveModel(middleware?: any | any[]) {
    const switchAiDevTool = await u.db("o_setting").where("key", "switchAiDevTool").first();
    const modelName = await resolveModelName(this.AiType);
    aiLog.info("Text model resolved", {
      event: "text.model.resolved",
      requestedModel: this.AiType,
      model: modelName,
    });
    const sdkFn = await getVendorTemplateFn("textRequest", modelName);
    const baseModel = await sdkFn(this.think, this.thinkLevel);
    const mws = [
      ...(switchAiDevTool?.value === "1" ? [devToolsMiddleware()] : []),
      ...(middleware ? (Array.isArray(middleware) ? middleware : [middleware]) : []),
    ];
    return mws.length > 0 ? wrapLanguageModel({ model: baseModel, middleware: mws.length === 1 ? mws[0] : mws }) : baseModel;
  }
  async invoke(input: Omit<Parameters<typeof generateText>[0], "model">) {
    const config = await getModelConfig(this.AiType);

    return generateText({
      ...(input.tools && { stopWhen: stepCountIs(Object.keys(input.tools).length * 50) }),
      ...input,
      model: await this.resolveModel(),
      ...(config?.temperature && { temperature: config.temperature }),
      ...(config?.maxOutputTokens && { maxOutputTokens: config.maxOutputTokens }),
    } as Parameters<typeof generateText>[0]);
  }
  async stream(input: Omit<Parameters<typeof streamText>[0], "model">) {
    const config = await getModelConfig(this.AiType);

    return streamText({
      ...(input.tools && { stopWhen: stepCountIs(Object.keys(input.tools).length * 50) }),
      ...input,
      model: await this.resolveModel(extractReasoningMiddleware({ tagName: "reasoning_content", separator: "\n" })),
      ...(config?.temperature && { temperature: config.temperature }),
      ...(config?.maxOutputTokens && { maxOutputTokens: config.maxOutputTokens }),
    } as Parameters<typeof streamText>[0]);
  }
}

function referenceList2imageBase642(id: string, input: any) {
  const version = u.vendor.getVendor(id).version;
  if (!version || isNaN(parseFloat(version)) || parseFloat(version) < 2.0) {
    input.imageBase64 = input.referenceList.map((item: any) => item.base64);
    return input;
  }
  return input;
}

export type ReferenceList = { type: "image"; base64: string } | { type: "audio"; base64: string } | { type: "video"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface RecoverableImageTask {
  id?: number;
  taskId?: string;
  providerTaskId?: string | null;
  providerSubmittedAt?: number | null;
  attempt?: number | null;
}

interface ImageSubmitResult {
  providerTaskId?: string;
  taskId?: string;
  id?: string;
  pollIntervalMs?: number;
}

interface ImagePollResult {
  completed: boolean;
  data?: string;
  error?: string;
  progress?: number;
  nextPollMs?: number;
}

function imageProviderErrorMessage(error: unknown): string {
  return u.error(error).message || String(error);
}

function isTransientImageProviderError(error: unknown): boolean {
  const message = imageProviderErrorMessage(error);
  const code = typeof error === "object" && error ? String((error as any).code || "") : "";
  return /ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network timeout|timeout of \d+ms exceeded/i.test(
    `${code} ${message}`,
  );
}

function isImageProviderSubmitTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as any).code === "IMAGE_PROVIDER_SUBMIT_TIMEOUT";
}

async function withImageProviderSubmitGuard<T>(
  task: RecoverableImageTask,
  promise: Promise<T>,
  options: { phase: string; progress: number },
): Promise<T> {
  if (!task.id) return promise;
  const startedAt = Date.now();
  let softWarned = false;
  let settled = false;

  const renewLease = async () => {
    if (settled || !task.id) return;
    const elapsedMs = Date.now() - startedAt;
    if (!softWarned && elapsedMs >= IMAGE_PROVIDER_SUBMIT_SOFT_WARN_MS) {
      softWarned = true;
      console.warn("[image-provider] imageSubmit slow provider-request", {
        taskId: task.id,
        taskKey: task.taskId,
        elapsedMs,
        softWarnMs: IMAGE_PROVIDER_SUBMIT_SOFT_WARN_MS,
        hardTimeoutMs: IMAGE_PROVIDER_SUBMIT_HARD_TIMEOUT_MS,
      });
    }
    await updateUnifiedTask(task.id, {
      status: "processing",
      phase: options.phase,
      progress: options.progress,
      leaseExpiresAt: Date.now() + IMAGE_PROVIDER_LEASE_MS,
    });
  };

  const renewTimer = setInterval(() => void renewLease().catch(() => undefined), IMAGE_PROVIDER_LEASE_RENEW_MS);
  renewTimer.unref();
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      const error = new Error("供应商提交超时，未获得任务 ID");
      (error as any).code = "IMAGE_PROVIDER_SUBMIT_TIMEOUT";
      reject(error);
    }, IMAGE_PROVIDER_SUBMIT_HARD_TIMEOUT_MS);
    timer.unref();
  });

  try {
    await renewLease();
    return await Promise.race([promise, timeout]);
  } finally {
    settled = true;
    clearInterval(renewTimer);
  }
}

interface TaskRecord {
  taskClass: string; // 任务分类
  describe: string; // 任务描述
  relatedObjects: string; // 相关对象信息，便于后续分析和追踪
  projectId: number; // 项目ID
}

class AiImage {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: ImageConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    const exec = async (mn: `${string}:${string}`) => {
      const fn = await getVendorTemplateFn("imageRequest", mn);
      await referenceList2imageBase642(mn.split(/:(.+)/)[0], input);
      this.result = await fn(input);
      if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
      return this;
    };
    if (taskRecord) {
      await withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
      return this;
    }
    await exec(modelName);
    return this;
  }
  async runRecoverable(input: ImageConfig, task?: RecoverableImageTask) {
    const modelName = await resolveModelName(this.key);
    const vendorId = modelName.split(/:(.+)/)[0];
    await referenceList2imageBase642(vendorId, input);
    const submit = await getOptionalVendorTemplateFn("imageSubmit", modelName);
    const poll = await getOptionalVendorTemplateFn("imagePoll", modelName);

    if (!submit || !poll || !task?.id) {
      await this.run(input);
      return { pending: false as const, image: this };
    }

    let providerTaskId = task.providerTaskId || "";
    let pollIntervalMs = 3000;
    let providerSubmittedAt = Number(task.providerSubmittedAt || 0);
    if (!providerTaskId) {
      let submitResult: ImageSubmitResult;
      try {
        submitResult = (await withImageProviderSubmitGuard(task, submit(input) as Promise<ImageSubmitResult>, {
          phase: "provider-request",
          progress: 35,
        })) as ImageSubmitResult;
      } catch (error) {
        const message = imageProviderErrorMessage(error);
        const canRetry = isTransientImageProviderError(error) && !isImageProviderSubmitTimeout(error) && Number(task.attempt || 0) <= 1;
        console.warn("[image-provider] imageSubmit failed before providerTaskId", {
          taskId: task.id,
          taskKey: task.taskId,
          attempt: task.attempt,
          canRetry,
          reason: message,
        });
        if (canRetry) {
          await updateUnifiedTask(task.id, {
            status: "queued",
            phase: "provider-submit-retry",
            progress: 35,
            reason: `供应商提交网络异常，准备重试：${message}`,
            availableAt: Date.now() + IMAGE_PROVIDER_SUBMIT_RETRY_DELAY_MS,
            clearLease: true,
          });
          return { pending: true as const };
        }
        throw error;
      }
      providerTaskId = String(submitResult.providerTaskId || submitResult.taskId || submitResult.id || "");
      pollIntervalMs = Number(submitResult.pollIntervalMs || pollIntervalMs);
      if (!providerTaskId) throw new Error("imageSubmit did not return providerTaskId");
      providerSubmittedAt = Date.now();
      await updateUnifiedTask(task.id, {
        status: "processing",
        phase: "provider-processing",
        progress: 45,
        providerTaskId,
        providerSubmittedAt,
      });
      console.info("[image-provider] imageSubmit persisted providerTaskId", {
        taskId: task.id,
        taskKey: task.taskId,
        providerTaskId,
      });
    } else if (!providerSubmittedAt) {
      providerSubmittedAt = Date.now();
      await updateUnifiedTask(task.id, { providerSubmittedAt });
    }

    let pollResult: ImagePollResult;
    try {
      pollResult = (await poll(providerTaskId)) as ImagePollResult;
    } catch (error) {
      const message = imageProviderErrorMessage(error);
      if (isTransientImageProviderError(error)) {
        const elapsedMs = Date.now() - providerSubmittedAt;
        if (elapsedMs >= IMAGE_PROVIDER_TIMEOUT_MS) {
          throw new Error(`图片供应商任务超时，${Math.round(elapsedMs / 1000)} 秒内未返回结果`);
        }
        console.warn("[image-provider] imagePoll transient failure, keeping providerTaskId", {
          taskId: task.id,
          taskKey: task.taskId,
          providerTaskId,
          reason: message,
        });
        await updateUnifiedTask(task.id, {
          status: "queued",
          phase: "provider-processing",
          progress: 50,
          reason: `供应商轮询网络异常，稍后重试：${message}`,
          providerTaskId,
          providerSubmittedAt,
          availableAt: Date.now() + IMAGE_PROVIDER_POLL_RETRY_DELAY_MS,
          clearLease: true,
        });
        return { pending: true as const };
      }
      throw error;
    }
    if (pollResult.error) throw new Error(pollResult.error);
    if (pollResult.completed) {
      if (!pollResult.data) throw new Error("imagePoll completed without data");
      this.result = pollResult.data;
      if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
      return { pending: false as const, image: this };
    }

    const elapsedMs = Date.now() - providerSubmittedAt;
    if (elapsedMs >= IMAGE_PROVIDER_TIMEOUT_MS) {
      throw new Error(`图片供应商任务超时，${Math.round(elapsedMs / 1000)} 秒内未返回结果`);
    }

    const nextPollMs = Math.max(1000, Number(pollResult.nextPollMs || pollIntervalMs || 3000));
    await updateUnifiedTask(task.id, {
      status: "queued",
      phase: "provider-processing",
      progress: pollResult.progress == null ? 50 : Math.max(1, Math.min(99, Number(pollResult.progress))),
      availableAt: Date.now() + nextPollMs,
      providerTaskId,
      clearLease: true,
    });
    return { pending: true as const };
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}

type VideoMode =
  | "singleImage" //单图参考
  | "startEndRequired" //首尾帧（两张都得有）
  | "endFrameOptional" //首尾帧（尾帧可选）
  | "startFrameOptional" //首尾帧（首帧可选）
  | "text" //文本
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[]; //多参考（数字代表限制数量）

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

interface MusicConfig {
  prompt: string;
  durationSec?: number;
  duration?: number;
  vocalMode?: "instrumental" | "vocal" | "optional" | string;
  lyrics?: string;
  referenceList?: Extract<ReferenceList, { type: "audio" }>[];
  outputFormat?: string;
  seed?: number;
  extra?: Record<string, unknown>;
}

class AiVideo {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: VideoConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    try {
      const exec = async (mn: `${string}:${string}`) => {
        const fn = await getVendorTemplateFn("videoRequest", mn);
        await referenceList2imageBase642(mn.split(/:(.+)/)[0], input);

        this.result = await fn(input);

        if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
      };
      if (taskRecord) {
        await withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
        return this;
      }
      await exec(modelName);
      return this;
    } catch (e) {
      throw e;
    }
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}
class AiAudio {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: VideoConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    const exec = async (mn: `${string}:${string}`) => {
      try {
        const fn = await getVendorTemplateFn("ttsRequest", mn);
        await referenceList2imageBase642(mn.split(/:(.+)/)[0], input);
        this.result = await fn(input);

        if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
        return this;
      } catch (e) {}
    };
    if (taskRecord) {
      return withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
    }
    return await exec(modelName);
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}
class AiMusic {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: MusicConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    const exec = async (mn: `${string}:${string}`) => {
      const fn = await getVendorTemplateFn("musicRequest", mn);
      await referenceList2imageBase642(mn.split(/:(.+)/)[0], input);
      this.result = await fn(input);
      if (!this.result) throw new Error("musicRequest did not return audio data");
      if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
      return this;
    };
    if (taskRecord) {
      return withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
    }
    return await exec(modelName);
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result.replace(/^data:audio\/[^;]+;base64,/, ""));
    return this;
  }
}

export default {
  Text: (AiType: AiType | `${string}:${string}`, think?: boolean, thinkLevel?: 0 | 1 | 2 | 3) => new AiText(AiType, think, thinkLevel),
  Image: (key: `${string}:${string}`) => new AiImage(key),
  Video: (key: `${string}:${string}`) => new AiVideo(key),
  Audio: (key: `${string}:${string}`) => new AiAudio(key),
  Music: (key: `${string}:${string}`) => new AiMusic(key),
};
