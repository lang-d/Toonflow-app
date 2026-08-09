import { tool, jsonSchema, Tool } from "ai";
import { z } from "zod";
import _ from "lodash";
import ResTool from "@/socket/resTool";
import u from "@/utils";
import {
  parseStoryboardTableRow,
  storyboardGroupPlanV2Schema,
  storyboardTableRowV3Schema,
} from "@/services/storyboardTableContract";
import {
  appendStoryboardRows,
  beginStoryboardGeneration,
  commitStoryboardGeneration,
  inspectStoryboardTableChange,
  readStoryboardGenerationDraft,
  storyboardValidationDecisionSummary,
} from "@/services/storyboardGeneration";
import {
  DIRECTOR_PLAN_SECTION_KEYS,
  appendDirectorPlanSection,
  assertDirectorPlanGenerationScope,
  beginDirectorPlanGeneration,
  commitDirectorPlanGeneration,
  readDirectorPlanAsset,
} from "@/services/directorPlanGeneration";
import { getTextAssetContent } from "@/services/textAsset";
import { applyStoryboardPanelImageFieldsWithDb, updateDeriveAssetPrompt } from "@/services/imageFlow";
import { buildProductionFlowDataKey } from "@/services/productionFlowData";
import {
  accessProductionResource,
  createProductionResourceRef,
  isProductionResourceKey,
} from "@/services/productionResource";
import { VISUAL_ASSET_TYPES, isVisualAssetType } from "@/services/assetTypes";
import { cleanupAssetRelations } from "@/services/scriptAssetBinding";
import { enqueueAssetImageGeneration } from "@/services/assetImageGeneration";
import { enqueueStoryboardImageGeneration } from "@/services/storyboardImageGeneration";
import {
  PROJECT_MATERIAL_CATEGORIES,
  getProjectContextPack,
  listProjectMaterials,
  readProjectMaterial,
} from "@/services/projectMaterial";
import {
  replaceStoryboardTableAgentReviewSuggestions,
  resolveStoryboardTableAgentReviewItemTargets,
} from "@/services/productionReview";
import { recordAgentRunEvent, type AgentRunContext } from "@/services/agentRun";
import {
  readStoryboardPanelSources,
  readStoryboardPanelTargets,
} from "@/services/storyboardPanelReviewScope";
import {
  storyboardGroupPreflightSchema,
  validateStoryboardGroupPreflightStructure,
  type StoryboardGroupPreflight,
} from "@/services/storyboardGroupPreflightContract";

function emitBestEffort(socket: { emit(event: string, ...args: unknown[]): unknown }, event: string, payload: unknown) {
  try {
    socket.emit(event, payload, () => undefined);
  } catch (error) {
    console.warn("[productionAgent] UI notification failed", event, u.error(error).message);
  }
  return Promise.resolve(undefined);
}

const deriveAssetSchema = z.object({
  id: z.number().describe("衍生资产ID,如果新增则为空"),
  assetsId: z.number().describe("关联的资产ID"),
  prompt: z.string().describe("生成提示词"),
  name: z.string().describe("衍生资产名称"),
  desc: z.string().describe("衍生资产描述"),
  src: z.string().nullable().describe("衍生资产资源路径"),
  state: z.enum(["未生成", "生成中", "已完成", "生成失败"]).describe("衍生资产生成状态"),
  type: z.enum(VISUAL_ASSET_TYPES).describe("衍生资产类型"),
});
export const assetItemSchema = z.object({
  id: z.number().describe("资产唯一标识"),
  name: z.string().describe("资产名称"),
  type: z.enum(VISUAL_ASSET_TYPES).describe("资产类型"),
  prompt: z.string().describe("生成提示词"),
  desc: z.string().describe("资产描述"),
  derive: z.array(deriveAssetSchema).describe("衍生资产列表"),
});

const assetAudioBindingSchema = z.object({
  assetId: z.number().describe("Visual asset ID that owns the audio binding"),
  audioAssetId: z.number().describe("Audio library parent asset ID"),
  name: z.string().describe("Audio asset name"),
  desc: z.string().describe("Audio asset description"),
  src: z.string().optional().describe("Audio parent preview URL when available"),
  files: z.array(
    z.object({
      id: z.number().describe("Audio file asset ID"),
      audioAssetId: z.number().describe("Audio library parent asset ID"),
      name: z.string(),
      prompt: z.string(),
      desc: z.string(),
      src: z.string(),
      state: z.string(),
      errorReason: z.string(),
    }),
  ),
});

interface GenerateDeriveAssetAck {
  success?: boolean;
  message?: unknown;
}

interface GenerateStoryboardAck {
  success?: boolean;
  message?: unknown;
}

interface GenerateDeriveAssetResult {
  total?: number;
  tasks?: Array<{ assetId?: number; id?: number }>;
  successCount?: number;
  failedCount?: number;
  errors?: Array<{ assetId?: number; error?: string; message?: string }>;
}

interface GenerateStoryboardResult {
  total?: number;
  tasks?: Array<{ storyboardId?: number; id?: number }>;
  successCount?: number;
  failedCount?: number;
  errors?: Array<{ storyboardId?: number; error?: string; message?: string }>;
}

function stringifyAckMessage(value: unknown) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function submitImageGeneration<T>(
  _socket: unknown,
  event: "generateDeriveAsset" | "generateStoryboard",
  payload: { ids: number[] },
  _timeout?: unknown,
  context?: Record<string, unknown>,
): Promise<T> {
  const projectId = Number(context?.projectId);
  const scriptId = Number(context?.scriptId);
  if (!Number.isFinite(projectId) || !Number.isFinite(scriptId)) {
    throw new Error("Production agent image generation requires a project and script scope");
  }
  const ids = Array.from(new Set(payload.ids.map(Number).filter(Number.isFinite)));
  if (!ids.length) throw new Error("Image generation requires at least one target ID");

  if (event === "generateStoryboard") {
    const result = await enqueueStoryboardImageGeneration({ projectId, scriptId, storyboardIds: ids });
    return { success: Number(result.successCount || 0) > 0 || result.failedCount === 0, message: result } as T;
  }

  const rows = await u
    .db("o_assets")
    .where({ projectId })
    .whereIn("id", ids)
    .whereNotNull("assetsId")
    .select("id", "type", "name", "prompt");
  const found = new Set(rows.map((row: any) => Number(row.id)));
  const errors = ids
    .filter((id) => !found.has(id))
    .map((assetId) => ({ assetId, error: "Derived asset does not belong to the current project" }));
  const supported = rows.filter((row: any) => isVisualAssetType(row.type));
  errors.push(
    ...rows
      .filter((row: any) => !isVisualAssetType(row.type))
      .map((row: any) => ({ assetId: Number(row.id), error: `Unsupported visual asset type: ${row.type || "unknown"}` })),
  );
  const submitted = supported.length
    ? await enqueueAssetImageGeneration({
        projectId,
        items: supported.map((row: any) => ({
          id: Number(row.id),
          type: row.type,
          name: String(row.name || "Derived asset"),
          prompt: String(row.prompt || ""),
        })),
      })
    : { total: 0, tasks: [] as any[] };
  const result: GenerateDeriveAssetResult = {
    total: submitted.total + errors.length,
    tasks: submitted.tasks,
    successCount: submitted.tasks.length,
    failedCount: errors.length,
    errors,
  };
  return { success: Number(result.successCount || 0) > 0 || result.failedCount === 0, message: result } as T;
}

function normalizeGenerateDeriveAssetResult(value: unknown): GenerateDeriveAssetResult {
  const result = value && typeof value === "object" ? (value as GenerateDeriveAssetResult) : {};
  const tasks = Array.isArray(result.tasks) ? result.tasks : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  return {
    ...result,
    tasks,
    errors,
    successCount: Number.isFinite(Number(result.successCount)) ? Number(result.successCount) : tasks.length,
    failedCount: Number.isFinite(Number(result.failedCount)) ? Number(result.failedCount) : errors.length,
    total: Number.isFinite(Number(result.total)) ? Number(result.total) : tasks.length + errors.length,
  };
}

function normalizeGenerateStoryboardResult(value: unknown): GenerateStoryboardResult {
  if (Array.isArray(value)) {
    const tasks = value
      .filter((item: any) => item?.taskId || item?.unifiedTaskId || item?.legacyTaskId)
      .map((item: any) => ({ storyboardId: item.id }));
    const errors = value
      .filter((item: any) => item?.status === "failed" || item?.state === "生成失败")
      .map((item: any) => ({ storyboardId: item.id, error: item.reason || "创建失败" }));
    return {
      total: value.length,
      tasks,
      errors,
      successCount: tasks.length,
      failedCount: errors.length,
    };
  }
  const result = value && typeof value === "object" ? (value as GenerateStoryboardResult) : {};
  const tasks = Array.isArray(result.tasks) ? result.tasks : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  return {
    ...result,
    tasks,
    errors,
    successCount: Number.isFinite(Number(result.successCount)) ? Number(result.successCount) : tasks.length,
    failedCount: Number.isFinite(Number(result.failedCount)) ? Number(result.failedCount) : errors.length,
    total: Number.isFinite(Number(result.total)) ? Number(result.total) : tasks.length + errors.length,
  };
}

