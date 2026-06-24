import path from "path";
import fs from "fs";
import { Knex } from "knex";
import { transform } from "sucrase";
import { VM } from "vm2";
import rawVendorData from "./vendor.json";
import { failInterruptedImageFlowTasks, migrateImageFlowContractV2 } from "@/lib/migrations/imageFlowContractV2";
import {
  migrateVideoQueueV2,
  recoverInterruptedQueuedTasksFromBackup,
  recoverVideoQueueAfterRestart,
} from "@/lib/migrations/videoQueueV2";
import { migrateVideoQueueV3 } from "@/lib/migrations/videoQueueV3";
import { migrateVideoQueueV4 } from "@/lib/migrations/videoQueueV4";
import { migrateVideoQueueV5 } from "@/lib/migrations/videoQueueV5";
import { migrateStoryboardEditorContractV1 } from "@/lib/migrations/storyboardEditorContractV1";
import {
  migrateUnifiedTaskV1,
  recoverInterruptedEphemeralTasks,
} from "@/lib/migrations/unifiedTaskV1";
import { migrateMediaPathContractV1 } from "@/lib/migrations/mediaPathContractV1";
import getPath from "@/utils/getPath";

const vendorData = rawVendorData as Record<string, string>;
const SNAPSHOT_DECOUPLING_KEY = "migration:project-snapshot-decoupling-v1";

function getVendorFile(id: string | number) {
  return path.join(getPath("vendor"), `${id}.ts`);
}

function writeVendorCode(id: string | number, tsCode: string) {
  const rootDir = getPath("vendor");
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(getVendorFile(id), tsCode);
}

function getVendorVersion(id: string) {
  const file = getVendorFile(id);
  if (!fs.existsSync(file)) return "0";
  const code = fs.readFileSync(file, "utf8");
  return code.match(/\bversion\s*:\s*["']([^"']+)["']/)?.[1] || "0";
}

