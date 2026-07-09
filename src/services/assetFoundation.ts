import u from "@/utils";
import { readConfiguredSkill } from "@/services/skillResolver";
import { getProjectContextPack } from "@/services/projectMaterial";

export type AssetFoundationType = "role" | "scene" | "tool";
export type AssetFoundationMode = "selected" | "missingOnly" | "all";

export interface AssetFoundationGeneratePayload {
  projectId: number;
  assetId: number;
  instruction?: string;
  overwrite?: boolean;
  generatePrompt?: boolean;
}

export interface AssetFoundationTargetInput {
  projectId: number;
  assetIds?: number[];
  type?: AssetFoundationType;
  mode?: AssetFoundationMode;
  generatePrompt?: boolean;
  overwrite?: boolean;
}

const TYPE_CONFIG: Record<AssetFoundationType, { label: string; visualManual: string; derivativeManual: string }> = {
  role: { label: "角色", visualManual: "art_character", derivativeManual: "art_character_derivative" },
  scene: { label: "场景", visualManual: "art_scene", derivativeManual: "art_scene_derivative" },
  tool: { label: "道具", visualManual: "art_prop", derivativeManual: "art_prop_derivative" },
};

type AssetFoundationIssue = { severity: "info" | "warning" | "blocking"; message: string; reason?: string };
type AssetFoundationReviewResult = { status: "passed" | "blocked"; issues: AssetFoundationIssue[] };

interface AssetFoundationSourceContext {
  instruction: string;
  existingFoundation: string;
  initialDescription: string;
  contextPackContent: string;
  visualManual: string;
  assetLabel: string;
}

function getAiText(result: any) {
  return String(result?.text || result?._output || result?.content || "").trim();
}

async function readSkill(fileName: string, fallback: string) {
  return (await readConfiguredSkill(fileName, fallback)).content;
}

function extractTagContent(text: string, tag: string) {
  const match = String(text || "").match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.trim() || "";
}