export function structuredGenerateDeriveAssetToolResult(ids: number[], result: GenerateDeriveAssetResult) {
  const requestedIds = [...new Set(ids.map(Number).filter(Number.isFinite))];
  const submittedIds = (result.tasks || [])
    .map((item) => Number(item.assetId ?? item.id))
    .filter(Number.isFinite);
  const explicitlyFailed = (result.errors || []).map((item) => ({
    assetId: item.assetId == null ? null : Number(item.assetId),
    reason: item.error || item.message || "image generation task was not created",
  }));
  const accountedIds = new Set([
    ...submittedIds,
    ...explicitlyFailed.map((item) => item.assetId).filter((id): id is number => id != null && Number.isFinite(id)),
  ]);
  const inferredFailures = requestedIds
    .filter((id) => !accountedIds.has(id))
    .map((assetId) => ({ assetId, reason: "image generation result did not report a submitted task" }));
  const failedTargets = [...explicitlyFailed, ...inferredFailures];
  return {
    status: failedTargets.length ? ("partial" as const) : ("complete" as const),
    requestedIds,
    submittedIds,
    failedTargets,
    successCount: submittedIds.length,
    failedCount: failedTargets.length,
    summary: `已创建 ${submittedIds.length} 个衍生资产生图任务，${failedTargets.length} 个创建失败。`,
  };
}

export function structuredGenerateStoryboardToolResult(ids: number[], result: GenerateStoryboardResult) {
  const requestedIds = [...new Set(ids.map(Number).filter(Number.isFinite))];
  const submittedIds = (result.tasks || [])
    .map((item) => Number(item.storyboardId ?? item.id))
    .filter(Number.isFinite);
  const explicitlyFailed = (result.errors || []).map((item) => ({
    storyboardId: item.storyboardId == null ? null : Number(item.storyboardId),
    reason: item.error || item.message || "image generation task was not created",
  }));
  const accountedIds = new Set([
    ...submittedIds,
    ...explicitlyFailed
      .map((item) => item.storyboardId)
      .filter((id): id is number => id != null && Number.isFinite(id)),
  ]);
  const inferredFailures = requestedIds
    .filter((id) => !accountedIds.has(id))
    .map((storyboardId) => ({ storyboardId, reason: "image generation result did not report a submitted task" }));
  const failedTargets = [...explicitlyFailed, ...inferredFailures];
  return {
    status: failedTargets.length ? ("partial" as const) : ("complete" as const),
    requestedIds,
    submittedIds,
    failedTargets,
    successCount: submittedIds.length,
    failedCount: failedTargets.length,
    summary: `已创建 ${submittedIds.length} 个分镜图生成任务，${failedTargets.length} 个创建失败。`,
  };
}

const storyboardSchema = z.object({
  id: z.number().describe("分镜ID，必须为真实id"),
  duration: z.number().describe("持续时长(秒)"),
  prompt: z.string().describe("生成提示词"),
  associateAssetsIds: z.array(z.number()).describe("关联资产ID列表"),
  src: z.string().nullable().describe("分镜资源路径"),
  index: z.number().nullable().optional().describe("分镜排序字段"),
  groupKey: z.string().optional().describe("ASCII storyboard group key, e.g. G01/G02/G03"),
  groupName: z.string().optional().describe("Human-readable storyboard group name"),
  groupIntent: z.string().optional().describe("Storyboard group dramatic intent"),
  beatId: z.string().optional().describe("Beat id inside the storyboard group"),
  tableRowJson: z.string().nullable().optional().describe("唯一结构化分镜事实 JSON"),
  factStatus: z.enum(["draft", "ready", "legacy"]).optional().describe("分镜事实状态"),
  factVersion: z.number().int().positive().nullable().optional(),
  location: z.string().optional(),
  timeOfDay: z.string().optional(),
  sceneContinuityId: z.string().nullable().optional(),
  shotDescription: z.string().optional(),
  picture: z.string().optional(),
  action: z.string().optional(),
  shotSize: z.string().optional(),
  cameraMove: z.string().optional(),
  cameraAngle: z.string().nullable().optional(),
  transitionFromPrevious: z.string().nullable().optional(),
  dialogue: z.string().optional(),
  sound: z.string().optional(),
  visibleEmotion: z.string().optional(),
  characters: z.array(z.any()).optional(),
  requiredAssets: z.array(z.any()).optional(),
});
const workbenchDataSchema = z.object({
  name: z.string().describe("项目名称"),
  duration: z.string().describe("视频时长"),
  resolution: z.string().describe("分辨率"),
  fps: z.string().describe("帧率"),
  cover: z.string().optional().describe("封面图片路径"),
  gradient: z.string().optional().describe("渐变色配置"),
});
const storyboardGenerationLastFailureSchema = z
  .object({
    generationId: z.string(),
    state: z.enum(["invalid", "failed"]),
    expectedRowCount: z.number().nullable().optional(),
    errorJson: z.string().nullable().optional(),
    updatedAt: z.number().nullable().optional(),
  })
  .nullable()
  .describe("Latest invalid or failed storyboard-table generation diagnostics");
const beginStoryboardTableInputSchema = z.object({
  projectId: z.number().optional(),
  scriptId: z.number().optional(),
}).strict();
const prepareStoryboardTableInputSchema = storyboardGroupPreflightSchema;

const storyboardTableDecisionInputSchema = z.object({
  intent: z.enum(["new_generation", "review_revision", "custom_revision", "accept_current", "clarify"]),
  rationale: z.string().trim().min(1),
});
const updateAgentProgressInputSchema = z.object({
  stage: z.string().trim().min(1).max(100),
  subAgent: z.string().trim().min(1).max(100).optional(),
  title: z.string().trim().min(1).max(240),
  detail: z.string().trim().max(2000).optional(),
  phase: z.string().trim().max(80).optional(),
});
const listStoryboardGenerationsInputSchema = z.object({
  limit: z.number().int().min(1).max(20).optional().default(10),
});
const readStoryboardGenerationInputSchema = z
  .object({
    generationId: z.string().uuid().optional(),
    revision: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional().default(0),
    limit: z.number().int().min(1).max(20).optional().default(10),
  })
  .refine((input) => Boolean(input.generationId) !== Boolean(input.revision), {
    message: "Provide exactly one of generationId or revision",
  });
const readStoryboardPanelTargetsInputSchema = z
  .object({
    snapshotId: z.string().length(64).optional(),
    offset: z.number().int().nonnegative().optional().default(0),
    limit: z.number().int().min(1).max(20).optional().default(10),
    storyboardIds: z.array(z.number().int().positive()).min(1).max(20).optional(),
  })
  .refine((input) => !input.storyboardIds || input.offset === 0, {
    message: "Do not combine storyboardIds with a non-zero offset",
  });
const readStoryboardPanelSourcesInputSchema = z.object({
  snapshotId: z.string().length(64),
  storyboardIds: z.array(z.number().int().positive()).min(1).max(20),
});
const listProductionReviewsInputSchema = z.object({
  target: z.enum(["directorPlan", "storyboardTable", "storyboardPanel", "general"]).optional(),
  limit: z.number().int().min(1).max(20).optional().default(10),
});
const readProductionReviewInputSchema = z
  .object({
    reviewRunId: z.string().trim().min(1).optional(),
    textAssetId: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional().default(0),
    limit: z.number().int().min(1).max(64 * 1024).optional().default(16000),
  })
  .refine((input) => Boolean(input.reviewRunId) !== Boolean(input.textAssetId), {
    message: "Provide exactly one of reviewRunId or textAssetId",
  });
const readTextAssetInputSchema = z.object({
  id: z.number().int().positive(),
  offset: z.number().int().nonnegative().optional().default(0),
  limit: z.number().int().min(1).max(64 * 1024).optional().default(16000),
});
const listDirectorPlanGenerationsInputSchema = z.object({
  limit: z.number().int().min(1).max(20).optional().default(10),
});
const readDirectorPlanGenerationInputSchema = z
  .object({
    textAssetId: z.number().int().positive().optional(),
    version: z.number().int().positive().optional(),
  })
  .refine((input) => Boolean(input.textAssetId) !== Boolean(input.version), {
    message: "Provide exactly one of textAssetId or version",
  });

const appendStoryboardRowsInputSchema = z.object({
  generationId: z.string().uuid(),
  startIndex: z.number().int().nonnegative(),
  rows: z.array(storyboardTableRowV3Schema).min(1).max(10),
});