function readVendorFromCode(tsCode: string) {
  const jsCode = transform(tsCode, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
  const exports: Record<string, any> = {};
  new VM({
    sandbox: {
      exports,
      logger: () => {},
      fetch: async () => {
        throw new Error("fixDB vendor metadata sandbox does not allow fetch");
      },
    },
    timeout: 1000,
    eval: false,
    wasm: false,
  }).run(jsCode);
  return exports.vendor;
}

async function migrateProjectSnapshotDecoupling(knex: Knex) {
  if (await knex("o_setting").where("key", SNAPSHOT_DECOUPLING_KEY).first()) {
    return { skipped: true, repaired: 0, trimmed: 0, retyped: 0 };
  }
  const now = Date.now();
  let repaired = 0;
  let trimmed = 0;
  let retyped = 0;

  await knex.transaction(async (trx) => {
    retyped = await trx("o_tasks")
      .whereIn("businessType", ["project-snapshot", "project-import", "storage-migration"])
      .whereNot("taskType", "maintenance")
      .update({ taskType: "maintenance", updateTime: now });

    trimmed = await trx("o_tasks")
      .where("businessType", "project-snapshot")
      .whereNotNull("resultJson")
      .whereRaw("length(resultJson) > 65536")
      .update({ resultJson: null, updateTime: now });

    repaired = await trx("o_tasks")
      .where("businessType", "project-snapshot")
      .where("status", "failed")
      .whereExists(function () {
        this.select(1)
          .from("o_projectStorage")
          .whereRaw("o_projectStorage.projectId = o_tasks.projectId")
          .where("o_projectStorage.snapshotState", "ready")
          .whereRaw("o_projectStorage.revision <= o_projectStorage.snapshotRevision");
      })
      .update({
        status: "completed",
        phase: "completed",
        progress: 100,
        resultJson: null,
        reason: null,
        finishTime: now,
        updateTime: now,
      });

    await trx("o_setting").insert({
      key: SNAPSHOT_DECOUPLING_KEY,
      value: JSON.stringify({ completedAt: now, repaired, trimmed, retyped }),
    });
  });

  return { skipped: false, repaired, trimmed, retyped };
}

export default async (knex: Knex): Promise<void> => {
  const addColumn = async (table: string, column: string, type: string) => {
    if (!(await knex.schema.hasTable(table))) return;
    if (!(await knex.schema.hasColumn(table, column))) {
      await knex.schema.alterTable(table, (t) => (t as any)[type](column));
    }
  };

  const dropColumn = async (table: string, column: string) => {
    if (!(await knex.schema.hasTable(table))) return;
    if (await knex.schema.hasColumn(table, column)) {
      await knex.schema.alterTable(table, (t) => t.dropColumn(column));
    }
  };

  const alterColumnType = async (table: string, column: string, type: string) => {
    if (!(await knex.schema.hasTable(table))) return;
    if (await knex.schema.hasColumn(table, column)) {
      await knex.schema.alterTable(table, (t) => {
        (t as any)[type](column).alter();
      });
    }
  };
  //矫正因软件异常退出导致的状态不一致问题
  await knex("o_novel").where("eventState", 0).update({
    eventState: -1,
    errorReason: "软件退出导致失败",
  });
  await knex("o_script").where("extractState", 0).update({
    extractState: -1,
    errorReason: "软件退出导致失败",
  });
  await knex("o_assets").where("promptState", "生成中").update({
    promptState: "生成失败",
    promptErrorReason: "软件退出导致失败",
  });
  await knex("o_image").where("state", "生成中").update({
    state: "生成失败",
    errorReason: "软件退出导致失败",
  });
  await knex("o_storyboard").where("state", "生成中").update({
    state: "生成失败",
    reason: "软件退出导致失败",
  });
  await knex("o_video")
    .where("state", "生成中")
    .whereNotExists(function () {
      this.select(1)
        .from("o_videoGenerationTask")
        .whereRaw("o_videoGenerationTask.videoId = o_video.id")
        .whereIn("o_videoGenerationTask.state", ["排队中", "提交中", "生成中"]);
    })
    .update({
    state: "生成失败",
    errorReason: "软件退出导致失败",
  });

  // 添加新字段
  await addColumn("o_prompt", "useData", "text");
  // 添加新字段
  await addColumn("o_agentDeploy", "type", "string");
  // 添加新字段
  await addColumn("o_agentDeploy", "temperature", "integer");
  // 添加新字段
  await addColumn("o_agentDeploy", "maxOutputTokens", "integer");
  await addColumn("o_assets", "audioBindState", "integer");
  await addColumn("o_modelPrompt", "fileName", "string");
  await addColumn("o_modelPrompt", "path", "string");
  const vendorDataSelect = await knex("o_vendorConfig").whereIn("id", ["deepseek", "atlascloud"]).select("*");
  if (!vendorDataSelect.find((i) => i.id == "deepseek")) {
    await knex("o_vendorConfig").insert({
      id: "deepseek",
      inputValues: "{}",
      models: "[]",
      enable: 0,
    });
  }
  if (!vendorDataSelect.find((i) => i.id == "atlascloud")) {
    await knex("o_vendorConfig").insert({
      id: "atlascloud",
      inputValues: "{}",
      models: "[]",
      enable: 0,
    });
  }
  //检测是否包含新增音色绑定提示词
  const existAudioPrompt = await knex("o_prompt").where("type", "audioBindPrompt").first();
  if (!existAudioPrompt)
    await knex("o_prompt").insert({
      name: "音色绑定",
      type: "audioBindPrompt",
      data: `你是一个音色匹配助手。\n你的任务是：根据给定角色资产的名称与描述，从候选音频列表中选出最合适的音色。\n匹配规则：\n1. 优先根据角色性别、年龄、性格等特征与音色描述进行语义匹配；\n2. 同一角色仅可匹配一个音色；\n3. 若候选列表中没有合适的音色，则无需返回 audioId；`,
    });
  //检测o_setting是否有agentUseMode
  const agentUserMode = await knex("o_setting").where("key", "agentUseMode").first();
  if (!agentUserMode) {
    const allDeployData = await knex("o_agentDeploy")
      .leftJoin("o_vendorConfig", "o_vendorConfig.id", "o_agentDeploy.vendorId")
      .select("o_agentDeploy.*");
    const advancedData = allDeployData.filter((item: any) => item.key?.includes(":"));
    const notValModelData = advancedData.filter((item) => !item.modelName);

    await knex("o_setting").insert({
      key: "agentUseMode",
      value: notValModelData.length ? "0" : "1",
    });
  }
  //添加数据高级配置
  if (!(await knex("o_agentDeploy").where("key", "storyAgent").first())) {
    await knex("o_agentDeploy").insert({
      model: "",
      modelName: "",
      vendorId: null,
      key: "storyAgent",
      name: "Story Agent",
      desc: "Story ideation, outline, script writing, and annotation-based revision",
      disabled: false,
    });
  }
  const advancedAgentList = [
    { key: "storyAgent:decisionAgent", name: "Story Agent: Decision", desc: "Story creation and annotation revision" },
    { key: "scriptAgent:decisionAgent", name: "剧本Agent:决策层", desc: "决策层" },
    { key: "scriptAgent:supervisionAgent", name: "剧本Agent:监督层", desc: "监督层" },
    { key: "scriptAgent:storySkeletonAgent", name: "剧本Agent:故事骨架", desc: "故事骨架生成" },
    { key: "scriptAgent:adaptationStrategyAgent", name: "剧本Agent:改编策略", desc: "改编策略生成" },
    { key: "scriptAgent:scriptAgent", name: "剧本Agent:剧本生成", desc: "剧本生成" },
    { key: "productionAgent:decisionAgent", name: "生产Agent:决策层", desc: "决策层" },
    { key: "productionAgent:supervisionAgent", name: "生产Agent:监督层", desc: "监督层" },
    { key: "productionAgent:deriveAssetsAgent", name: "生产Agent:衍生资产", desc: "衍生资产" },
    { key: "productionAgent:generateAssetsAgent", name: "生产Agent:生成资产", desc: "生成资产" },
    { key: "productionAgent:directorPlanAgent", name: "生产Agent:导演规划", desc: "导演规划" },
    { key: "productionAgent:storyboardGenAgent", name: "生产Agent:分镜生成", desc: "分镜生成" },
    { key: "productionAgent:storyboardPanelAgent", name: "生产Agent:分镜面板", desc: "分镜面板生成" },
    { key: "productionAgent:storyboardTableAgent", name: "生产Agent:分镜表格", desc: "分镜表格生成" },
  ];
  for (const agent of advancedAgentList) {
    const exists = await knex("o_agentDeploy").where("key", agent.key).select("*").first();
    if (!exists) {
      await knex("o_agentDeploy").insert({
        model: "",
        modelName: "",
        vendorId: null,
        key: agent.key,
        name: agent.name,
        desc: agent.desc,
        temperature: 1,
        maxOutputTokens: 0,
        disabled: false,
      });
    }
  }
  //矫正提示词
  await knex("o_prompt").where("type", "scriptAssetExtraction").update({
    data: `---\nname: universal_agent\ndescription: 专注于从剧本内容中提取所使用的资产（角色、场景、道具）并生成结构化资产列表的助手。\n---\n\n# Script Assets Extract\n\n你是一个专业的剧本内容分析助手，专注于从剧本文本中识别和提取所有涉及的资产（角色、场景、道具），并为每项资产生成可供下游制作流程使用的结构化描述和提示词。\n\n## 何时使用\n\n用户提供剧本内容，你需要逐段阅读并提取其中涉及的所有资产（人物角色、场景地点、道具物件），输出为结构化的资产列表。产出的资产描述将用于后续 AI 图片生成和制作流程。\n\n## 与系统的对应关系\n\n- 资产类型：\n  - \`role\` — 角色（对应 \`o_assets.type = "role"\`）\n  - \`scene\` — 场景（对应 \`o_assets.type = "scene"\`）\n  - \`tool\` — 道具（对应 \`o_assets.type = "tool"\`）\n- 下游用途：资产提示词生成 → AI 资产图生成 → 分镜制作\n\n## 输出要求\n\n**必须通过调用 \`resultTool\` 工具返回结果**，禁止以纯文本、Markdown 表格或 JSON 代码块等形式直接输出资产列表。\n\`resultTool\` 的 schema 会对字段类型和枚举值做强校验，调用时请严格按照下方字段定义填写，确保数据结构正确、字段完整、类型匹配。\n\n每个资产对象包含以下字段：\n\n| 字段 | 类型 | 必填 | 说明 |\n| ---- | ---- | ---- | ---- |\n| \`name\` | string | 是 | 资产名称，使用剧本中的原始称呼,不做其他多余描述 |\n| \`desc\` | string | 是 | 资产描述，30-80 字的视觉化描述 |\n| \`prompt\` | string | 是 | 生成提示词，英文，用于 AI 图片生成 |\n| \`type\` | enum | 是 | 资产类型：\`role\` / \`scene\` / \`tool\`  |\n\n## 提取规则\n\n### 角色（role）\n\n- 提取剧本中出现的所有有名字的角色\n- \`desc\`：包含性别、外貌特征、服饰风格、体态气质等视觉要素，需在描述开头明确标注角色性别（如"男性，……"或"女性，……"）\n- \`prompt\`：英文提示词，描述角色的外观特征，需以性别词开头（如 \`a young man, ...\` 或 \`a young woman, ...\`），适用于 AI 角色图生成\n- 同一角色有多个称呼时，取最常用的作为 \`name\`\n- 无名龙套（如"路人甲"、"士兵"）可跳过，除非其造型对剧情有重要视觉意义\n\n### 场景（scene）\n\n- 提取剧本中出现的所有场景/地点\n- \`desc\`：包含空间结构、光照氛围、关键陈设、色调基调等视觉要素\n- \`prompt\`：英文提示词，描述场景的整体视觉风格，适用于 AI 场景图生成\n- 同一场景的不同状态（如白天/夜晚）不重复提取，在 \`desc\` 中注明即可\n\n### 道具（tool）\n\n- 提取剧本中出现的重要道具/物品\n- \`desc\`：包含外观形状、颜色材质、尺寸参考、特殊效果等视觉要素\n- \`prompt\`：英文提示词，描述道具的外观细节，适用于 AI 道具图生成\n- 仅提取有独立视觉意义或剧情功能的道具，通用物品可跳过\n\n\n## 提示词（prompt）生成规范\n\n- 采用逗号分隔的关键词/短语格式\n- 优先描述**视觉特征**，避免抽象概念\n- 包含风格关键词（如 anime style, manga style 等，根据项目风格决定）\n- 角色 prompt 示例：\`a young man, sharp eyebrows, black hair, pale skin, wearing a gray Taoist robe, slender build, cold expression\`\n- 场景 prompt 示例：\`dark cave interior, glowing crystals on walls, misty atmosphere, dim blue lighting, stone altar in center\`\n- 道具 prompt 示例：\`ancient jade pendant, oval shape, translucent green, carved dragon pattern, glowing faintly\`\n\n## 提取流程\n\n1. 通读剧本全文，识别所有出现的角色、场景、道具\n2. 对每个资产生成结构化的 \`name\`、\`desc\`、\`prompt\`、\`type\`\n3. 去重：同一资产不重复提取\n4. **必须通过调用 \`resultTool\` 工具输出完整资产列表**，不要分多次调用，一次性将所有资产放入 \`assetsList\` 数组中提交\n\n## 提取原则\n\n1. **忠于剧本**：所有提取基于剧本中的实际内容，不臆造未出现的资产\n2. **视觉优先**：描述和提示词聚焦视觉特征，便于 AI 图片生成\n3. **精简实用**：只提取对制作有实际意义的资产，避免过度提取\n4. **分类准确**：严格按照 role/scene/tool 分类，不混淆\n5. **提示词质量**：英文提示词应具体、可执行，能直接用于 AI 图片生成\n\n## 注意事项\n\n- 资产列表中**不要包含剧本内容本身**，仅提取所使用到的资产\n- 角色的随身物品如果有独立剧情功能，应单独作为道具提取\n- 场景中的固定陈设不需要单独提取为道具，除非该物件有独立剧情作用`,
  });
  await knex("o_prompt").where("type", "videoPromptGeneration").update({
    data: [
      "# Video Prompt Generation Skill",
      "",
      "The backend provides structured <trackStoryboard ...> facts and visual references.",
      "Read only structured attributes: duration, location, timeOfDay, scene, picture, action, shotSize, cameraMove, dialogue, sound, visibleEmotion, groupKey, groupName, groupIntent, beatId, characters, requiredAssets.",
      "Do not parse or infer business facts from videoDesc, Markdown, XML text, image prompts, chat text, or any other prose.",
      "Generate the target model video prompt only. Dialogue, voice tone and diegetic sound effects must come from structured fields; BGM, score and OST are not valid video prompt content.",
    ].join("\\n"),
  });

  //迁移供应商函数
  const data = await knex("o_vendorConfig").select("*");
  for (const item of data) {
    let { id, code } = item;
    const filename = `${id}.ts`;
    const rootDir = getPath("vendor");
    if (!code && fs.existsSync(path.join(rootDir, filename))) continue;
    if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
    if (!fs.existsSync(path.join(rootDir, filename))) {
      code = vendorData[filename] || code;
      code = code ?? "";
      fs.writeFileSync(path.join(rootDir, filename), code);
    }
  }
  const defList = Object.keys(vendorData).map((filename) => filename.replace(/\.ts$/, ""));
  const existingIds = data.map((i: any) => i.id);
  for (const id of defList) {
    if (!existingIds.includes(id)) {
      const tsCode = vendorData[`${id}.ts`];
      if (tsCode) await tempOnsert(knex, tsCode);
    }
  }

  await dropColumn("o_vendorConfig", "author");
  await dropColumn("o_vendorConfig", "description");
  await dropColumn("o_vendorConfig", "name");
  await dropColumn("o_vendorConfig", "icon");
  await dropColumn("o_vendorConfig", "inputs");
  await dropColumn("o_vendorConfig", "createTime");


  // 新增 o_editImageTask 表
  if (!(await knex.schema.hasTable("o_editImageTask"))) {
    await knex.schema.createTable("o_editImageTask", (t) => {
      t.integer("id").notNullable();
      t.integer("projectId");
      t.integer("scriptId");
      t.integer("deriveAssetId");
      t.string("targetType");
      t.integer("targetId");
      t.integer("flowId");
      t.text("nodeId");
      t.text("references");
      t.text("model");
      t.text("quality");
      t.text("ratio");
      t.text("prompt");
      t.string("status");
      t.string("state");
      t.text("url");
      t.text("reason");
      t.integer("taskCenterId");
      t.integer("createTime");
      t.integer("updateTime");
      t.primary(["id"]);
      t.unique(["id"]);
    });
  }
  await addColumn("o_editImageTask", "targetType", "string");
  await addColumn("o_editImageTask", "targetId", "integer");
  await addColumn("o_editImageTask", "status", "string");
  await addColumn("o_storyboard", "referenceImages", "text");
  await knex("o_storyboard").whereNull("referenceImages").update({ referenceImages: "[]" });

  if (!(await knex.schema.hasTable("o_videoGenerationTask"))) {
    await knex.schema.createTable("o_videoGenerationTask", (t) => {
      t.integer("id").notNullable();
      t.integer("videoId");
      t.integer("projectId");
      t.integer("scriptId");
      t.text("model");
      t.string("vendorId");
      t.integer("taskCenterId");
      t.text("requestJson");
      t.string("submitId");
      t.string("status");
      t.string("state");
      t.text("errorReason");
      t.text("rawOutput");
      t.integer("nextPollTime");
      t.integer("pollCount");
      t.integer("startTime");
      t.integer("updateTime");
      t.integer("finishTime");
      t.primary(["id"]);
      t.unique(["id"]);
    });
  }
  await addColumn("o_videoGenerationTask", "videoId", "integer");
  await addColumn("o_videoGenerationTask", "projectId", "integer");
  await addColumn("o_videoGenerationTask", "scriptId", "integer");
  await addColumn("o_videoGenerationTask", "model", "text");
  await addColumn("o_videoGenerationTask", "vendorId", "string");
  await addColumn("o_videoGenerationTask", "taskCenterId", "integer");
  await addColumn("o_videoGenerationTask", "payloadVersion", "integer");
  await addColumn("o_videoGenerationTask", "requestJson", "text");
  await addColumn("o_videoGenerationTask", "submitId", "string");
  await addColumn("o_videoGenerationTask", "officialTaskId", "string");
  await addColumn("o_videoGenerationTask", "historyRecordId", "string");
  await addColumn("o_videoGenerationTask", "providerAccountId", "string");
  await addColumn("o_videoGenerationTask", "providerModelKey", "string");
  await addColumn("o_videoGenerationTask", "providerSubmittedAt", "integer");
  await addColumn("o_videoGenerationTask", "phase", "string");
  await addColumn("o_videoGenerationTask", "status", "string");
  await addColumn("o_videoGenerationTask", "state", "string");
  await addColumn("o_videoGenerationTask", "errorReason", "text");
  await addColumn("o_videoGenerationTask", "rawOutput", "text");
  await addColumn("o_videoGenerationTask", "nextPollTime", "integer");
  await addColumn("o_videoGenerationTask", "nextSubmitTime", "integer");
  await addColumn("o_videoGenerationTask", "pollCount", "integer");
  await addColumn("o_videoGenerationTask", "submitAttemptCount", "integer");
  await addColumn("o_videoGenerationTask", "capacityWaitStartedAt", "integer");
  await addColumn("o_videoGenerationTask", "confirmStartedAt", "integer");
  await addColumn("o_videoGenerationTask", "confirmDeadline", "integer");
  await addColumn("o_videoGenerationTask", "remoteConfirmedAt", "integer");
  await addColumn("o_videoGenerationTask", "lastProviderStatus", "string");
  await addColumn("o_videoGenerationTask", "lastProviderCode", "string");
  await addColumn("o_videoGenerationTask", "providerQueueStatus", "integer");
  await addColumn("o_videoGenerationTask", "providerQueueIndex", "integer");
  await addColumn("o_videoGenerationTask", "providerQueueLength", "integer");
  await addColumn("o_videoGenerationTask", "startTime", "integer");
  await addColumn("o_videoGenerationTask", "updateTime", "integer");
  await addColumn("o_videoGenerationTask", "finishTime", "integer");

  if (!(await knex.schema.hasTable("o_videoProviderCapacity"))) {
    await knex.schema.createTable("o_videoProviderCapacity", (t) => {
      t.increments("id").primary();
      t.string("vendorId").notNullable();
      t.string("providerAccountId").notNullable().defaultTo("default");
      t.string("providerModelKey").notNullable();
      t.integer("capacityBlocked").notNullable().defaultTo(0);
      t.integer("blockedUntil");
      t.string("lastProviderCode");
      t.integer("createTime").notNullable();
      t.integer("updateTime").notNullable();
      t.unique(["vendorId", "providerAccountId", "providerModelKey"], {
        indexName: "uq_video_provider_capacity",
      });
    });
  }

  if (!(await knex.schema.hasTable("o_workbenchMergedReference"))) {
    await knex.schema.createTable("o_workbenchMergedReference", (t) => {
      t.integer("id").notNullable();
      t.integer("projectId").notNullable();
      t.integer("scriptId").notNullable();
      t.integer("trackId").notNullable();
      t.string("mergeType").notNullable();
      t.text("name");
      t.text("filePath").notNullable();
      t.string("fileType").notNullable();
      t.text("prompt");
      t.text("sourceRefs").notNullable();
      t.integer("position").notNullable();
      t.string("state").notNullable();
      t.integer("createTime").notNullable();
      t.integer("updateTime").notNullable();
      t.primary(["id"]);
      t.unique(["id"]);
    });
  }
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_merged_reference_owner ON o_workbenchMergedReference(projectId, scriptId, trackId)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_merged_reference_track_state ON o_workbenchMergedReference(trackId, state)");

  if (!(await knex.schema.hasTable("o_directorAsset"))) {
    await knex.schema.createTable("o_directorAsset", (t) => {
      t.integer("id").notNullable();
      t.integer("projectId").notNullable();
      t.integer("scriptId");
      t.integer("flowId");
      t.string("nodeId").notNullable();
      t.string("targetType");
      t.integer("targetId");
      t.integer("assetId").notNullable();
      t.integer("imageId").notNullable();
      t.string("assetType").notNullable();
      t.text("name").notNullable();
      t.text("promptFragment");
      t.text("sourceRefs").notNullable();
      t.text("camera");
      t.text("stageDraft");
      t.integer("createTime").notNullable();
      t.integer("updateTime").notNullable();
      t.primary(["id"]);
      t.unique(["id"]);
    });
  }
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_director_asset_project_script ON o_directorAsset(projectId, scriptId)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_director_asset_asset ON o_directorAsset(assetId)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_director_asset_flow_node ON o_directorAsset(flowId, nodeId)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_director_asset_target ON o_directorAsset(targetType, targetId)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_director_asset_type ON o_directorAsset(assetType)");

  if (!(await knex.schema.hasTable("o_storyArtifact"))) {
    await knex.schema.createTable("o_storyArtifact", (table) => {
      table.increments("id").primary();
      table.integer("projectId").notNullable();
      table.string("type").notNullable();
      table.text("title").notNullable();
      table.text("content").notNullable();
      table.text("contentJson");
      table.integer("version").notNullable().defaultTo(1);
      table.integer("parentId");
      table.string("status").notNullable().defaultTo("draft");
      table.integer("createTime");
      table.integer("updateTime");
    });
  }
  if (!(await knex.schema.hasTable("o_storyAnnotation"))) {
    await knex.schema.createTable("o_storyAnnotation", (table) => {
      table.increments("id").primary();
      table.integer("projectId").notNullable();
      table.integer("artifactId").notNullable();
      table.integer("artifactVersion").notNullable().defaultTo(1);
      table.string("blockId");
      table.integer("startOffset");
      table.integer("endOffset");
      table.text("selectedText").notNullable();
      table.text("comment").notNullable();
      table.string("status").notNullable().defaultTo("open");
      table.integer("createTime");
      table.integer("updateTime");
    });
  }
  if (!(await knex.schema.hasTable("o_storyRevisionMap"))) {
    await knex.schema.createTable("o_storyRevisionMap", (table) => {
      table.increments("id").primary();
      table.integer("projectId").notNullable();
      table.integer("sourceArtifactId").notNullable();
      table.integer("newArtifactId").notNullable();
      table.text("annotationIds");
      table.text("changeSummary");
      table.integer("createTime");
    });
  }
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_story_artifact_project_type ON o_storyArtifact(projectId, type, status)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_story_annotation_artifact_status ON o_storyAnnotation(artifactId, status)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_story_revision_project_source ON o_storyRevisionMap(projectId, sourceArtifactId)");

  await knex.raw(`
    UPDATE o_editImageTask
    SET targetType = 'deriveAsset', targetId = deriveAssetId
    WHERE targetType IS NULL AND deriveAssetId IS NOT NULL
  `);
  await knex.raw(`
    UPDATE o_editImageTask
    SET status = CASE state
      WHEN '未生成' THEN 'pending'
      WHEN '生成中' THEN 'processing'
      WHEN '已完成' THEN 'completed'
      WHEN '生成失败' THEN 'failed'
      ELSE status
    END
    WHERE status IS NULL
  `);
  await knex.raw(`
    UPDATE o_videoGenerationTask
    SET status = CASE state
      WHEN '排队中' THEN 'queued'
      WHEN '提交中' THEN 'submitting'
      WHEN '生成中' THEN 'processing'
      WHEN '已完成' THEN 'completed'
      WHEN '生成失败' THEN 'failed'
      ELSE status
    END
    WHERE status IS NULL
  `);
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_edit_image_target ON o_editImageTask(targetType, targetId, createTime)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_edit_image_flow_node ON o_editImageTask(flowId, nodeId)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_edit_image_status ON o_editImageTask(status, state)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_video_queue_schedule ON o_videoGenerationTask(status, nextPollTime)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_video_queue_model ON o_videoGenerationTask(model, status)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_video_queue_provider_model ON o_videoGenerationTask(providerModelKey, status)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_video_queue_submit_schedule ON o_videoGenerationTask(status, nextSubmitTime)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_video_provider_capacity_schedule ON o_videoProviderCapacity(providerModelKey, blockedUntil)");

  // o_tasks 补 episode 列
  await addColumn("o_tasks", "episode", "integer");
  await addColumn("o_tasks", "taskId", "string");
  await addColumn("o_tasks", "scriptId", "integer");
  await addColumn("o_tasks", "taskType", "string");
  await addColumn("o_tasks", "status", "string");
  await addColumn("o_tasks", "phase", "string");
  await addColumn("o_tasks", "progress", "float");
  await addColumn("o_tasks", "targetType", "string");
  await addColumn("o_tasks", "targetId", "string");
  await addColumn("o_tasks", "nodeId", "string");
  await addColumn("o_tasks", "businessType", "string");
  await addColumn("o_tasks", "businessId", "integer");
  await addColumn("o_tasks", "handler", "string");
  await addColumn("o_tasks", "payloadJson", "text");
  await addColumn("o_tasks", "resultJson", "text");
  await addColumn("o_tasks", "priority", "integer");
  await addColumn("o_tasks", "availableAt", "integer");
  await addColumn("o_tasks", "leaseOwner", "string");
  await addColumn("o_tasks", "leaseExpiresAt", "integer");
  await addColumn("o_tasks", "attempt", "integer");
  await addColumn("o_tasks", "maxAttempts", "integer");
  await addColumn("o_tasks", "version", "integer");
  await addColumn("o_tasks", "createdAt", "integer");
  await addColumn("o_tasks", "updateTime", "integer");
  await addColumn("o_tasks", "finishTime", "integer");
  await addColumn("o_tasks", "providerTaskId", "string");
  await addColumn("o_tasks", "providerSubmittedAt", "integer");
  await addColumn("o_tasks", "idempotencyKey", "string");

  if (!(await knex.schema.hasTable("o_taskEvent"))) {
    await knex.schema.createTable("o_taskEvent", (table) => {
      table.increments("id").primary();
      table.string("taskId").notNullable();
      table.integer("legacyTaskId");
      table.integer("version").notNullable();
      table.string("taskType").notNullable();
      table.integer("projectId");
      table.integer("scriptId");
      table.string("targetType");
      table.string("targetId");
      table.string("nodeId");
      table.string("status").notNullable();
      table.string("phase");
      table.float("progress");
      table.text("resultJson");
      table.text("reason");
      table.integer("createdAt").notNullable();
    });
  }
  await knex.raw("CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_task_id ON o_tasks(taskId)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON o_tasks(projectId, status, updateTime)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_tasks_type_status ON o_tasks(taskType, status, updateTime)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_tasks_dispatch ON o_tasks(status, availableAt, priority)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_tasks_lease ON o_tasks(leaseOwner, leaseExpiresAt)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_tasks_business ON o_tasks(businessType, businessId)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_task_event_task_version ON o_taskEvent(taskId, version)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_task_event_scope ON o_taskEvent(projectId, scriptId, id)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_task_event_created ON o_taskEvent(createdAt)");

  if (!(await knex.schema.hasTable("o_textAsset"))) {
    await knex.schema.createTable("o_textAsset", (table) => {
      table.integer("id").notNullable();
      table.integer("projectId").notNullable();
      table.integer("scriptId");
      table.string("targetType").notNullable();
      table.string("targetId");
      table.text("filePath").notNullable();
      table.text("summary");
      table.integer("size").notNullable().defaultTo(0);
      table.string("hash").notNullable();
      table.integer("version").notNullable().defaultTo(1);
      table.string("state").notNullable().defaultTo("complete");
      table.integer("createTime").notNullable();
      table.integer("updateTime").notNullable();
      table.primary(["id"]);
      table.unique(["id"]);
    });
  }
  await addColumn("o_textAsset", "scriptId", "integer");
  await addColumn("o_textAsset", "targetId", "string");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_text_asset_target ON o_textAsset(projectId, scriptId, targetType, targetId)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_text_asset_state ON o_textAsset(state, updateTime)");

  await addColumn("o_storyboard", "groupKey", "text");
  await addColumn("o_storyboard", "groupName", "text");
  await addColumn("o_storyboard", "groupIntent", "text");
  await addColumn("o_storyboard", "beatId", "text");
  await addColumn("o_storyboard", "scene", "text");
  await addColumn("o_storyboard", "picture", "text");
  await addColumn("o_storyboard", "action", "text");
  await addColumn("o_storyboard", "shotSize", "text");
  await addColumn("o_storyboard", "cameraMove", "text");
  await addColumn("o_storyboard", "dialogue", "text");
  await addColumn("o_storyboard", "sound", "text");
  await addColumn("o_storyboard", "visibleEmotion", "text");
  await addColumn("o_storyboard", "location", "text");
  await addColumn("o_storyboard", "timeOfDay", "text");
  await addColumn("o_storyboard", "sceneContinuityId", "text");
  await addColumn("o_storyboard", "tableRowJson", "text");
  await addColumn("o_storyboard", "factStatus", "text");
  await addColumn("o_storyboard", "factVersion", "integer");
  await addColumn("o_storyboard", "factRevision", "integer");
  await knex("o_storyboard").whereNull("factStatus").update({
    factStatus: knex.raw("CASE WHEN tableRowJson IS NULL OR TRIM(tableRowJson) = '' THEN 'legacy' ELSE 'draft' END"),
  });
  await knex("o_storyboard").whereNull("factVersion").update({ factVersion: 1 });
  await knex("o_storyboard").whereNull("factRevision").update({ factRevision: 0 });
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_storyboard_scope_index ON o_storyboard(projectId, scriptId, [index])");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_storyboard_track ON o_storyboard(trackId)");
  await addColumn("o_videoTrack", "groupKey", "text");
  await addColumn("o_videoTrack", "groupName", "text");
  await addColumn("o_videoTrack", "groupIntent", "text");
  await addColumn("o_videoTrack", "musicPlanJson", "text");
  await addColumn("o_videoTrack", "groupPlanJson", "text");
  await addColumn("o_videoTrack", "reviewState", "text");
  await addColumn("o_videoTrack", "reviewIssuesJson", "text");
  await addColumn("o_videoTrack", "archived", "integer");
  await knex("o_videoTrack").whereNull("reviewState").update({ reviewState: "pending" });
  await knex("o_videoTrack").whereNull("reviewIssuesJson").update({ reviewIssuesJson: "[]" });
  await knex("o_videoTrack").whereNull("archived").update({ archived: 0 });

  if (!(await knex.schema.hasTable("o_storyboardGeneration"))) {
    await knex.schema.createTable("o_storyboardGeneration", (table) => {
      table.increments("id").primary();
      table.string("generationId").notNullable().unique();
      table.integer("projectId").notNullable();
      table.integer("scriptId").notNullable();
      table.integer("expectedRowCount").notNullable();
      table.text("groupPlanJson").notNullable();
      table.string("state").notNullable().defaultTo("writing");
      table.integer("revision");
      table.integer("createdAt").notNullable();
      table.integer("updatedAt").notNullable();
    });
  }
  await addColumn("o_storyboardGeneration", "errorJson", "text");
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS idx_storyboard_generation_scope ON o_storyboardGeneration(projectId, scriptId, state)",
  );
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS idx_storyboard_generation_expiry ON o_storyboardGeneration(state, updatedAt)",
  );

  if (!(await knex.schema.hasTable("o_storyboardGenerationRow"))) {
    await knex.schema.createTable("o_storyboardGenerationRow", (table) => {
      table.increments("id").primary();
      table.string("generationId").notNullable();
      table.integer("rowIndex").notNullable();
      table.text("rowJson").notNullable();
      table.string("rowHash").notNullable();
      table.integer("createdAt").notNullable();
      table.integer("updatedAt").notNullable();
      table.unique(["generationId", "rowIndex"], {
        indexName: "uq_storyboard_generation_row",
      });
    });
  }
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS idx_storyboard_generation_row_order ON o_storyboardGenerationRow(generationId, rowIndex)",
  );
  await knex.raw(
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_storyboard_generation_row ON o_storyboardGenerationRow(generationId, rowIndex)",
  );

  if (!(await knex.schema.hasTable("o_productionReviewSuggestion"))) {
    await knex.schema.createTable("o_productionReviewSuggestion", (table) => {
      table.increments("id").primary();
      table.integer("projectId").notNullable();
      table.integer("scriptId");
      table.string("targetType").notNullable();
      table.string("targetId").notNullable();
      table.integer("parentId");
      table.integer("version").notNullable().defaultTo(1);
      table.string("issueType").notNullable();
      table.string("severity").notNullable();
      table.text("message").notNullable();
      table.text("reason");
      table.text("proposedAction");
      table.text("proposedPatch");
      table.string("status").notNullable().defaultTo("open");
      table.integer("createTime").notNullable();
      table.integer("updateTime").notNullable();
    });
  }
  if (!(await knex.schema.hasTable("o_productionReviewFeedback"))) {
    await knex.schema.createTable("o_productionReviewFeedback", (table) => {
      table.increments("id").primary();
      table.integer("suggestionId").notNullable();
      table.integer("projectId").notNullable();
      table.integer("scriptId");
      table.text("comment").notNullable();
      table.string("mode").notNullable();
      table.integer("createTime").notNullable();
    });
  }
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_review_suggestion_target ON o_productionReviewSuggestion(projectId, scriptId, targetType, targetId)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_review_suggestion_status ON o_productionReviewSuggestion(status, severity)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_review_feedback_suggestion ON o_productionReviewFeedback(suggestionId)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_review_feedback_scope ON o_productionReviewFeedback(projectId, scriptId)");

  if (!(await knex.schema.hasTable("o_projectStorage"))) {
    await knex.schema.createTable("o_projectStorage", (table) => {
      table.integer("projectId").notNullable().primary();
      table.string("storageKey").notNullable().unique();
      table.integer("revision").notNullable().defaultTo(1);
      table.integer("snapshotRevision").notNullable().defaultTo(0);
      table.string("snapshotState").notNullable().defaultTo("stale");
      table.integer("lastSnapshotAt");
      table.integer("lastChangedAt");
      table.text("errorReason");
      table.index(["snapshotState", "revision"], "idx_project_storage_snapshot");
    });
  }
  await addColumn("o_projectStorage", "lastChangedAt", "integer");
  await knex.raw(`
    INSERT OR IGNORE INTO o_projectStorage
      (projectId, storageKey, revision, snapshotRevision, snapshotState, lastChangedAt)
    SELECT id, CAST(id AS TEXT), 1, 0, 'stale', ${Date.now()} FROM o_project
  `);
  await knex("o_projectStorage").whereNull("lastChangedAt").update({ lastChangedAt: Date.now() });
  const nowMsSql = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
  const snapshotTriggerTablesToDrop = [
    "o_project",
    "o_novel",
    "o_script",
    "o_assets",
    "o_storyboard",
    "o_storyArtifact",
    "o_storyAnnotation",
    "o_storyRevisionMap",
    "o_productionReviewSuggestion",
    "o_productionReviewFeedback",
    "o_textAsset",
    "o_agentWorkData",
    "o_video",
    "o_videoTrack",
    "o_workbenchMergedReference",
    "o_directorAsset",
    "o_editImageTask",
    "o_videoGenerationTask",
    "o_image",
    "o_imageFlow",
    "o_assets2Storyboard",
    "o_scriptAssets",
    "o_assetsRole2Audio",
    "o_eventChapter",
    "o_event",
    "memories",
    "o_tasks",
    "o_taskEvent",
  ];
  for (const table of snapshotTriggerTablesToDrop) {
    for (const operation of ["insert", "update", "delete"] as const) {
      await knex.raw(`DROP TRIGGER IF EXISTS trg_snapshot_${table}_${operation}`);
    }
  }
  const revisionTables = [
    ["o_project", "COALESCE(NEW.id, OLD.id)"],
    ["o_novel", "COALESCE(NEW.projectId, OLD.projectId)"],
    ["o_script", "COALESCE(NEW.projectId, OLD.projectId)"],
    ["o_assets", "COALESCE(NEW.projectId, OLD.projectId)"],
    ["o_storyboard", "COALESCE(NEW.projectId, OLD.projectId)"],
    ["o_storyArtifact", "COALESCE(NEW.projectId, OLD.projectId)"],
    ["o_storyAnnotation", "COALESCE(NEW.projectId, OLD.projectId)"],
    ["o_storyRevisionMap", "COALESCE(NEW.projectId, OLD.projectId)"],
    ["o_productionReviewSuggestion", "COALESCE(NEW.projectId, OLD.projectId)"],
    ["o_productionReviewFeedback", "COALESCE(NEW.projectId, OLD.projectId)"],
    ["o_textAsset", "COALESCE(NEW.projectId, OLD.projectId)"],
    ["o_video", "COALESCE(NEW.projectId, OLD.projectId)"],
    ["o_videoTrack", "COALESCE(NEW.projectId, OLD.projectId)"],
    ["o_workbenchMergedReference", "COALESCE(NEW.projectId, OLD.projectId)"],
    ["o_directorAsset", "COALESCE(NEW.projectId, OLD.projectId)"],
  ] as const;
  for (const [table, projectExpression] of revisionTables) {
    if (!(await knex.schema.hasTable(table))) continue;
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const rowExpression =
        operation === "INSERT"
          ? projectExpression.replace(/OLD\./g, "NEW.")
          : operation === "DELETE"
            ? projectExpression.replace(/NEW\./g, "OLD.")
            : projectExpression;
      await knex.raw(`
        CREATE TRIGGER IF NOT EXISTS trg_snapshot_${table}_${operation.toLowerCase()}
        AFTER ${operation} ON ${table}
        BEGIN
          INSERT OR IGNORE INTO o_projectStorage
            (projectId, storageKey, revision, snapshotRevision, snapshotState)
          VALUES (${rowExpression}, CAST(${rowExpression} AS TEXT), 1, 0, 'stale');
          UPDATE o_projectStorage
          SET revision = revision + 1, snapshotState = 'stale', lastChangedAt = ${nowMsSql}, errorReason = NULL
          WHERE projectId = ${rowExpression};
        END
      `);
    }
  }
  const indirectRevisionSources: Array<{
    table: string;
    projectFor: (alias: "NEW" | "OLD") => string;
    whenFor?: (alias: "NEW" | "OLD") => string;
  }> = [
    {
      table: "o_image",
      projectFor: (alias) =>
        `(SELECT projectId FROM o_assets WHERE id = ${alias}.assetsId OR imageId = ${alias}.id LIMIT 1)`,
    },
    {
      table: "o_imageFlow",
      projectFor: (alias) =>
        `(SELECT projectId FROM (SELECT projectId FROM o_assets WHERE flowId = ${alias}.id UNION ALL SELECT projectId FROM o_storyboard WHERE flowId = ${alias}.id) LIMIT 1)`,
    },
    {
      table: "o_assets2Storyboard",
      projectFor: (alias) => `(SELECT projectId FROM o_storyboard WHERE id = ${alias}.storyboardId LIMIT 1)`,
    },
    {
      table: "o_scriptAssets",
      projectFor: (alias) => `(SELECT projectId FROM o_script WHERE id = ${alias}.scriptId LIMIT 1)`,
    },
    {
      table: "o_assetsRole2Audio",
      projectFor: (alias) => `(SELECT projectId FROM o_assets WHERE id = ${alias}.assetsRoleId LIMIT 1)`,
    },
    {
      table: "o_eventChapter",
      projectFor: (alias) => `(SELECT projectId FROM o_novel WHERE id = ${alias}.novelId LIMIT 1)`,
    },
    {
      table: "o_event",
      projectFor: (alias) =>
        `(SELECT n.projectId FROM o_eventChapter ec JOIN o_novel n ON n.id = ec.novelId WHERE ec.eventId = ${alias}.id LIMIT 1)`,
    },
  ];
  for (const source of indirectRevisionSources) {
    if (!(await knex.schema.hasTable(source.table))) continue;
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const aliases: Array<"NEW" | "OLD"> =
        operation === "INSERT" ? ["NEW"] : operation === "DELETE" ? ["OLD"] : ["NEW", "OLD"];
      const projectExpression =
        aliases.length === 1
          ? source.projectFor(aliases[0])
          : `COALESCE(${source.projectFor("NEW")}, ${source.projectFor("OLD")})`;
      const when = source.whenFor
        ? aliases.map((alias) => `(${source.whenFor?.(alias)})`).join(" OR ")
        : "1 = 1";
      await knex.raw(`
        CREATE TRIGGER IF NOT EXISTS trg_snapshot_${source.table}_${operation.toLowerCase()}
        AFTER ${operation} ON ${source.table}
        WHEN ${when}
        BEGIN
          INSERT OR IGNORE INTO o_projectStorage
            (projectId, storageKey, revision, snapshotRevision, snapshotState)
          VALUES (${projectExpression}, CAST(${projectExpression} AS TEXT), 1, 0, 'stale');
          UPDATE o_projectStorage
          SET revision = revision + 1, snapshotState = 'stale', lastChangedAt = ${nowMsSql}, errorReason = NULL
          WHERE projectId = ${projectExpression};
        END
      `);
    }
  }

  await migrateImageFlowContractV2(knex);
  await migrateStoryboardEditorContractV1(knex);
  await migrateMediaPathContractV1(knex);
  await failInterruptedImageFlowTasks(knex);
  await migrateVideoQueueV2(knex);
  await recoverInterruptedQueuedTasksFromBackup(knex);
  await migrateVideoQueueV3(knex);
  await migrateVideoQueueV4(knex);
  await migrateVideoQueueV5(knex);
  await recoverVideoQueueAfterRestart(knex);
  await migrateUnifiedTaskV1(knex);
  await migrateProjectSnapshotDecoupling(knex);
  await recoverInterruptedEphemeralTasks(knex);
  await knex("o_videoGenerationTask")
    .whereRaw("length(errorReason) > 4096")
    .update({ errorReason: knex.raw("substr(errorReason, 1, 4096)") });
  await knex("o_video").whereRaw("length(errorReason) > 4096").update({
    errorReason: knex.raw("substr(errorReason, 1, 4096)"),
  });
  await knex("o_tasks").whereRaw("length(reason) > 4096").update({
    reason: knex.raw("substr(reason, 1, 4096)"),
  });
  const volcengineVer = getVendorVersion("volcengine");
  if (Number(volcengineVer) < 2.3) {
    writeVendorCode("volcengine", vendorData["volcengine.ts"]);
  }
  const minimaxVer = getVendorVersion("minimax");
  if (Number(minimaxVer) < 2.1) {
    writeVendorCode("minimax", vendorData["minimax.ts"]);
  }
  const t8starVer = getVendorVersion("t8star");
  if (vendorData["t8star.ts"] && Number(t8starVer) < 2.2) {
    writeVendorCode("t8star", vendorData["t8star.ts"]);
  }
  if (vendorData["dreamina.ts"]) {
    writeVendorCode("dreamina", vendorData["dreamina.ts"]);
  }
};

async function tempOnsert(knex: Knex, tsCode: string) {
  const vendor = readVendorFromCode(tsCode);
  if (!vendor?.id) return;
  const data = await knex("o_vendorConfig").where("id", vendor.id).first();
  if (data) return;
  await knex("o_vendorConfig").insert({
    id: vendor.id,
    inputValues: JSON.stringify(vendor.inputValues ?? {}),
    models: JSON.stringify([]),
    enable: vendor.id == "toonflow" ? 1 : 0,
  });
  writeVendorCode(vendor.id, tsCode);
}