function extractAssetResult(text: string, assetId: number) {
  const match = String(text || "").match(/<assetResult\b([^>]*)>([\s\S]*?)<\/assetResult>/i);
  if (!match) throw new Error("Asset foundation generation did not return <assetResult> XML");
  const attrAssetId = match[1]?.match(/\bassetId=["']?(\d+)["']?/i)?.[1];
  if (!attrAssetId) throw new Error("Asset foundation XML missing assetId");
  if (Number(attrAssetId) !== Number(assetId)) throw new Error(`Asset foundation XML assetId mismatch: ${attrAssetId}`);
  const body = match[2] || "";
  return {
    foundation: extractTagContent(body, "assetFoundation"),
    rationale: extractTagContent(body, "visualDesignRationale"),
    prompt: extractTagContent(body, "assetImagePrompt"),
  };
}

function normalizeIssue(issue: any) {
  const severity = ["info", "warning", "blocking"].includes(issue?.severity) ? issue.severity : "warning";
  return {
    severity,
    message: String(issue?.message || issue?.reason || "资产基础设定审核提示").slice(0, 500),
    reason: String(issue?.reason || "").slice(0, 1000),
  };
}

function validateGeneratedAssetContent(input: {
  foundation: string;
  rationale: string;
  prompt: string;
  generatePrompt: boolean;
}) {
  const issues: AssetFoundationIssue[] = [];
  const foundation = input.foundation.trim();
  const rationale = input.rationale.trim();
  const prompt = input.prompt.trim();
  if (foundation.length < 30) {
    issues.push({ severity: "blocking", message: "assetFoundation 内容过短", reason: "没有形成可用的资产事实和连续性锚点。" });
  }
  if (rationale.length < 30) {
    issues.push({ severity: "blocking", message: "visualDesignRationale 内容过短", reason: "没有形成可用的视觉设计推导。" });
  }
  if (input.generatePrompt && prompt.length < 20) {
    issues.push({ severity: "blocking", message: "assetImagePrompt 内容过短", reason: "没有形成可用的图片生成 prompt。" });
  }
  if (/<\/?[a-zA-Z][\w-]*\b/.test(foundation) || /<\/?[a-zA-Z][\w-]*\b/.test(rationale) || /<\/?[a-zA-Z][\w-]*\b/.test(prompt)) {
    issues.push({ severity: "blocking", message: "资产内容中残留 XML 标签" });
  }
  return issues;
}

async function reviewAssetFoundation(input: {
  asset: any;
  project: any;
  foundation: string;
  rationale: string;
  prompt: string;
  sourceContext: AssetFoundationSourceContext;
  generatePrompt: boolean;
}): Promise<AssetFoundationReviewResult> {
  const localIssues = validateGeneratedAssetContent({
    foundation: input.foundation,
    rationale: input.rationale,
    prompt: input.prompt,
    generatePrompt: input.generatePrompt,
  });
  const reviewSkill = await readSkill(
    "asset_foundation_review.md",
    "你是资产基础设定审核器。输出 JSON：{\"status\":\"passed|blocked\",\"issues\":[{\"severity\":\"info|warning|blocking\",\"message\":\"...\",\"reason\":\"...\"}]}。",
  );
  let aiIssues: AssetFoundationIssue[] = [];
  try {
    const result = await u.Ai.Text("universalAi").invoke({
      system: reviewSkill,
      messages: [
        {
          role: "user",
          content: [
            `资产ID: ${input.asset.id}`,
            `资产名称: ${input.asset.name}`,
            `资产类型: ${input.sourceContext.assetLabel}`,
            `项目画风: ${input.project.artStyle || ""}`,
            `是否生成图片 Prompt: ${input.generatePrompt ? "是" : "否"}`,
            "",
            "【用户本轮指令】",
            input.sourceContext.instruction || "无",
            "",
            "【项目制作参考包（主要事实源）】",
            input.sourceContext.contextPackContent || "无",
            "",
            "【资产已有正式基础设定 foundationText】",
            input.sourceContext.existingFoundation || "无",
            "",
            "【资产初始描述 describe（线索，不是正式设定）】",
            input.sourceContext.initialDescription || "无",
            "",
            "【assetFoundation】",
            input.foundation,
            "",
            "【visualDesignRationale】",
            input.rationale,
            "",
            "【assetImagePrompt】",
            input.prompt,
            "",
            "【当前视觉手册】",
            input.sourceContext.visualManual.slice(0, 10000),
          ].join("\n"),
        },
      ],
    });
    const raw = getAiText(result);
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    const parsed = JSON.parse(fenced || raw);
    const issues = Array.isArray(parsed?.issues) ? parsed.issues : [];
    aiIssues = issues.map(normalizeIssue);
    if (parsed?.status === "blocked" && !aiIssues.some((item) => item.severity === "blocking")) {
      aiIssues.push({ severity: "blocking", message: "资产基础设定审核未通过" });
    }
  } catch (error) {
    aiIssues = [{
      severity: "blocking",
      message: "AI 审核不可用",
      reason: u.error(error).message,
    }];
  }
  const issues = [...localIssues, ...aiIssues];
  return {
    status: issues.some((item) => item.severity === "blocking") ? "blocked" : "passed",
    issues,
  };
}

function assetPromptChecklist(assetType: AssetFoundationType) {
  if (assetType === "role") {
    return [
      "角色 assetImagePrompt 必须是角色设定图，不是剧情场景图。",
      "必须表达同一画面包含头像特写、正面全身、侧面全身、背面全身。",
      "必须表达中性背景、均匀光线、完整头到脚、不裁切、无文字。",
      "面容、发型、体态、服装必须来自 assetFoundation 和 visualDesignRationale，不得新增身份、关系或剧情动作。",
      "必须体现 visualDesignRationale 的识别度策略和审美修正，避免灰黑塌缩、疲惫苦相和证件照感。",
    ].join("\n");
  }
  if (assetType === "scene") {
    return [
      "场景 assetImagePrompt 必须是可复用场景设定图。",
      "必须表达稳定空间布局、关键物件、默认状态和视觉手册要求。",
      "不得加入人物，不得写成某一集剧情镜头，不得新增 assetFoundation 没有的地点或规则。",
    ].join("\n");
  }
  return [
    "道具 assetImagePrompt 必须是清晰道具设定图。",
    "必须表达整体轮廓、材质、标识、磨损、关键结构和视觉手册要求。",
    "不得出现人物、手部、佩戴或使用场景，不得新增 assetFoundation 没有的功能。",
  ].join("\n");
}

function assetFoundationBoundaryRules(assetType: AssetFoundationType) {
  const common = [
    "基础资产边界：assetFoundation 只写默认、稳定、可复用事实，不写单集剧情状态、后续事件物件、临时摆放、屏幕内容或证据内容。",
    "衍生资产和分镜图负责承接具体剧情时刻，例如某顿饭的菜品摆放、手机屏幕显示转账记录、录音播放界面、临时证据展示。",
    "聊天记录、转账记录、录音、通话记录、通知文字等信息内容默认绑定到手机、电脑、录音笔、文件袋、纸质凭证等载体，不作为独立基础资产事实。",
  ];
  if (assetType === "scene") {
    return [
      ...common,
      "场景 assetFoundation 只允许写固定布局、常设家具、常设设备、长期陈设、默认清洁/磨损状态。",
      "禁止把某场戏临时出现的菜品、账单、手机、纸条、证据、录音、礼物、药品等写成场景默认物件。",
      "餐厅等场景可以写桌椅、收银台、后厨连接、常见调味架等常设物；不得写某顿饭的菜碟数量、剧情餐品、冲突证据。",
    ].join("\n");
  }
  if (assetType === "tool") {
    return [
      ...common,
      "道具 assetFoundation 只写载体本身的稳定外观、材质、结构、归属或固定标识。",
      "手机、电脑、录音笔等载体不得在基础设定中固化具体聊天对象、金额、录音内容、屏幕文字或后续证据状态。",
      "只有打印聊天记录、纸质转账凭证、独立文件、独立物证等已经成为实体物件时，信息记录才可以作为道具事实。",
    ].join("\n");
  }
  return common.join("\n");
}

async function buildPrompt(input: {
  asset: any;
  project: any;
  visualManual: string;
  instruction: string;
  overwrite: boolean;
  generatePrompt: boolean;
}) {
  const [flowSkill, techniqueSkill] = await Promise.all([
    readSkill("asset_foundation_flow.md", "你是塑角造景资产基础设定 Agent，只能生成资产基础设定和图片 prompt。"),
    readSkill("asset_foundation_technique.md", "基础设定只写资产事实；图片 prompt 才写视觉表现。"),
  ]);
  const contextPack = await getProjectContextPack(Number(input.project.id)).catch(() => null);
  const contextPackContent = String(contextPack?.content || "").trim();
  const existingFoundation = String(input.asset.foundationText || "").trim();
  const initialDescription = String(input.asset.describe || "").trim();
  const assetType = input.asset.type as AssetFoundationType;
  const assetLabel = TYPE_CONFIG[assetType]?.label || input.asset.type;
  const sourceContext: AssetFoundationSourceContext = {
    instruction: input.instruction,
    existingFoundation,
    initialDescription,
    contextPackContent,
    visualManual: input.visualManual,
    assetLabel,
  };
  const system = [
    flowSkill,
    "",
    techniqueSkill,
    "",
    "你必须一次性输出完整 XML，格式如下：",
    `<assetResult assetId="${input.asset.id}">`,
    "  <assetFoundation>Markdown 资产基础设定</assetFoundation>",
    "  <visualDesignRationale>Markdown 视觉设计推导</visualDesignRationale>",
    "  <assetImagePrompt>图片生成 prompt</assetImagePrompt>",
    "</assetResult>",
    "",
    "硬性边界：assetFoundation 是事实源，只写资产默认事实和连续性锚点；visualDesignRationale 负责设计取舍，只能在事实源允许的可设计空间内推导；assetImagePrompt 是视觉转译，只能基于 assetFoundation、visualDesignRationale 和当前视觉手册表现，不得新增事实。",
    "",
    "当前资产类型输出 checklist：",
    assetPromptChecklist(assetType),
    "",
    "资产基础设定边界补充：",
    assetFoundationBoundaryRules(assetType),
  ].join("\n");
  const user = [
    `当前 artStyle：${input.project.artStyle || ""}`,
    "",
    `资产ID：${input.asset.id}`,
    `资产名称：${input.asset.name || ""}`,
    `资产类型：${assetLabel}`,
    `是否衍生资产：${input.asset.assetsId ? "是" : "否"}`,
    "",
    "【用户本轮指令】",
    input.instruction || "无",
    "",
    "【写入策略】",
    input.overwrite ? "允许按用户指令重写正式基础设定和图片 prompt。" : "生成本轮最完整、质量最高的正式基础设定；旧初始描述只作为线索，不代表已完成。",
    input.generatePrompt ? "需要生成 assetImagePrompt。" : "可以生成 assetImagePrompt，但后端本次只保存 assetFoundation。",
    "",
    "【资产已有正式基础设定 foundationText】",
    existingFoundation || "无",
    "",
    "【资产初始描述 describe（仅作线索，不是正式基础设定）】",
    initialDescription || "无",
    "",
    contextPackContent ? `【项目制作参考包（主要事实源，优先匹配当前资产信息）】\n${contextPackContent.slice(0, 7000)}\n` : "【项目制作参考包】\n无\n",
    "【当前资产类型视觉手册（只用于 assetImagePrompt，不得反向改写 assetFoundation 事实）】",
    input.visualManual.slice(0, 10000),
  ].join("\n");
  return { system, user, sourceContext };
}

async function repairAssetFoundationOutput(input: {
  prompt: Awaited<ReturnType<typeof buildPrompt>>;
  previousText: string;
  review: AssetFoundationReviewResult;
}) {
  const issues = input.review.issues
    .filter((item) => item.severity === "blocking")
    .map((item, index) => `${index + 1}. ${item.message}${item.reason ? `：${item.reason}` : ""}`)
    .join("\n");
  const result = await u.Ai.Text("universalAi").invoke({
    system: [
      input.prompt.system,
      "",
      "你现在处于审核修复模式：只修复审核问题，不扩写无关内容，不改变资产 ID，不输出 XML 外说明。",
      "必须重新输出完整 <assetResult> XML。",
    ].join("\n"),
    messages: [
      { role: "user", content: input.prompt.user },
      {
        role: "user",
        content: [
          "上一版输出如下：",
          input.previousText,
          "",
          "审核 blocking 问题：",
          issues || "审核未通过，但未提供具体问题。请按事实源和视觉手册重新生成。",
          "",
          "请只根据事实源、视觉补全边界和当前视觉手册重写，输出完整 XML。",
        ].join("\n"),
      },
    ],
  });
  return getAiText(result);
}

export async function selectAssetFoundationTargets(input: AssetFoundationTargetInput) {
  const mode: AssetFoundationMode = input.mode || (input.assetIds?.length ? "selected" : "missingOnly");
  const generatePrompt = input.generatePrompt !== false;
  const query = u
    .db("o_assets")
    .where("projectId", input.projectId)
    .whereIn("type", input.type ? [input.type] : Object.keys(TYPE_CONFIG));
  if (input.assetIds?.length) {
    query.whereIn("id", input.assetIds);
  } else {
    query.whereNull("assetsId");
  }
  if (mode === "missingOnly" && !input.overwrite) {
    query.andWhere((builder: any) => {
      builder.whereNull("foundationText").orWhere("foundationText", "");
      if (generatePrompt) builder.orWhereNull("prompt").orWhere("prompt", "");
    });
  }
  const skipped: Array<{ assetId?: number; reason: string }> = [];
  let rows = await query.orderByRaw(`CASE type WHEN 'role' THEN 1 WHEN 'scene' THEN 2 WHEN 'tool' THEN 3 ELSE 4 END`).orderBy("id");
  let matchedRows = rows;
  const foundIds = new Set(matchedRows.map((row: any) => Number(row.id)));
  if (input.assetIds?.length) {
    for (const assetId of input.assetIds) {
      if (!foundIds.has(Number(assetId))) skipped.push({ assetId, reason: "资产不存在、不属于项目、类型不支持，或已不需要补全" });
    }
  }
  return { mode, rows, skipped };
}

export async function executeAssetFoundationTask(payload: AssetFoundationGeneratePayload) {
  const projectId = Number(payload.projectId);
  const assetId = Number(payload.assetId);
  const generatePrompt = payload.generatePrompt !== false;
  const asset = await u.db("o_assets").where({ id: assetId, projectId }).first();
  if (!asset) throw new Error("资产不存在");
  const config = TYPE_CONFIG[asset.type as AssetFoundationType];
  if (!config) throw new Error(`不支持的资产类型: ${asset.type}`);
  const project = await u.db("o_project").where("id", projectId).select("id", "artStyle").first();
  if (!project) throw new Error("项目不存在");
  const visualManual = await u.getArtPrompt(
    String(project.artStyle || ""),
    "art_skills",
    asset.assetsId ? config.derivativeManual : config.visualManual,
  );
  if (!visualManual) throw new Error("当前项目视觉手册未定义");

  try {
    await u.db("o_assets").where("id", assetId).update({
      foundationStatus: "processing",
      foundationErrorReason: null,
      ...(generatePrompt ? { promptState: "生成中", promptErrorReason: null } : {}),
    });
    const prompt = await buildPrompt({
      asset,
      project,
      visualManual,
      instruction: String(payload.instruction || "").trim(),
      overwrite: Boolean(payload.overwrite),
      generatePrompt,
    });
    const result = await u.Ai.Text("universalAi").invoke({
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
    });
    const text = getAiText(result);
    let parsed = extractAssetResult(text, assetId);
    if (!parsed.foundation) throw new Error("生成 XML 不完整：assetFoundation 为空或缺失");
    if (!parsed.rationale) throw new Error("生成 XML 不完整：visualDesignRationale 为空或缺失");
    if (generatePrompt && !parsed.prompt) throw new Error("生成 XML 不完整：assetImagePrompt 为空或缺失");
    let review = await reviewAssetFoundation({
      asset,
      project,
      foundation: parsed.foundation,
      rationale: parsed.rationale,
      prompt: parsed.prompt,
      sourceContext: prompt.sourceContext,
      generatePrompt,
    });
    if (review.status === "blocked") {
      const repairedText = await repairAssetFoundationOutput({
        prompt,
        previousText: text,
        review,
      });
      parsed = extractAssetResult(repairedText, assetId);
      if (!parsed.foundation) throw new Error("重写后生成 XML 不完整：assetFoundation 为空或缺失");
      if (!parsed.rationale) throw new Error("重写后生成 XML 不完整：visualDesignRationale 为空或缺失");
      if (generatePrompt && !parsed.prompt) throw new Error("重写后生成 XML 不完整：assetImagePrompt 为空或缺失");
      review = await reviewAssetFoundation({
        asset,
        project,
        foundation: parsed.foundation,
        rationale: parsed.rationale,
        prompt: parsed.prompt,
        sourceContext: prompt.sourceContext,
        generatePrompt,
      });
      if (review.status === "blocked") {
        throw new Error(`资产基础设定审核未通过（重写后仍未通过）: ${review.issues.map((item) => item.message).join("; ")}`);
      }
    }
    await u.db.transaction(async (trx: any) => {
      const update: Record<string, unknown> = {
        foundationText: parsed.foundation,
        foundationStatus: "completed",
        foundationErrorReason: null,
      };
      if (generatePrompt) {
        update.prompt = parsed.prompt;
        update.promptState = "已完成";
        update.promptErrorReason = null;
      }
      await trx("o_assets").where({ id: assetId, projectId }).update(update);
    });
    return {
      businessId: assetId,
      assetId,
      foundationText: parsed.foundation,
      prompt: generatePrompt ? parsed.prompt : undefined,
      review,
    };
  } catch (error) {
    const message = u.error(error).message;
    await u.db("o_assets").where({ id: assetId, projectId }).update({
      foundationStatus: "failed",
      foundationErrorReason: message,
      ...(generatePrompt ? { promptState: "生成失败", promptErrorReason: message } : {}),
    });
    throw error;
  }
}