const commitStoryboardTableInputSchema = z.object({
  generationId: z.string().uuid(),
});
const inspectStoryboardTableChangeInputSchema = z.object({
  generationId: z.string().uuid().optional(),
  compareToGenerationId: z.string().uuid().optional(),
});
const getStoryboardGenerationDraftInputSchema = z.object({
  generationId: z.string().uuid(),
  offset: z.number().int().nonnegative().optional().default(0),
  limit: z.number().int().min(1).max(10).optional().default(10),
});
const awaitUserDecisionInputSchema = z.object({
  stage: z.string().trim().min(1).max(100),
  question: z.string().trim().min(1).max(2000),
  options: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(100),
        label: z.string().trim().min(1).max(200),
        description: z.string().trim().max(500).optional(),
      }),
    )
    .max(5)
    .optional()
    .default([]),
  context: z.record(z.string(), z.unknown()).optional().default({}),
});
const storyboardTableReviewItemSchema = z.object({
  scope: z.enum(["global", "storyboard", "director_plan", "asset"]).default("storyboard"),
  storyboardId: z.number().int().positive().optional(),
  storyboardIndex: z.number().int().nonnegative().optional(),
  issueType: z.string().trim().min(1).max(120),
  severity: z.enum(["info", "warning", "blocking"]),
  field: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(1000),
  reason: z.string().trim().min(1).max(3000),
  suggestedAction: z.string().trim().min(1).max(2000),
  owner: z.enum(["storyboardTable", "deriveAssets", "directorPlan"]),
}).superRefine((item, ctx) => {
  if (item.scope === "storyboard" && item.storyboardIndex == null) {
    ctx.addIssue({ code: "custom", message: "storyboard scope requires storyboardIndex" });
  }
});
const recordStoryboardTableReviewInputSchema = z.object({
  items: z.array(storyboardTableReviewItemSchema).max(100),
});
const directorPlanGenerationStateSchema = z.object({
  current: z
    .object({
      generationId: z.string(),
      state: z.string(),
      textAssetId: z.number().nullable().optional(),
      version: z.number().nullable().optional(),
      updatedAt: z.number(),
    })
    .nullable(),
  lastFailure: z
    .object({
      generationId: z.string(),
      state: z.string(),
      errorJson: z.string().nullable().optional(),
      updatedAt: z.number(),
    })
    .nullable(),
});
const beginDirectorPlanInputSchema = z.object({
  projectId: z.number().optional(),
  scriptId: z.number().optional(),
});
const appendDirectorPlanSectionInputSchema = z.object({
  generationId: z.string().uuid(),
  sectionKey: z.enum(DIRECTOR_PLAN_SECTION_KEYS),
  chunkIndex: z.number().int().nonnegative(),
  content: z.string().min(1),
});
const commitDirectorPlanInputSchema = z.object({
  generationId: z.string().uuid(),
  videoStyle: z.string().trim().min(1).max(400),
});
const getDirectorPlanAssetInputSchema = z.object({ textAssetId: z.number().int().positive() });
const updateStoryboardPanelInputSchema = z.object({
  projectId: z.number().optional(),
  scriptId: z.number().optional(),
  mode: z.enum(["update", "replace"]).optional().default("update"),
  items: z.array(
    z.object({
      storyboardId: z.number().optional(),
      index: z.number().optional(),
      prompt: z.string(),
      shouldGenerateImage: z.boolean(),
      associateAssetsIds: z.array(z.number()).optional().default([]),
    }),
  ),
});
export const addDeriveAssetInputSchema = z.object({
  assetsId: z.number().describe("关联的父资产 ID"),
  id: z.union([z.number(), z.literal("null"), z.literal(""), z.null()]).optional().describe("衍生资产 ID，新增填 null"),
  name: z.string().describe("衍生资产名称"),
  desc: z.string().describe("中文视觉差异说明，不是生图提示词"),
  prompt: z.string().min(1).describe("可直接用于生图的中文提示词"),
  promptMode: z.enum(["preserve", "replace"]).optional().default("preserve").describe("保留或覆盖共享画布主节点提示词"),
  type: z.enum(VISUAL_ASSET_TYPES).optional().describe("衍生资产类型，由父资产类型校验"),
});
const posterItemSchema = z.object({
  id: z.number().describe("海报ID"),
  image: z.string().describe("海报图片路径"),
});
export const flowDataSchema = z.object({
  project: z
    .object({
      id: z.union([z.number(), z.string()]),
      name: z.string(),
      projectType: z.string(),
      type: z.string(),
      artStyle: z.string(),
      directorManual: z.string(),
      imageModel: z.string(),
      videoModel: z.string(),
      videoRatio: z.string(),
      mode: z.string(),
    })
    .nullable()
    .describe("当前项目配置"),
  assetAudioBindings: z.array(assetAudioBindingSchema).describe("Visual asset audio bindings"),
  script: z.string().describe("剧本内容"),
  scriptPlan: z.string().describe("拍摄计划"),
  directorPlanGeneration: directorPlanGenerationStateSchema.describe("Director-plan generation state and diagnostics"),
  assets: z.array(assetItemSchema).describe("衍生资产"),
  storyboardTable: z.string().describe("分镜表"),
  storyboard: z.array(storyboardSchema).describe("分镜面板"),
  storyboardGenerationLastFailure: storyboardGenerationLastFailureSchema,
});

export type FlowData = z.infer<typeof flowDataSchema>;

const flowDataKeys = Object.keys(flowDataSchema.shape) as [keyof FlowData, ...Array<keyof FlowData>];
const keySchema = z.enum(flowDataKeys);
const projectMaterialCategorySchema = z.enum(PROJECT_MATERIAL_CATEGORIES);
const flowDataKeyList = flowDataKeys.join(", ");
const flowDataKeyLabels = Object.fromEntries(
  Object.entries(flowDataSchema.shape).map(([key, schema]) => [key, (schema as z.ZodTypeAny).description ?? key]),
) as Record<keyof FlowData, string>;

interface ToolConfig {
  resTool: ResTool;
  toolsNames?: string[];
  msg: ReturnType<ResTool["newMessage"]>;
  runContext?: AgentRunContext;
  continuation?: {
    kind: "awaiting_user" | "resumable_interruption";
    run: { runId: string; currentStage: string | null; currentSubAgent: string | null };
    decision?: unknown;
    checkpoint?: unknown;
  } | null;
  storyboardProgress?: {
    appendText(text: string): unknown;
    updateTitle(title: string): unknown;
    complete(): unknown;
  };
}

function scopedNumber(value: unknown, field: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`missing production agent ${field}`);
  return number;
}

function assertOptionalScopeMatches(input: { projectId?: number; scriptId?: number }, projectId: number, scriptId: number) {
  if (input.projectId != null && Number(input.projectId) !== projectId) {
    throw new Error(`projectId ${input.projectId} does not match current production agent projectId ${projectId}`);
  }
  if (input.scriptId != null && Number(input.scriptId) !== scriptId) {
    throw new Error(`scriptId ${input.scriptId} does not match current production agent scriptId ${scriptId}`);
  }
}

function normalizeToolError(error: any) {
  if (!error) return { code: "UNKNOWN_ERROR", message: "unknown error" };
  if (typeof error === "string") return { code: "ERROR", message: error };
  return {
    ...error,
    code: String(error.code || "ERROR"),
    message: String(error.message || error.reason || "unknown error"),
  };
}

function shortStoryboardCommitMessage(result: any) {
  if (result?.status === "invalid") {
    const issue = Array.isArray(result.issues) ? result.issues[0] : null;
    return issue ? `${issue.field || "storyboard"}: ${issue.message || "validation failed"}` : "storyboard table validation failed";
  }
  if (result?.status === "failed") {
    const error = normalizeToolError(result.error);
    if (error.code === "COMMIT_IN_PROGRESS") return "提交仍被后端任务占用，请稍后重试或重新开始分镜表生成。";
    if (error.code === "GENERATION_SUPERSEDED") return "当前分镜表 generation 已被新的写入轮次替代，请停止本轮执行。";
    return error.message;
  }
  return "";
}

function parseJsonSafe(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseGroupCount(value: unknown) {
  const parsed = parseJsonSafe(value);
  return Array.isArray(parsed) ? parsed.length : 0;
}

function reviewTargetMatches(stage: string | null | undefined, target?: string) {
  if (!target) return /^supervision/.test(String(stage || ""));
  if (target === "storyboardTable") return stage === "supervisionStoryboardTable";
  if (target === "storyboardPanel") return stage === "supervisionStoryboardPanel";
  if (target === "directorPlan") return stage === "supervisionDirectorPlan";
  return stage === "supervision";
}

export default (toolCpnfig: ToolConfig) => {
  const { resTool, toolsNames, msg, runContext, continuation, storyboardProgress } = toolCpnfig;
  const { socket } = resTool;
  let storyboardTableTerminalFailure = false;
  let storyboardPreflight: StoryboardGroupPreflight | null = null;
  let storyboardGenerationId: string | null = null;
  let storyboardRowsWritten = 0;

  const canonicalGroups = (groups: Array<z.infer<typeof storyboardGroupPlanV2Schema>>) =>
    groups.map((group) => storyboardGroupPlanV2Schema.parse(group));

  const tools: Record<string, Tool> = {
    get_flowData: tool({
      description:
        "获取一个工作区事实。小对象直接返回；script、scriptPlan、storyboardTable、assets、assetAudioBindings、storyboard 返回版本绑定的 resourceRef，必须再用 resource_access 按需读取。",
      inputSchema: jsonSchema<{ key: keyof FlowData }>(
        z
          .object({
            key: keySchema.describe("数据key"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ key }) => {
        const parsedKey = keySchema.safeParse(key);
        if (!parsedKey.success) {
          const message =
            `Unsupported flowData key: ${String(key)}. Available keys: ${flowDataKeyList}. ` +
            "director_planning_style is a skill; load it with activate_skill.";
          console.warn("[tools] get_flowData invalid key", key);
          return { error: message };
        }
        const flowKey = parsedKey.data;
        const thinking = msg.thinking(`正在获取${flowDataKeyLabels[flowKey]}工作区数据...`);
        console.log("[tools] get_flowData", flowKey);
        try {
          const projectId = scopedNumber(resTool.data.projectId, "projectId");
          const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
          const value = isProductionResourceKey(flowKey)
            ? await createProductionResourceRef(projectId, scriptId, flowKey)
            : await buildProductionFlowDataKey(projectId, scriptId, flowKey);
          thinking.appendText(`读取到${flowDataKeyLabels[flowKey]}:\n` + JSON.stringify(value, null, 2));
          thinking.updateTitle(`获取${flowDataKeyLabels[flowKey]}完成`);
          thinking.complete();
          return value;
        } catch (error: any) {
          thinking.appendText(u.error(error).message);
          thinking.updateTitle?.("get_flowData failed");
          thinking.complete();
          storyboardTableTerminalFailure = true;
          throw error;
        }
      },
    }),
    resource_access: tool({
      description:
        "Access a version-bound production resource returned by get_flowData. stat reports size, search performs literal search, and read returns an exact character or collection-item range. Follow nextCursor until eof when the task requires complete coverage.",
      inputSchema: jsonSchema<{
        resourceRef: string;
        operation: "stat" | "search" | "read";
        query?: string;
        position?: number;
        cursor?: string;
        limit?: number;
      }>(
        z
          .object({
            resourceRef: z.string().min(1),
            operation: z.enum(["stat", "search", "read"]),
            query: z.string().optional(),
            position: z.number().int().min(0).optional(),
            cursor: z.string().min(1).optional(),
            limit: z.number().int().positive().optional(),
          })
          .toJSONSchema(),
      ),
      execute: async (input) => {
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        return accessProductionResource({ projectId, scriptId }, input);
      },
    }),
    update_agent_progress: tool({
      description:
        "Report the agent's current business progress for panel recovery. This does not finish the run and does not change production facts.",
      inputSchema: jsonSchema<z.infer<typeof updateAgentProgressInputSchema>>(
        updateAgentProgressInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = updateAgentProgressInputSchema.parse(raw);
        if (!runContext) return { recorded: false, reason: "no agent run context" };
        await runContext.updateProgress({
          stage: input.stage,
          subAgent: input.subAgent ?? null,
          title: input.title,
          detail: input.detail ?? null,
          phase: input.phase ?? null,
        });
        return { recorded: true, ...input };
      },
    }),
    complete_agent_run: tool({
      description:
        "Explicitly finish this Agent Run after the requested work is complete. This only records the model-declared terminal state and does not change production facts.",
      inputSchema: jsonSchema<{ stage: string; subAgent?: string; summary?: string }>(
        z.object({ stage: z.string().min(1).max(100), subAgent: z.string().min(1).max(100).optional(), summary: z.string().max(2000).optional() }).toJSONSchema(),
      ),
      execute: async (input) => {
        if (!runContext) throw new Error("Agent Run context is required to complete a run");
        runContext.setCompleted({
          stage: input.stage,
          subAgent: input.subAgent,
          reason: input.summary || "",
          resultJson: { kind: "agent_completed", summary: input.summary ?? null },
        });
        return { status: "completed", terminal: true, ...input };
      },
    }),
    list_storyboard_generations: tool({
      description:
        "List storyboard-table generation versions for the current project/script. Returns metadata only; call read_storyboard_generation for rows.",
      inputSchema: jsonSchema<z.infer<typeof listStoryboardGenerationsInputSchema>>(
        listStoryboardGenerationsInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = listStoryboardGenerationsInputSchema.parse(raw);
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        const rows = await u
          .db("o_storyboardGeneration")
          .where({ projectId, scriptId })
          .orderBy("updatedAt", "desc")
          .limit(input.limit);
        const generations = await Promise.all(
          rows.map(async (row: any) => {
            const countRow = await u
              .db("o_storyboardGenerationRow")
              .where({ generationId: row.generationId })
              .count<{ count: number }[]>({ count: "*" })
              .first();
            return {
              generationId: String(row.generationId),
              state: String(row.state || ""),
              revision: row.revision == null ? null : Number(row.revision),
              expectedRowCount: Number(row.expectedRowCount || 0),
              rowCount: Number(countRow?.count || 0),
              groupCount: parseGroupCount(row.groupPlanJson),
              createdAt: row.createdAt == null ? null : Number(row.createdAt),
              updatedAt: row.updatedAt == null ? null : Number(row.updatedAt),
              hasError: Boolean(row.errorJson),
            };
          }),
        );
        return { projectId, scriptId, generations };
      },
    }),
    read_storyboard_generation: tool({
      description:
        "Read one storyboard-table generation by generationId or committed revision. Use this before cross-version repair.",
      inputSchema: jsonSchema<z.infer<typeof readStoryboardGenerationInputSchema>>(
        readStoryboardGenerationInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = readStoryboardGenerationInputSchema.parse(raw);
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        let query = u.db("o_storyboardGeneration").where({ projectId, scriptId });
        if (input.generationId) query = query.andWhere("generationId", input.generationId);
        else query = query.andWhere("revision", input.revision).orderBy("updatedAt", "desc");
        const generation = await query.first();
        if (!generation) throw new Error("Storyboard generation not found in current project/script");
        const offset = Math.max(0, Number(input.offset || 0));
        const limit = Math.min(20, Math.max(1, Number(input.limit || 10)));
        const rowQuery = u
          .db("o_storyboardGenerationRow")
          .where({ generationId: generation.generationId })
          .orderBy("rowIndex", "asc");
        const [rows, totalRow] = await Promise.all([
          rowQuery.clone().offset(offset).limit(limit),
          rowQuery.clone().count<{ count: number }[]>({ count: "*" }).first(),
        ]);
        const total = Number(totalRow?.count || 0);
        return {
          generation: {
            generationId: String(generation.generationId),
            state: String(generation.state || ""),
            revision: generation.revision == null ? null : Number(generation.revision),
            expectedRowCount: Number(generation.expectedRowCount || 0),
            groups: parseJsonSafe(generation.groupPlanJson) || [],
            error: parseJsonSafe(generation.errorJson),
            createdAt: generation.createdAt == null ? null : Number(generation.createdAt),
            updatedAt: generation.updatedAt == null ? null : Number(generation.updatedAt),
          },
          offset,
          limit,
          total,
          nextOffset: offset + rows.length < total ? offset + rows.length : null,
          eof: offset + rows.length >= total,
          rows: rows.map((row: any) => ({ index: Number(row.rowIndex), row: parseJsonSafe(row.rowJson) })),
        };
      },
    }),
    inspect_storyboard_table_change: tool({
      description:
        "Inspect the factual difference between a committed storyboard generation and a baseline generation. Returns counts, index and group changes, changed field names, and whether the formal table matches the target. It does not judge whether the change is correct.",
      inputSchema: jsonSchema<z.infer<typeof inspectStoryboardTableChangeInputSchema>>(
        inspectStoryboardTableChangeInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = inspectStoryboardTableChangeInputSchema.parse(raw);
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        const result = await inspectStoryboardTableChange({ projectId, scriptId, ...input });
        if (runContext) {
          await recordAgentRunEvent(runContext.runId, "storyboard_table_change_inspected", {
            projectId,
            scriptId,
            targetGenerationId: result.target.generationId,
            baselineGenerationId: result.baseline?.generationId ?? null,
            targetRevision: result.target.revision,
            baselineRevision: result.baseline?.revision ?? null,
            formalMatchesTargetGeneration: result.formal.matchesTargetGeneration,
          });
        }
        return result;
      },
    }),
    read_storyboard_panel_targets: tool({
      description:
        "Read only the current storyboard-panel review targets. Returns prompt, associateAssetsIds and shouldGenerateImage without upstream storyboard facts.",
      inputSchema: jsonSchema<z.infer<typeof readStoryboardPanelTargetsInputSchema>>(
        readStoryboardPanelTargetsInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = readStoryboardPanelTargetsInputSchema.parse(raw);
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        return readStoryboardPanelTargets({
          projectId,
          scriptId,
          snapshotId: input.snapshotId,
          offset: input.offset,
          limit: input.limit,
          storyboardIds: input.storyboardIds,
        });
      },
    }),
    read_storyboard_panel_sources: tool({
      description:
        "Read the committed videoStyle and version-native storyboard-panel source. V3 returns shotDescription; historical V1/V2 return picture. Draft or invalid facts are never treated as ready sources.",
      inputSchema: jsonSchema<z.infer<typeof readStoryboardPanelSourcesInputSchema>>(
        readStoryboardPanelSourcesInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = readStoryboardPanelSourcesInputSchema.parse(raw);
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        return readStoryboardPanelSources({
          projectId,
          scriptId,
          snapshotId: input.snapshotId,
          storyboardIds: input.storyboardIds,
        });
      },
    }),
    list_production_reviews: tool({
      description:
        "List archived production review reports for the current project/script. Returns textAssetId and reviewRunId; read the report text separately.",
      inputSchema: jsonSchema<z.infer<typeof listProductionReviewsInputSchema>>(
        listProductionReviewsInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = listProductionReviewsInputSchema.parse(raw);
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        const events = await u
          .db("o_agentRunEvent as event")
          .join("o_agentRun as run", "run.runId", "event.runId")
          .where({
            "event.eventType": "agent_output_archived",
            "run.agentKey": "productionAgent",
            "run.projectId": projectId,
            "run.scriptId": scriptId,
          })
          .orderBy("event.id", "desc")
          .select(
            "event.*",
            "run.status as runStatus",
            "run.currentStage as runCurrentStage",
            "run.currentSubAgent as runCurrentSubAgent",
            "run.startedAt as runStartedAt",
            "run.finishedAt as runFinishedAt",
          );
        const reviews: any[] = [];
        for (const event of events) {
          const payload = parseJsonSafe(event.payloadJson) as any;
          if (!payload || !reviewTargetMatches(payload.stage, input.target)) continue;
          const asset = payload.textAssetId
            ? await u.db("o_textAsset").where({ id: Number(payload.textAssetId), projectId }).first()
            : null;
          reviews.push({
            reviewRunId: String(event.runId),
            stage: payload.stage ?? event.runCurrentStage ?? null,
            subAgent: payload.subAgent ?? event.runCurrentSubAgent ?? null,
            textAssetId: payload.textAssetId == null ? null : Number(payload.textAssetId),
            summary: asset?.summary ?? payload.summary ?? "",
            size: asset?.size == null ? payload.size ?? null : Number(asset.size),
            createdAt: Number(event.createdAt),
            runStatus: event.runStatus,
          });
          if (reviews.length >= input.limit) break;
        }
        return { projectId, scriptId, reviews };
      },
    }),
    read_production_review: tool({
      description: "Read an archived production review report by reviewRunId or textAssetId.",
      inputSchema: jsonSchema<z.infer<typeof readProductionReviewInputSchema>>(
        readProductionReviewInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = readProductionReviewInputSchema.parse(raw);
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        let textAssetId = input.textAssetId;
        const reviewRunId = input.reviewRunId ?? null;
        if (!textAssetId && reviewRunId) {
          const run = await u
            .db("o_agentRun")
            .where({ runId: reviewRunId, agentKey: "productionAgent", projectId, scriptId })
            .first("runId");
          if (!run) throw new Error("Review run not found in current project/script");
          const event = await u
            .db("o_agentRunEvent")
            .where({ runId: reviewRunId, eventType: "agent_output_archived" })
            .orderBy("id", "desc")
            .first();
          const payload = parseJsonSafe(event?.payloadJson) as any;
          textAssetId = payload?.textAssetId == null ? undefined : Number(payload.textAssetId);
        }
        if (!textAssetId) throw new Error("Review report text asset not found");
        const asset = await u.db("o_textAsset").where({ id: textAssetId, projectId }).first();
        if (!asset) throw new Error("Review text asset not found in current project");
        if (asset.scriptId != null && Number(asset.scriptId) !== scriptId) {
          throw new Error("Review text asset does not belong to the current script");
        }
        const page = await getTextAssetContent({
          id: textAssetId,
          projectId,
          offset: input.offset,
          limit: input.limit,
        });
        return {
          reviewRunId,
          textAsset: {
            id: Number(asset.id),
            summary: String(asset.summary || ""),
            size: Number(asset.size || page.size),
            targetType: asset.targetType,
            targetId: asset.targetId,
            version: Number(asset.version || 0),
          },
          ...page,
        };
      },
    }),
    read_text_asset: tool({
      description: "Read a text asset page by id in the current project scope.",
      inputSchema: jsonSchema<z.infer<typeof readTextAssetInputSchema>>(readTextAssetInputSchema.toJSONSchema()),
      execute: async (raw) => {
        const input = readTextAssetInputSchema.parse(raw);
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        return getTextAssetContent({ id: input.id, projectId, offset: input.offset, limit: input.limit });
      },
    }),
    list_director_plan_generations: tool({
      description:
        "List director-plan committed/history versions for the current project/script. Use before version-specific director-plan revision.",
      inputSchema: jsonSchema<z.infer<typeof listDirectorPlanGenerationsInputSchema>>(
        listDirectorPlanGenerationsInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = listDirectorPlanGenerationsInputSchema.parse(raw);
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        const rows = await u
          .db("o_directorPlanGeneration")
          .where({ projectId, scriptId })
          .orderBy("updatedAt", "desc")
          .limit(input.limit);
        return {
          projectId,
          scriptId,
          generations: rows.map((row: any) => ({
            generationId: String(row.generationId),
            state: String(row.state || ""),
            textAssetId: row.textAssetId == null ? null : Number(row.textAssetId),
            version: row.version == null ? null : Number(row.version),
            updatedAt: row.updatedAt == null ? null : Number(row.updatedAt),
            hasError: Boolean(row.errorJson),
          })),
        };
      },
    }),
    read_director_plan_generation: tool({
      description: "Read one committed director-plan version and its exact generationId/videoStyle by textAssetId or version.",
      inputSchema: jsonSchema<z.infer<typeof readDirectorPlanGenerationInputSchema>>(
        readDirectorPlanGenerationInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = readDirectorPlanGenerationInputSchema.parse(raw);
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        let textAssetId = input.textAssetId;
        if (!textAssetId && input.version) {
          const asset = await u
            .db("o_textAsset")
            .where({ projectId, scriptId, targetType: "scriptPlan", version: input.version, state: "complete" })
            .orderBy("id", "desc")
            .first("id");
          textAssetId = asset?.id == null ? undefined : Number(asset.id);
        }
        if (!textAssetId) throw new Error("Director plan generation not found");
        const result = await readDirectorPlanAsset({ projectId, scriptId, textAssetId });
        return {
          textAssetId: result.id,
          version: result.version,
          generationId: result.generationId,
          videoStyle: result.videoStyle,
          content: result.content,
        };
      },
    }),
    prepare_storyboard_table: tool({
      description:
        "Prepare the complete narrative-shot and video-group schedule in memory before creating a storyboard generation. This does not write storyboard facts.",
      inputSchema: jsonSchema<z.infer<typeof prepareStoryboardTableInputSchema>>(
        prepareStoryboardTableInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const thinking = storyboardProgress || msg.thinking("正在整理剧情与镜头节奏...");
        const ownsThinking = !storyboardProgress;
        try {
          if (storyboardTableTerminalFailure) {
            throw new Error("This storyboard-table run is write-locked after a terminal failure.");
          }
          if (runContext) await recordAgentRunEvent(runContext.runId, "storyboard_prepare_started", {});
          const parsed = prepareStoryboardTableInputSchema.safeParse(raw);
          if (!parsed.success) {
            const issues = parsed.error.issues.map((issue) => ({
              field: issue.path.join(".") || "prepare",
              message: issue.message,
            }));
            if (runContext) await recordAgentRunEvent(runContext.runId, "storyboard_prepare_failed", { issues });
            return { status: "invalid", phase: "prepare", issues };
          }
          const input = parsed.data;
          const issues = validateStoryboardGroupPreflightStructure(input);
          if (issues.length) {
            const structuredIssues = issues.map((message) => ({ field: "prepare", message }));
            if (runContext) {
              await recordAgentRunEvent(runContext.runId, "storyboard_prepare_failed", { issues: structuredIssues });
            }
            return { status: "invalid", phase: "prepare", issues: structuredIssues };
          }
          storyboardPreflight = input;
          storyboardGenerationId = null;
          storyboardRowsWritten = 0;
          if (runContext) {
            await recordAgentRunEvent(runContext.runId, "storyboard_prepare_completed", {
              status: input.status,
              shotCount: input.shots.length,
              groupCount: input.groups.length,
            });
          }
          thinking.appendText(`shots=${input.shots.length}, groups=${input.groups.length}, status=${input.status}`);
          thinking.updateTitle?.("剧情与镜头节奏整理完成");
          if (input.status === "needs_user") {
            runContext?.setPendingDecision({
              stage: "storyboardTable",
              subAgent: "storyboardTableAgent",
              reason: input.summary,
              resultJson: {
                source: "storyboardTablePreparation",
                summary: input.summary,
              },
            });
            return {
              status: input.status,
              prepared: false,
              requiresUserDecision: true,
              summary: input.summary,
            };
          }
          return {
            status: input.status,
            prepared: true,
            expectedRowCount: input.shots.length,
            groups: canonicalGroups(input.groups),
            summary: input.summary,
          };
        } catch (error: any) {
          thinking.appendText(u.error(error).message);
          thinking.updateTitle?.("剧情与镜头节奏整理失败");
          if (runContext) {
            await recordAgentRunEvent(runContext.runId, "storyboard_prepare_failed", {
              reason: u.error(error).message,
            });
          }
          throw error;
        } finally {
          if (ownsThinking) thinking.complete();
        }
      },
    }),
    declare_storyboard_table_decision: tool({
      description:
        "Record the decision Agent's understanding of the user's current natural-language request for an unresolved storyboard-table review. This never starts generation or changes storyboard facts.",
      inputSchema: jsonSchema<z.infer<typeof storyboardTableDecisionInputSchema>>(
        storyboardTableDecisionInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = storyboardTableDecisionInputSchema.parse(raw);
        if (
          !continuation ||
          continuation.kind !== "awaiting_user" ||
          continuation.run.currentStage !== "supervisionStoryboardTable"
        ) {
          throw new Error("No unresolved storyboard-table review is available for a decision declaration.");
        }
        if (runContext) {
          await recordAgentRunEvent(runContext.runId, "storyboard_table_decision_received", {
            pendingRunId: continuation.run.runId,
            intent: input.intent,
            rationale: input.rationale,
          });
        }
        return {
          accepted: true,
          pendingRunId: continuation.run.runId,
          intent: input.intent,
          reviewContext: continuation.decision,
        };
      },
    }),
    await_user_decision: tool({
      description:
        "Stop the current Agent Run and ask the user one explicit decision. Use this only when a concrete question is ready.",
      inputSchema: jsonSchema<z.infer<typeof awaitUserDecisionInputSchema>>(awaitUserDecisionInputSchema.toJSONSchema()),
      execute: async (raw) => {
        const input = awaitUserDecisionInputSchema.parse(raw);
        if (!runContext) throw new Error("Agent Run context is required to await a user decision");
        const pendingDecision = runContext.pendingDecision;
        const pending = pendingDecision?.resultJson;
        const stage = pendingDecision?.stage || input.stage;
        const subAgent =
          pendingDecision?.subAgent || (stage === "storyboardTable" ? "storyboardTableAgent" : undefined);
        const generationId =
          pending && typeof pending === "object" && "generationId" in pending
            ? String((pending as { generationId?: unknown }).generationId || "") || undefined
            : undefined;
        runContext.setAwaitingUser({
          stage,
          subAgent,
          reason: input.question,
          resultJson: {
            kind: "user_decision",
            stage,
            generationId,
            question: input.question,
            options: input.options,
            context: input.context,
            source: pending ?? null,
          },
        });
        return { status: "awaiting_user", terminal: true, question: input.question, options: input.options };
      },
    }),
    record_storyboard_table_review: tool({
      description:
        "Persist the complete current storyboard-table audit report. For scope=storyboard pass the formal storyboardIndex; the server resolves storyboardId. Do not guess a storyboardId from a generation row. This is advisory only and never changes storyboard facts.",
      inputSchema: jsonSchema<z.infer<typeof recordStoryboardTableReviewInputSchema>>(
        recordStoryboardTableReviewInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = recordStoryboardTableReviewInputSchema.parse(raw);
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        const items = await resolveStoryboardTableAgentReviewItemTargets({ projectId, scriptId, items: input.items });
        const result = await replaceStoryboardTableAgentReviewSuggestions({ projectId, scriptId, items });
        if (runContext) {
          await recordAgentRunEvent(runContext.runId, "storyboard_table_review_recorded", {
            projectId,
            scriptId,
            reviewedAt: result.reviewedAt,
          });
        }
        return { recorded: true, reviewedAt: result.reviewedAt };
      },
    }),
    list_project_materials: tool({
      description: "List project-level reference material files by category. Returns metadata only, not full text.",
      inputSchema: jsonSchema<{ category?: string }>(
        z
          .object({
            category: projectMaterialCategorySchema.optional().describe("Optional material category filter"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ category }) => {
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        return listProjectMaterials({ projectId, category: category as any });
      },
    }),
    read_project_material: tool({
      description: "Read text from a project-level reference material using pagination.",
      inputSchema: jsonSchema<{ id: number; offset?: number; limit?: number }>(
        z
          .object({
            id: z.number().describe("Project material id"),
            offset: z.number().optional().describe("Character offset"),
            limit: z.number().optional().describe("Maximum characters to read"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ id, offset, limit }) => {
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        return readProjectMaterial({ id, projectId, offset, limit });
      },
    }),
    get_project_context_pack: tool({
      description: "Get the latest short project context pack for production reference. Returns null when not generated.",
      inputSchema: jsonSchema<Record<string, never>>(z.object({}).toJSONSchema()),
      execute: async () => {
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        return getProjectContextPack(projectId);
      },
    }),
    begin_director_plan: tool({
      description: "Start a director-plan generation for the current project and script.",
      inputSchema: jsonSchema<z.infer<typeof beginDirectorPlanInputSchema>>(beginDirectorPlanInputSchema.toJSONSchema()),
      execute: async (raw) => {
        const input = beginDirectorPlanInputSchema.parse(raw);
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        assertOptionalScopeMatches(input, projectId, scriptId);
        return beginDirectorPlanGeneration({ projectId, scriptId });
      },
    }),
    append_director_plan_section: tool({
      description: "Append one ordered chunk to a required director-plan section. Identical retries are idempotent.",
      inputSchema: jsonSchema<z.infer<typeof appendDirectorPlanSectionInputSchema>>(
        appendDirectorPlanSectionInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = appendDirectorPlanSectionInputSchema.parse(raw);
        await assertDirectorPlanGenerationScope({
          generationId: input.generationId,
          projectId: scopedNumber(resTool.data.projectId, "projectId"),
          scriptId: scopedNumber(resTool.data.scriptId, "scriptId"),
        });
        return appendDirectorPlanSection(input);
      },
    }),
    commit_director_plan: tool({
      description: "Validate all nine director-plan sections and atomically persist the formal scriptPlan plus its short authoritative videoStyle.",
      inputSchema: jsonSchema<z.infer<typeof commitDirectorPlanInputSchema>>(commitDirectorPlanInputSchema.toJSONSchema()),
      execute: async (raw) => {
        const input = commitDirectorPlanInputSchema.parse(raw);
        await assertDirectorPlanGenerationScope({
          generationId: input.generationId,
          projectId: scopedNumber(resTool.data.projectId, "projectId"),
          scriptId: scopedNumber(resTool.data.scriptId, "scriptId"),
        });
        return commitDirectorPlanGeneration(input.generationId, input.videoStyle);
      },
    }),
    get_director_plan_asset: tool({
      description: "Read one exact committed director-plan version plus its generationId/videoStyle by textAssetId for supervision.",
      inputSchema: jsonSchema<z.infer<typeof getDirectorPlanAssetInputSchema>>(
        getDirectorPlanAssetInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = getDirectorPlanAssetInputSchema.parse(raw);
        return readDirectorPlanAsset({
          projectId: scopedNumber(resTool.data.projectId, "projectId"),
          scriptId: scopedNumber(resTool.data.scriptId, "scriptId"),
          textAssetId: input.textAssetId,
        });
      },
    }),
    begin_storyboard_table: tool({
      description: "Start an atomic storyboard-table generation from the ready prepare result held by this run.",
      inputSchema: jsonSchema<z.infer<typeof beginStoryboardTableInputSchema>>(beginStoryboardTableInputSchema.toJSONSchema()),
      execute: async (raw) => {
        const input = beginStoryboardTableInputSchema.parse(raw);
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        assertOptionalScopeMatches(input, projectId, scriptId);
        if (storyboardTableTerminalFailure) {
          throw new Error("本轮已有终止型失败，不能重新 begin_storyboard_table；请向用户报告失败原因后停止。");
        }
        if (!storyboardPreflight || storyboardPreflight.status !== "ready") {
          throw new Error("Call prepare_storyboard_table with a ready plan before begin_storyboard_table.");
        }
        const preparedGroups = canonicalGroups(storyboardPreflight.groups);
        const thinking = storyboardProgress || msg.thinking("正在创建分镜表写入批次...");
        const ownsThinking = !storyboardProgress;
        try {
          const result = await beginStoryboardGeneration({
            projectId,
            scriptId,
            expectedRowCount: storyboardPreflight.shots.length,
            groups: preparedGroups,
          });
          storyboardGenerationId = result.generationId;
          storyboardRowsWritten = 0;
          if (runContext) {
            await recordAgentRunEvent(runContext.runId, "storyboard_generation_started", {
              generationId: result.generationId,
              expectedRowCount: storyboardPreflight.shots.length,
              groupCount: preparedGroups.length,
            });
          }
          thinking.appendText(`generationId=${result.generationId}, expectedRows=${storyboardPreflight.shots.length}`);
          return { ...result, phase: "begin" as const };
        } catch (error: any) {
          thinking.appendText(error?.message || String(error));
          thinking.updateTitle?.("storyboard table begin failed");
          throw error;
        } finally {
          if (ownsThinking) thinking.complete();
        }
      },
    }),
    get_storyboard_generation_draft: tool({
      description:
        "Read one failed storyboard generation draft in pages. This is the authoritative source when revising an awaiting_user validation result.",
      inputSchema: jsonSchema<z.infer<typeof getStoryboardGenerationDraftInputSchema>>(
        getStoryboardGenerationDraftInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = getStoryboardGenerationDraftInputSchema.parse(raw);
        return readStoryboardGenerationDraft({
          generationId: input.generationId,
          projectId: scopedNumber(resTool.data.projectId, "projectId"),
          scriptId: scopedNumber(resTool.data.scriptId, "scriptId"),
          offset: input.offset,
          limit: input.limit,
        });
      },
    }),
    append_storyboard_rows: tool({
      description: "Append 1-10 authoritative structured storyboard rows. Retry identical rows safely after interruption.",
      inputSchema: jsonSchema<z.infer<typeof appendStoryboardRowsInputSchema>>(appendStoryboardRowsInputSchema.toJSONSchema()),
      execute: async (raw) => {
        if (storyboardTableTerminalFailure) {
          throw new Error("This run is write-locked after storyboard validation failed; await a user decision instead.");
        }
        const input = appendStoryboardRowsInputSchema.parse(raw);
        if (!storyboardGenerationId || input.generationId !== storyboardGenerationId) {
          throw new Error("append_storyboard_rows must target the generation created from the current preparation.");
        }
        const thinking = storyboardProgress || msg.thinking(`正在写入分镜 ${input.startIndex + 1}-${input.startIndex + input.rows.length}...`);
        const ownsThinking = !storyboardProgress;
        try {
          const result = await appendStoryboardRows(input);
          storyboardRowsWritten = Math.max(storyboardRowsWritten, Number(result.nextIndex || 0));
          if (runContext) {
            await recordAgentRunEvent(runContext.runId, "storyboard_batch_appended", {
              generationId: input.generationId,
              startIndex: input.startIndex,
              accepted: result.accepted,
              nextIndex: result.nextIndex,
            });
          }
          thinking.appendText(`accepted=${result.accepted}, nextIndex=${result.nextIndex}, issues=${result.issues.length}`);
          return { ...result, phase: "append" as const, generationId: input.generationId };
        } catch (error: any) {
          thinking.appendText(error?.message || String(error));
          thinking.updateTitle?.("storyboard rows append failed");
          throw error;
        } finally {
          if (ownsThinking) thinking.complete();
        }
      },
    }),
    commit_storyboard_table: tool({
      description: "Validate all submitted rows and atomically replace the formal storyboard table.",
      inputSchema: jsonSchema<z.infer<typeof commitStoryboardTableInputSchema>>(commitStoryboardTableInputSchema.toJSONSchema()),
      execute: async (raw) => {
        if (storyboardTableTerminalFailure) {
          throw new Error("This run is write-locked after storyboard validation failed; await a user decision instead.");
        }
        const input = commitStoryboardTableInputSchema.parse(raw);
        if (!storyboardGenerationId || input.generationId !== storyboardGenerationId) {
          throw new Error("commit_storyboard_table must target the generation created from the current preparation.");
        }
        if (!storyboardPreflight || storyboardRowsWritten !== storyboardPreflight.shots.length) {
          throw new Error(
            `Cannot commit: prepared ${storyboardPreflight?.shots.length || 0} rows but accepted ${storyboardRowsWritten}.`,
          );
        }
        const thinking = storyboardProgress || msg.thinking("正在校验并提交完整分镜表...");
        const ownsThinking = !storyboardProgress;
        try {
          const result = await commitStoryboardGeneration(input.generationId);
          if (result.status === "committed") {
            thinking.appendText(`rows=${result.rowCount}, groups=${result.groupCount}, revision=${result.revision}`);
            thinking.updateTitle?.("storyboard table committed");
            if (runContext) {
              await recordAgentRunEvent(runContext.runId, "storyboard_committed", {
                generationId: input.generationId,
                rowCount: result.rowCount,
                groupCount: result.groupCount,
                revision: result.revision,
              });
            }
          } else if (result.status === "invalid") {
            thinking.appendText(JSON.stringify(result.issues));
            thinking.updateTitle?.("storyboard table validation failed");
          } else {
            const message =
              result.error.code === "COMMIT_IN_PROGRESS"
                ? "提交仍被后端任务占用，请稍后重试或重新开始分镜表生成。"
                : JSON.stringify(result.error);
            thinking.appendText(message);
            thinking.updateTitle?.("storyboard table commit failed");
          }
          if (result.status === "invalid") {
            storyboardTableTerminalFailure = true;
            const decision = storyboardValidationDecisionSummary(input.generationId, result);
            runContext?.setPendingDecision({
              stage: "storyboardTable",
              subAgent: "storyboardTableAgent",
              reason: decision.question,
              resultJson: decision.resultJson,
            });
            return {
              ...result,
              phase: "commit" as const,
              generationId: input.generationId,
              writeLocked: true,
              requiresUserDecision: true,
              humanSummary: decision.summary,
              instruction:
                "Do not call begin_storyboard_table, append_storyboard_rows, or commit_storyboard_table again in this run. Explain all issues and call await_user_decision with one concrete question.",
            };
          }
          if (result.status === "failed") {
            storyboardTableTerminalFailure = true;
            const message = shortStoryboardCommitMessage(result);
            runContext?.setFailed({
              stage: "storyboardTable",
              subAgent: "storyboardTableAgent",
              reason: message || "Storyboard table commit failed.",
              errorJson: result.error,
            });
            return {
              ...result,
              status: result.status,
              terminal: true,
              error: normalizeToolError(result.error),
              message,
              instruction: "Stop this execution turn. Do not retry commit and do not begin a new storyboard generation.",
            };
          }
          return { ...result, phase: "commit" as const, generationId: input.generationId };
        } catch (error: any) {
          thinking.appendText(error?.message || String(error));
          thinking.updateTitle?.("storyboard table commit failed");
          throw error;
        } finally {
          if (ownsThinking) thinking.complete();
        }
      },
    }),
    update_storyboard_panel: tool({
      description:
        "Update visual-generation fields for existing storyboard rows. It never creates storyboard rows or rewrites storyboard-table narrative facts. Returns complete or partial with exact updated and failed targets; interpret and retry partial results yourself.",
      inputSchema: jsonSchema<z.infer<typeof updateStoryboardPanelInputSchema>>(
        updateStoryboardPanelInputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = updateStoryboardPanelInputSchema.parse(raw);
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        assertOptionalScopeMatches(input, projectId, scriptId);
        const updatedIds: number[] = [];
        const issues: Array<{ item: number; message: string }> = [];
        for (const [itemIndex, item] of input.items.entries()) {
          try {
            const storyboardId = await u.db.transaction(async (trx) => {
              const query = trx("o_storyboard").where({ projectId, scriptId });
              if (item.storyboardId != null) query.andWhere("id", item.storyboardId);
              else if (item.index != null) query.andWhere("index", item.index);
              else throw new Error("storyboardId or index is required");
              const storyboard = await query.first("id", "factStatus", "tableRowJson");
              if (!storyboard) throw new Error("storyboard not found");
              if (storyboard.factStatus !== "ready" || !parseStoryboardTableRow(storyboard.tableRowJson)) {
                throw new Error("storyboard facts are not ready");
              }
              const resolvedStoryboardId = Number(storyboard.id);
              await applyStoryboardPanelImageFieldsWithDb(trx, {
                projectId,
                scriptId,
                storyboardId: resolvedStoryboardId,
                prompt: item.prompt,
                shouldGenerateImage: item.shouldGenerateImage,
                associateAssetsIds: item.associateAssetsIds || [],
                mode: input.mode,
              });
              return resolvedStoryboardId;
            });
            updatedIds.push(storyboardId);
          } catch (error) {
            issues.push({ item: itemIndex, message: u.error(error).message });
          }
        }
        const requestedTargets = input.items.map((item) => ({
          storyboardId: item.storyboardId ?? null,
          index: item.index ?? null,
        }));
        return {
          status: issues.length === 0 ? ("complete" as const) : ("partial" as const),
          ok: issues.length === 0,
          requestedTargets,
          updatedIds,
          failedTargets: issues.map((issue) => ({
            ...requestedTargets[issue.item],
            item: issue.item,
            message: issue.message,
          })),
          issues,
        };
      },
    }),
    add_deriveAsset: tool({
      description: "新增或更新衍生资产",
      inputSchema: jsonSchema<z.infer<typeof addDeriveAssetInputSchema>>(addDeriveAssetInputSchema.toJSONSchema()),
      execute: async (raw) => {
        const parsed = addDeriveAssetInputSchema.parse(raw);
        // 容错：LLM 偶尔传 "null" 字符串或空串，统一规范为 null
        const idRaw = parsed.id as unknown;
        const normalizedId = idRaw === "null" || idRaw === "" || idRaw === undefined || idRaw === null ? null : Number(idRaw);
        if (normalizedId !== null && !Number.isFinite(normalizedId)) throw new Error("invalid derive asset id");
        const deriveAsset = { ...parsed, id: normalizedId };

        const thinking = msg.thinking("正在操作资产...");
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        const startTime = Date.now();
        const script = await u.db("o_script").where({ id: scriptId, projectId }).first("id");
        if (!script) throw new Error("当前剧集不属于该项目");
        const parentAssets = await u.db("o_assets").where({ id: deriveAsset.assetsId, projectId }).select("id", "type").first();
        if (!parentAssets) return "关联的资产不存在";
        if (!isVisualAssetType(parentAssets.type)) {
          throw new Error(`Only role, scene, and tool assets can have derive assets; got ${parentAssets.type || "unknown"}`);
        }
        if (deriveAsset.type && deriveAsset.type !== parentAssets.type) {
          throw new Error(`derive asset type ${deriveAsset.type} does not match parent asset type ${parentAssets.type}`);
        }

        const baseData = {
          assetsId: deriveAsset.assetsId,
          projectId,
          name: deriveAsset.name,
          type: parentAssets.type,
          describe: deriveAsset.desc,
        };
        const notifyData: any = {
          ...baseData,
          prompt: deriveAsset.prompt,
          promptMode: deriveAsset.promptMode,
          id: deriveAsset.id ?? undefined,
        };
        if (deriveAsset.id) {
          const existing = await u.db("o_assets")
            .where({ id: deriveAsset.id, projectId, assetsId: deriveAsset.assetsId })
            .first("id");
          if (!existing) throw new Error("目标衍生资产不属于当前项目或父资产");
          await u.db.transaction(async (trx: any) => {
            await trx("o_assets").where({ id: deriveAsset.id, projectId }).update(baseData);
            const promptTarget = await updateDeriveAssetPrompt(trx, {
              projectId,
              targetId: deriveAsset.id!,
              prompt: deriveAsset.prompt,
              mode: deriveAsset.promptMode,
            });
            notifyData.flowId = promptTarget.flowId;
            notifyData.nodeId = promptTarget.nodeId;
          });
          thinking.appendText(`已更新衍生资产，ID: ${deriveAsset.id}\n`);
        } else {
          const data = { ...baseData, prompt: deriveAsset.prompt, scriptId, startTime };
          const [insertedId] = await u.db("o_assets").insert(data);
          notifyData.id = insertedId;
          thinking.appendText(`已新增衍生资产，ID: ${insertedId}\n`);
        }
        await emitBestEffort(socket, "addDeriveAsset", notifyData);
        const res = { ok: true, assetId: notifyData.id, parentAssetId: deriveAsset.assetsId };
        thinking.updateTitle("资产操作完成");
        thinking.complete();
        return res ?? "操作成功";
      },
    }),
    del_deriveAsset: tool({
      description: "删除衍生资产",
      inputSchema: jsonSchema<{ assetsId: number; id: number }>(
        z
          .object({
            assetsId: z.number().describe("关联的资产ID"),
            id: z.number().describe("衍生资产ID"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ assetsId, id }) => {
        const thinking = msg.thinking("正在操作资产...");
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const asset = await u.db("o_assets").where({ id, assetsId, projectId }).first("id");
        if (!asset) throw new Error("Derived asset does not belong to the current project and parent asset");
        await cleanupAssetRelations(u.db, [id]);
        await u.db("o_assets").where({ id, projectId }).del();
        thinking.appendText(`已删除衍生资产，ID: ${id}\n`);
        await emitBestEffort(socket, "delDeriveAsset", { assetsId, id });
        const res = { ok: true, assetId: id, parentAssetId: assetsId };
        thinking.updateTitle("资产操作完成");
        thinking.complete();
        return res ?? "删除成功";
      },
    }),
    generate_deriveAsset: tool({
      description: "提交衍生资产图片生成任务，并以 complete 或 partial 返回实际提交 ID 与失败 ID；partial 不是全部完成。",
      inputSchema: jsonSchema<{ ids: number[] }>(
        z
          .object({
            ids: z.array(z.number()).describe("需要生成的 衍生资产ID"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在生成衍生资产...");
        try {
          const ack = await submitImageGeneration<GenerateDeriveAssetAck>(socket, "generateDeriveAsset", { ids }, undefined, {
            agentName: "productionAgent",
            toolName: "generate_deriveAsset",
            projectId: resTool.data.projectId,
            scriptId: resTool.data.scriptId,
          });
          if (ack?.success === false && (!ack.message || typeof ack.message !== "object")) {
            throw new Error(stringifyAckMessage(ack.message) || "衍生资产生成任务提交失败");
          }
          const result = normalizeGenerateDeriveAssetResult(ack?.message);
          const structuredResult = structuredGenerateDeriveAssetToolResult(ids, result);
          thinking.appendText(structuredResult.summary + "\n");
          thinking.updateTitle(structuredResult.status === "partial" ? "衍生资产生成部分启动" : "衍生资产生成已启动");
          thinking.complete();
          return structuredResult;
        } catch (e) {
          const message = u.error(e).message;
          thinking.appendText("衍生资产生成失败:\n" + message);
          thinking.updateTitle("衍生资产生成失败");
          thinking.complete();
          throw e;
        }
      },
    }),
    generate_storyboard: tool({
      description: "提交分镜图片生成任务，并以 complete 或 partial 返回实际提交 ID 与失败 ID；partial 不是全部完成。",
      inputSchema: jsonSchema<{ ids: number[] }>(
        z
          .object({
            ids: z.array(z.number()).describe("必须获取真实的分镜ID，支持批量生成"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在生成分镜...");
        try {
          const ack = await submitImageGeneration<GenerateStoryboardAck>(socket, "generateStoryboard", { ids }, undefined, {
            agentName: "productionAgent",
            toolName: "generate_storyboard",
            projectId: resTool.data.projectId,
            scriptId: resTool.data.scriptId,
          });
          const payload =
            ack && typeof ack === "object" && !Array.isArray(ack) && Object.prototype.hasOwnProperty.call(ack, "message")
              ? ack.message
              : ack;
          if (ack?.success === false && (!payload || typeof payload !== "object")) {
            throw new Error(stringifyAckMessage(payload) || "分镜图生成任务提交失败");
          }
          const result = normalizeGenerateStoryboardResult(payload);
          const structuredResult = structuredGenerateStoryboardToolResult(ids, result);
          thinking.appendText(structuredResult.summary + "\n");
          thinking.updateTitle(structuredResult.status === "partial" ? "分镜图生成部分启动" : "分镜图生成已启动");
          thinking.complete();
          return structuredResult;
        } catch (e) {
          const message = u.error(e).message;
          thinking.appendText("分镜生成失败:\n" + message);
          thinking.updateTitle("分镜生成失败");
          thinking.complete();
          throw e;
        }
      },
    }),
  };

  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([n]) => toolsNames.includes(n))) : tools;
};
