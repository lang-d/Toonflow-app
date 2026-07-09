import { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { getEmbedding } from "@/utils/agent/embedding";

export interface TableSchema {
  name: string;
  builder: (table: Knex.CreateTableBuilder) => void;
  initData?: (knex: Knex) => Promise<void>;
}

export default async (
  knex: Knex,
  forceInit: boolean = false,
  options: { includeTables?: Set<string>; excludeTables?: Set<string> } = {},
): Promise<void> => {
  const tables: TableSchema[] = [
    // 用户表
    {
      name: "o_user",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("name");
        table.text("password");
        table.primary(["id"]);
        table.unique(["id"]);
      },
      initData: async (knex) => {
        await knex("o_user").insert([{ id: 1, name: "admin", password: "admin123" }]);
      },
    },
    //项目表
    {
      name: "o_project",
      builder: (table) => {
        table.integer("id");
        table.string("projectType");
        table.string("imageModel");
        table.string("imageQuality");
        table.string("videoModel");
        table.text("name");
        table.text("intro");
        table.text("type");
        table.text("artStyle");
        table.text("directorManual");
        table.text("mode");
        table.text("videoRatio");
        table.integer("createTime");
        table.integer("userId");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    {
      name: "o_projectStorage",
      builder: (table) => {
        table.integer("projectId").notNullable().primary();
        table.string("storageKey").notNullable().unique();
        table.integer("revision").notNullable().defaultTo(1);
        table.integer("snapshotRevision").notNullable().defaultTo(0);
        table.string("snapshotState").notNullable().defaultTo("stale");
        table.integer("lastSnapshotAt");
        table.integer("lastChangedAt");
        table.text("errorReason");
        table.index(["snapshotState", "revision"], "idx_project_storage_snapshot");
      },
    },
    //风格表
    {
      name: "o_projectMaterial",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("projectId").notNullable();
        table.string("category").notNullable();
        table.text("name").notNullable();
        table.text("filePath").notNullable();
        table.string("mime");
        table.string("ext");
        table.integer("size").notNullable().defaultTo(0);
        table.text("textPath");
        table.integer("textSize");
        table.text("summary");
        table.string("state").notNullable().defaultTo("ready");
        table.integer("createTime").notNullable();
        table.integer("updateTime").notNullable();
        table.primary(["id"]);
        table.unique(["id"]);
        table.index(["projectId", "category", "state"], "idx_project_material_scope");
      },
    },
    {
      name: "o_artStyle",
      builder: (table) => {
        table.integer("id").notNullable();
        table.string("name");
        table.text("fileUrl");
        table.text("label");
        table.text("prompt");
        table.primary(["id"]);
        table.unique(["id"]);
      },
      initData: async (knex) => {},
    },
    //Agent配置表
    {
      name: "o_agentDeploy",
      builder: (table) => {
        table.integer("id").notNullable();
        table.string("model");
        table.string("key");
        table.string("modelName");
        table.text("vendorId");
        table.string("desc");
        table.string("name");
        table.integer("temperature");
        table.integer("maxOutputTokens");
        table.boolean("disabled").defaultTo(false);
        table.primary(["id"]);
        table.unique(["id"]);
      },
      initData: async (knex) => {
        await knex("o_agentDeploy").insert([
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "scriptAgent",
            name: "剧本Agent",
            desc: "用于读取原文生成故事骨架、改编策略，建议使用具备强大文本理解和生成能力的模型",
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "productionAgent",
            name: "生产Agent",
            desc: "对工作流进行调度和管理，建议使用具备较强的逻辑推理和任务管理能力的模型",
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "musicProductionAgent",
            name: "配乐生产Agent",
            desc: "独立配乐生产阶段，用于音乐创作讨论和配乐任务调度",
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "universalAi",
            name: "通用AI",
            desc: "用于小说事件提取、资产提示词生成、台词提取等边缘功能，建议使用具备较强文本处理能力的模型",
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "ttsDubbing",
            name: "TTS配音",
            desc: "根据剧本内容生成角色配音，支持多种声音风格和情绪",
            disabled: true,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "scriptAgent:decisionAgent",
            name: "剧本Agent:决策层",
            desc: "决策层",
            temperature: 1,
            maxOutputTokens: 0,
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "scriptAgent:supervisionAgent",
            name: "剧本Agent:监督层",
            desc: "监督层",
            temperature: 1,
            maxOutputTokens: 0,
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "scriptAgent:storySkeletonAgent",
            name: "剧本Agent:故事骨架",
            desc: "故事骨架生成",
            temperature: 1,
            maxOutputTokens: 0,
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "scriptAgent:adaptationStrategyAgent",
            name: "剧本Agent:改编策略",
            desc: "改编策略生成",
            temperature: 1,
            maxOutputTokens: 0,
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "scriptAgent:scriptAgent",
            name: "剧本Agent:剧本生成",
            desc: "剧本生成",
            temperature: 1,
            maxOutputTokens: 0,
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "productionAgent:decisionAgent",
            name: "生产Agent:决策层",
            desc: "决策层",
            temperature: 1,
            maxOutputTokens: 0,
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "musicProductionAgent:decisionAgent",
            name: "配乐生产Agent:决策层",
            desc: "配乐创作讨论和任务调度",
            temperature: 1,
            maxOutputTokens: 0,
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "productionAgent:supervisionAgent",
            name: "生产Agent:监督层",
            desc: "监督层",
            temperature: 1,
            maxOutputTokens: 0,
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "productionAgent:deriveAssetsAgent",
            name: "生产Agent:衍生资产",
            desc: "衍生资产",
            temperature: 1,
            maxOutputTokens: 0,
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "productionAgent:generateAssetsAgent",
            name: "生产Agent:生成资产",
            desc: "生成资产",
            temperature: 1,
            maxOutputTokens: 0,
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "productionAgent:directorPlanAgent",
            name: "生产Agent:导演规划",
            desc: "导演规划",
            temperature: 1,
            maxOutputTokens: 0,
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "productionAgent:storyboardGenAgent",
            name: "生产Agent:分镜生成",
            desc: "分镜生成",
            temperature: 1,
            maxOutputTokens: 0,
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "productionAgent:storyboardPanelAgent",
            name: "生产Agent:分镜面板",
            desc: "分镜面板生成",
            temperature: 1,
            maxOutputTokens: 0,
            disabled: false,
          },
          {
            model: "",
            modelName: "",
            vendorId: null,
            key: "productionAgent:storyboardTableAgent",
            name: "生产Agent:分镜表格",
            desc: "分镜表格生成",
            temperature: 1,
            maxOutputTokens: 0,
            disabled: false,
          },
        ]);
      },
    },
    //设置表
    {
      name: "o_setting",
      builder: (table) => {
        table.text("key");
        table.text("value");
        table.primary(["key"]);
        table.unique(["key"]);
      },
      initData: async (knex) => {
        await knex("o_setting").insert([
          {
            key: "tokenKey",
            value: uuid().slice(0, 8),
          },
          {
            key: "messagesPerSummary",
            value: 10,
          },
          {
            key: "shortTermLimit",
            value: 5,
          },
          {
            key: "summaryMaxLength",
            value: 500,
          },
          {
            key: "summaryLimit",
            value: 10,
          },
          {
            key: "ragLimit",
            value: 3,
          },
          {
            key: "deepRetrieveSummaryLimit",
            value: 5,
          },
          {
            key: "modelOnnxFile",
            value: '["all-MiniLM-L6-v2", "onnx", "model_fp16.onnx"]',
          },
          {
            key: "modelDtype",
            value: "fp16",
          },
          {
            key: "switchAiDevTool",
            value: "0",
          },
        ]);
      },
    },
    //任务中心表
    {
      name: "o_tasks",
      builder: (table) => {
        table.integer("id").notNullable();
        table.string("taskId");
        table.integer("projectId");
        table.integer("scriptId");
        table.string("taskClass");
        table.string("taskType");
        table.string("status");
        table.string("phase");
        table.float("progress");
        table.string("targetType");
        table.string("targetId");
        table.string("nodeId");
        table.string("businessType");
        table.integer("businessId");
        table.string("handler");
        table.text("payloadJson");
        table.text("resultJson");
        table.integer("priority").defaultTo(0);
        table.integer("availableAt");
        table.string("leaseOwner");
        table.integer("leaseExpiresAt");
        table.integer("attempt").defaultTo(0);
        table.integer("maxAttempts").defaultTo(1);
        table.integer("version").defaultTo(1);
        table.string("providerTaskId");
        table.integer("providerSubmittedAt");
        table.string("idempotencyKey");
        table.string("relatedObjects");
        table.string("model");
        table.text("describe");
        table.string("state");
        table.integer("episode");
        table.integer("startTime");
        table.integer("createdAt");
        table.integer("updateTime");
        table.integer("finishTime");
        table.text("reason");
        table.primary(["id"]);
        table.unique(["id"]);
        table.unique(["taskId"]);
        table.index(["projectId", "status", "updateTime"], "idx_tasks_project_status");
        table.index(["taskType", "status", "updateTime"], "idx_tasks_type_status");
        table.index(["status", "availableAt", "priority"], "idx_tasks_dispatch");
        table.index(["leaseOwner", "leaseExpiresAt"], "idx_tasks_lease");
        table.index(["businessType", "businessId"], "idx_tasks_business");
      },
      initData: async (knex) => {},
    },
    {
      name: "o_taskEvent",
      builder: (table) => {
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
        table.index(["taskId", "version"], "idx_task_event_task_version");
        table.index(["projectId", "scriptId", "id"], "idx_task_event_scope");
        table.index(["createdAt"], "idx_task_event_created");
      },
    },
    //提示词表
    {
      name: "o_prompt",
      builder: (table) => {
        table.integer("id").notNullable();
        table.string("name");
        table.string("type");
        table.text("data");
        table.text("useData");
        table.primary(["id"]);
        table.unique(["id"]);
      },
      initData: async (knex) => {
        await knex("o_prompt").insert([
          {
            name: "事件提取",
            type: "eventExtraction",
            data: `# 事件提取指令\n\n你是小说文本分析助手。用户每次提供一个章节的原文，你提取该章的结构化事件信息。\n\n## ⚠️ 输出约束（最高优先级，违反任何一条即为失败）\n\n1. 你的**完整回复**只有一行，以 \`|\` 开头、以 \`|\` 结尾，恰好 7 个字段\n2. 回复的**第一个字符**必须是 \`|\`，**最后一个字符**必须是 \`|\`\n3. \`|\` 之前不许有任何字符——没有引导语、没有解释、没有"根据……"、没有"以下是……"\n4. \`|\` 之后不许有任何字符——没有总结、没有提取说明、没有改编建议\n5. 不输出表头行、分隔线、Markdown 标题、emoji、代码块标记\n\n## 输出格式\n\n\`\`\`\n| 第X章 {章节标题} | {涉及角色} | {核心事件} | {主线关系} | {信息密度} | {预估集长} | {情绪强度} |\n\`\`\`\n\n### 字段规范\n\n| 字段 | 格式要求 | 示例 |\n|------|----------|------|\n| 章节 | \`第X章 {章节标题}\` | \`第1章 职业危机与许愿\` |\n| 涉及角色 | 有实际戏份的角色，顿号分隔 | \`林逸、白有容\` |\n| 核心事件 | 30-60字，必须含动作+结果 | \`林逸因解密风潮事业崩塌，颓废中许愿触发魔法系统绑定\` |\n| 主线关系 | **必须**为 \`强/中/弱（3-8字理由）\` | \`强（动机建立+系统激活）\` |\n| 信息密度 | \`高\` / \`中\` / \`低\` | \`高\` |\n| 预估集长 | **必须**为 \`X秒\`，禁止用分钟 | \`50秒\` |\n| 情绪强度 | 文字标签，\`+\` 连接，禁止星级/数字 | \`转折+悬疑\` |\n\n**主线关系判定**：强＝直接推动主角弧线；中＝补充世界观/人物关系/伏笔；弱＝过渡/气氛。\n\n**预估集长参考**：高密度+高情绪→45-60秒；中→35-45秒；低→25-35秒。\n\n**可用情绪标签**：\`冲突\`、\`恐怖\`、\`情感\`、\`转折\`、\`高潮\`、\`平铺\`、\`喜剧\`、\`悬疑\`、\`情感崩溃\`。\n\n## 输出示例\n\n以下两个示例展示的是**完整回复**——除这一行外没有任何其他内容：\n\n\`\`\`\n| 第1章 职业危机与许愿 | 林逸 | 职业魔术师林逸因解密打假风潮导致事业崩塌，颓废中感慨"如果会魔法就好了"，意外触发神奇魔法系统绑定 | 强（主角动机建立+系统激活） | 高 | 50秒 | 转折+悬疑 |\n\`\`\`\n\`\`\`\n| 第12章 山间小憩 | 凌玄、苏晚卿 | 凌玄与苏晚卿在山间歇脚，苏晚卿回忆幼时往事，两人关系略有缓和但未实质推进 | 弱（气氛过渡） | 低 | 25秒 | 平铺+情感 |\n\`\`\`\n\n## 提取规则\n\n- 忠于原文，不推测、不脑补、不加入原文未出现的情节\n- 角色使用文中主要称呼，保持一致\n- 多条平行事件线时，选对主角影响最大的一条，其余简要带过\n- 对话密集章节，关注对话推动了什么结果，而非复述对话内容`,
          },
          {
            name: "剧本资产提取",
            type: "scriptAssetExtraction",
            data: `---\nname: universal_agent\ndescription: 专注于从剧本内容中提取所使用的资产（角色、场景、道具）并生成结构化资产列表的助手。\n---\n\n# Script Assets Extract\n\n你是一个专业的剧本内容分析助手，专注于从剧本文本中识别和提取所有涉及的资产（角色、场景、道具），并为每项资产生成可供下游制作流程使用的结构化描述和提示词。\n\n## 何时使用\n\n用户提供剧本内容，你需要逐段阅读并提取其中涉及的所有资产（人物角色、场景地点、道具物件），输出为结构化的资产列表。产出的资产描述将用于后续 AI 图片生成和制作流程。\n\n## 与系统的对应关系\n\n- 资产类型：\n  - \`role\` — 角色（对应 \`o_assets.type = "role"\`）\n  - \`scene\` — 场景（对应 \`o_assets.type = "scene"\`）\n  - \`tool\` — 道具（对应 \`o_assets.type = "tool"\`）\n- 下游用途：资产提示词生成 → AI 资产图生成 → 分镜制作\n\n## 输出要求\n\n**必须通过调用 \`resultTool\` 工具返回结果**，禁止以纯文本、Markdown 表格或 JSON 代码块等形式直接输出资产列表。\n\`resultTool\` 的 schema 会对字段类型和枚举值做强校验，调用时请严格按照下方字段定义填写，确保数据结构正确、字段完整、类型匹配。\n\n每个资产对象包含以下字段：\n\n| 字段 | 类型 | 必填 | 说明 |\n| ---- | ---- | ---- | ---- |\n| \`name\` | string | 是 | 资产名称，使用剧本中的原始称呼,不做其他多余描述 |\n| \`desc\` | string | 是 | 资产描述，30-80 字的视觉化描述 |\n| \`prompt\` | string | 是 | 生成提示词，英文，用于 AI 图片生成 |\n| \`type\` | enum | 是 | 资产类型：\`role\` / \`scene\` / \`tool\`  |\n\n## 提取规则\n\n### 角色（role）\n\n- 提取剧本中出现的所有有名字的角色\n- \`desc\`：包含外貌特征、服饰风格、体态气质等视觉要素\n- \`prompt\`：英文提示词，描述角色的外观特征，适用于 AI 角色图生成\n- 同一角色有多个称呼时，取最常用的作为 \`name\`\n- 无名龙套（如"路人甲"、"士兵"）可跳过，除非其造型对剧情有重要视觉意义\n\n### 场景（scene）\n\n- 提取剧本中出现的所有场景/地点\n- \`desc\`：包含空间结构、光照氛围、关键陈设、色调基调等视觉要素\n- \`prompt\`：英文提示词，描述场景的整体视觉风格，适用于 AI 场景图生成\n- 同一场景的不同状态（如白天/夜晚）不重复提取，在 \`desc\` 中注明即可\n\n### 道具（tool）\n\n- 提取剧本中出现的重要道具/物品\n- \`desc\`：包含外观形状、颜色材质、尺寸参考、特殊效果等视觉要素\n- \`prompt\`：英文提示词，描述道具的外观细节，适用于 AI 道具图生成\n- 仅提取有独立视觉意义或剧情功能的道具，通用物品可跳过\n\n\n## 提示词（prompt）生成规范\n\n- 采用逗号分隔的关键词/短语格式\n- 优先描述**视觉特征**，避免抽象概念\n- 包含风格关键词（如 anime style, manga style 等，根据项目风格决定）\n- 角色 prompt 示例：\`a young man, sharp eyebrows, black hair, pale skin, wearing a gray Taoist robe, slender build, cold expression\`\n- 场景 prompt 示例：\`dark cave interior, glowing crystals on walls, misty atmosphere, dim blue lighting, stone altar in center\`\n- 道具 prompt 示例：\`ancient jade pendant, oval shape, translucent green, carved dragon pattern, glowing faintly\`\n\n## 提取流程\n\n1. 通读剧本全文，识别所有出现的角色、场景、道具\n2. 对每个资产生成结构化的 \`name\`、\`desc\`、\`prompt\`、\`type\`\n3. 去重：同一资产不重复提取\n4. **必须通过调用 \`resultTool\` 工具输出完整资产列表**，不要分多次调用，一次性将所有资产放入 \`assetsList\` 数组中提交\n\n## 提取原则\n\n1. **忠于剧本**：所有提取基于剧本中的实际内容，不臆造未出现的资产\n2. **视觉优先**：描述和提示词聚焦视觉特征，便于 AI 图片生成\n3. **精简实用**：只提取对制作有实际意义的资产，避免过度提取\n4. **分类准确**：严格按照 role/scene/tool 分类，不混淆\n5. **提示词质量**：英文提示词应具体、可执行，能直接用于 AI 图片生成\n\n## 注意事项\n\n- 资产列表中**不要包含剧本内容本身**，仅提取所使用到的资产\n- 角色的随身物品如果有独立剧情功能，应单独作为道具提取\n- 场景中的固定陈设不需要单独提取为道具，除非该物件有独立剧情作用`,
          },
          {
            name: "视频提示词生成",
            type: "videoPromptGeneration",
            data: [
              "# Video Prompt Generation Skill",
              "",
              "The backend provides structured <trackStoryboard ...> facts and visual references.",
              "Read only structured attributes: duration, location, timeOfDay, scene, picture, action, shotSize, cameraMove, dialogue, sound, visibleEmotion, groupKey, groupName, groupIntent, beatId, characters, requiredAssets.",
              "Do not parse or infer business facts from videoDesc, Markdown, XML text, image prompts, chat text, or any other prose.",
              "Generate the target model video prompt only. Dialogue, voice tone and diegetic sound effects must come from structured fields; BGM, score and OST are not valid video prompt content.",
            ].join("\\n"),
          },
          {
            name: "音色绑定",
            type: "audioBindPrompt",
            data: `你是一个音色匹配助手。\n你的任务是：根据给定角色资产的名称与描述，从候选音频列表中选出最合适的音色。\n匹配规则：\n1. 优先根据角色性别、年龄、性格等特征与音色描述进行语义匹配；\n2. 同一角色仅可匹配一个音色；\n3. 若候选列表中没有合适的音色，则无需返回 audioId；`,
          },
        ]);
      },
    },
    //模型绑定提示词表
    {
      name: "o_modelPrompt",
      builder: (table) => {
        table.integer("id").notNullable();
        table.string("vendorId");
        table.string("model");
        table.text("fileName");
        table.text("path");
        table.primary(["id"]);
        table.unique(["id"]);
      },
      initData: async (knex) => {},
    },
    //小说原文表
    {
      name: "o_novel",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("chapterIndex");
        table.text("reel");
        table.text("chapter");
        table.text("chapterData");
        table.integer("projectId");
        table.integer("eventState");
        table.text("event");
        table.text("errorReason");
        table.integer("createTime");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    //小说事件表
    {
      name: "o_event",
      builder: (table) => {
        table.integer("id").notNullable();
        table.string("name");
        table.string("detail");
        table.integer("createTime");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    //事件-章节表
    {
      name: "o_eventChapter",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("eventId").unsigned().references("id").inTable("o_event");
        table.integer("novelId").unsigned().references("id").inTable("o_novel");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    //剧本
    {
      name: "o_script",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("name");
        table.text("content");
        table.integer("projectId");
        table.integer("extractState");
        table.integer("createTime");
        table.text("errorReason");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    //资产表
    {
      name: "o_assets",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("name");
        table.text("prompt");
        table.text("remark");
        table.text("type");
        table.text("describe");
        table.text("foundationText");
        table.string("foundationStatus");
        table.text("foundationErrorReason");
        table.integer("scriptId"); //剧本id
        table.integer("imageId").unsigned().references("id").inTable("o_image");
        table.integer("assetsId");
        table.integer("projectId");
        table.integer("flowId"); //工作流id
        table.integer("startTime");
        table.string("promptState");
        table.integer("audioBindState");
        table.text("promptErrorReason");
        table.primary(["id"]);
        table.unique(["id"]);
      },
      initData: async (knex) => {},
    },
    //生成图片表
    {
      name: "o_image",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("filePath");
        table.text("type");
        table.integer("assetsId");
        table.text("model");
        table.text("resolution");
        table.text("state");
        table.text("errorReason");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    //分镜
    {
      name: "o_storyboard",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("scriptId");
        table.text("prompt");
        table.text("filePath");
        table.text("duration");
        table.text("state");
        table.integer("trackId");
        table.text("reason");
        table.text("track");
        table.text("videoDesc");
        table.text("location");
        table.text("timeOfDay");
        table.text("sceneContinuityId");
        table.text("tableRowJson");
        table.string("factStatus").notNullable().defaultTo("legacy");
        table.integer("factVersion").notNullable().defaultTo(1);
        table.integer("factRevision").notNullable().defaultTo(1);
        table.integer("shouldGenerateImage"); // 0 否  1 是
        table.integer("projectId");
        table.integer("flowId"); //工作流id
        table.integer("index");
        table.integer("createTime");
        table.text("referenceImages").notNullable().defaultTo("[]");
        table.primary(["id"]);
        table.unique(["id"]);
        table.index(["projectId", "scriptId", "index"], "idx_storyboard_project_script_index");
        table.index(["trackId"], "idx_storyboard_track_id");
      },
    },
    {
      name: "o_storyboardGeneration",
      builder: (table) => {
        table.integer("id").primary();
        table.string("generationId").notNullable().unique();
        table.integer("projectId").notNullable();
        table.integer("scriptId").notNullable();
        table.integer("expectedRowCount").notNullable();
        table.text("groupPlanJson").notNullable();
        table.string("state").notNullable();
        table.integer("revision");
        table.text("errorJson");
        table.integer("createdAt").notNullable();
        table.integer("updatedAt").notNullable();
        table.index(["projectId", "scriptId", "state"], "idx_storyboard_generation_owner_state");
        table.index(["updatedAt"], "idx_storyboard_generation_updated");
      },
    },
    {
      name: "o_storyboardGenerationRow",
      builder: (table) => {
        table.integer("id").primary();
        table.string("generationId").notNullable();
        table.integer("rowIndex").notNullable();
        table.text("rowJson").notNullable();
        table.string("rowHash").notNullable();
        table.integer("createdAt").notNullable();
        table.integer("updatedAt").notNullable();
        table.unique(["generationId", "rowIndex"], {
          indexName: "uq_storyboard_generation_row",
        });
        table.index(["generationId"], "idx_storyboard_generation_row_generation");
      },
    },
    {
      name: "o_directorPlanGeneration",
      builder: (table) => {
        table.integer("id").primary();
        table.string("generationId").notNullable().unique();
        table.integer("projectId").notNullable();
        table.integer("scriptId").notNullable();
        table.integer("expectedSectionCount").notNullable();
        table.string("state").notNullable();
        table.integer("textAssetId");
        table.integer("version");
        table.string("contentHash");
        table.text("errorJson");
        table.integer("createdAt").notNullable();
        table.integer("updatedAt").notNullable();
        table.index(["projectId", "scriptId", "state"], "idx_director_plan_generation_scope");
        table.index(["updatedAt"], "idx_director_plan_generation_updated");
      },
    },
    {
      name: "o_directorPlanGenerationChunk",
      builder: (table) => {
        table.integer("id").primary();
        table.string("generationId").notNullable();
        table.string("sectionKey").notNullable();
        table.integer("chunkIndex").notNullable();
        table.text("content").notNullable();
        table.string("contentHash").notNullable();
        table.integer("createdAt").notNullable();
        table.integer("updatedAt").notNullable();
        table.unique(["generationId", "sectionKey", "chunkIndex"], {
          indexName: "uq_director_plan_generation_chunk",
        });
        table.index(["generationId", "sectionKey", "chunkIndex"], "idx_director_plan_generation_chunk_order");
      },
    },
    //flowData-剧本
    {
      name: "o_agentRun",
      builder: (table) => {
        table.integer("id").primary();
        table.string("runId").notNullable().unique();
        table.string("agentKey").notNullable();
        table.integer("projectId").notNullable();
        table.integer("scriptId").notNullable();
        table.string("isolationKey").notNullable();
        table.string("messageId");
        table.string("status").notNullable();
        table.string("currentStage");
        table.string("currentSubAgent");
        table.text("reason");
        table.text("errorJson");
        table.text("resultJson");
        table.integer("heartbeatAt").notNullable();
        table.integer("startedAt").notNullable();
        table.integer("finishedAt");
        table.integer("createdAt").notNullable();
        table.integer("updatedAt").notNullable();
        table.index(["agentKey", "projectId", "scriptId", "status"], "idx_agent_run_scope_status");
        table.index(["runId"], "idx_agent_run_run_id");
        table.index(["status", "heartbeatAt"], "idx_agent_run_heartbeat");
      },
    },
    {
      name: "o_agentRunEvent",
      builder: (table) => {
        table.integer("id").primary();
        table.string("runId").notNullable();
        table.string("eventType").notNullable();
        table.text("payloadJson");
        table.integer("createdAt").notNullable();
        table.index(["runId", "id"], "idx_agent_run_event_run_id");
      },
    },
    {
      name: "o_agentWorkData",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("projectId");
        table.integer("episodesId");
        table.string("key"); //用户其他方式索引
        table.string("data");
        table.integer("createTime");
        table.integer("updateTime");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    //视频
    {
      name: "o_video",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("filePath");
        table.text("errorReason");
        table.integer("time");
        table.text("state");
        table.integer("scriptId");
        table.integer("projectId");
        table.integer("videoTrackId");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    {
      name: "o_videoGenerationTask",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("videoId");
        table.integer("projectId");
        table.integer("scriptId");
        table.text("model");
        table.string("vendorId");
        table.integer("taskCenterId");
        table.integer("payloadVersion");
        table.text("requestJson");
        table.string("submitId");
        table.string("officialTaskId");
        table.string("historyRecordId");
        table.string("providerAccountId");
        table.string("providerModelKey");
        table.integer("providerSubmittedAt");
        table.string("phase");
        table.string("status");
        table.string("state");
        table.text("errorReason");
        table.text("rawOutput");
        table.integer("nextPollTime");
        table.integer("nextSubmitTime");
        table.integer("pollCount");
        table.integer("submitAttemptCount");
        table.integer("capacityWaitStartedAt");
        table.integer("confirmStartedAt");
        table.integer("confirmDeadline");
        table.integer("remoteConfirmedAt");
        table.string("lastProviderStatus");
        table.string("lastProviderCode");
        table.integer("providerQueueStatus");
        table.integer("providerQueueIndex");
        table.integer("providerQueueLength");
        table.integer("startTime");
        table.integer("updateTime");
        table.integer("finishTime");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    {
      name: "o_videoProviderCapacity",
      builder: (table) => {
        table.integer("id").primary();
        table.string("vendorId").notNullable();
        table.string("providerAccountId").notNullable().defaultTo("default");
        table.string("providerModelKey").notNullable();
        table.integer("capacityBlocked").notNullable().defaultTo(0);
        table.integer("blockedUntil");
        table.string("lastProviderCode");
        table.integer("createTime").notNullable();
        table.integer("updateTime").notNullable();
        table.unique(["vendorId", "providerAccountId", "providerModelKey"], {
          indexName: "uq_video_provider_capacity",
        });
        table.index(["providerModelKey", "blockedUntil"], "idx_video_provider_capacity_schedule");
      },
    },
    // 视频轨道
    {
      name: "o_videoTrack",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("videoId");
        table.integer("projectId");
        table.integer("scriptId");
        table.text("state");
        table.text("reason");
        table.text("prompt");
        table.integer("selectVideoId");
        table.integer("duration");
        table.text("groupPlanJson");
        table.integer("archived").notNullable().defaultTo(0);
        table.primary(["id"]);
        table.unique(["id"]);
        table.index(["projectId", "scriptId", "archived"], "idx_video_track_owner_archived");
      },
    },
    {
      name: "o_musicBible",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("projectId").notNullable();
        table.integer("version").notNullable();
        table.text("title");
        table.text("content").notNullable();
        table.text("styleProfileJson").notNullable().defaultTo("{}");
        table.text("sourceSummaryJson").notNullable().defaultTo("{}");
        table.string("state").notNullable().defaultTo("complete");
        table.integer("createTime").notNullable();
        table.integer("updateTime").notNullable();
        table.primary(["id"]);
        table.unique(["id"]);
        table.unique(["projectId", "version"], { indexName: "uq_music_bible_version" });
        table.index(["projectId", "state"], "idx_music_bible_project_state");
      },
    },
    {
      name: "o_musicPlan",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("projectId").notNullable();
        table.integer("scriptId");
        table.string("mode").notNullable();
        table.integer("bibleId").notNullable();
        table.integer("bibleVersion").notNullable();
        table.integer("version").notNullable();
        table.text("content").notNullable();
        table.text("cueSheetJson").notNullable().defaultTo("[]");
        table.string("state").notNullable().defaultTo("complete");
        table.integer("createTime").notNullable();
        table.integer("updateTime").notNullable();
        table.primary(["id"]);
        table.unique(["id"]);
        table.index(["projectId", "scriptId", "mode", "version"], "idx_music_plan_scope");
        table.index(["bibleId"], "idx_music_plan_bible");
      },
    },
    {
      name: "o_musicCue",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("projectId").notNullable();
        table.integer("scriptId");
        table.integer("planId").notNullable();
        table.integer("planVersion").notNullable();
        table.string("cueKey").notNullable();
        table.string("cueType").notNullable();
        table.text("title");
        table.text("narrativePurpose");
        table.text("startRefJson").notNullable().defaultTo("{}");
        table.text("endRefJson").notNullable().defaultTo("{}");
        table.integer("durationSec");
        table.text("promptBrief");
        table.text("musicSpecJson").notNullable().defaultTo("{}");
        table.string("state").notNullable().defaultTo("ready");
        table.integer("createTime").notNullable();
        table.integer("updateTime").notNullable();
        table.primary(["id"]);
        table.unique(["id"]);
        table.unique(["planId", "cueKey"], { indexName: "uq_music_cue_plan_key" });
        table.index(["projectId", "scriptId"], "idx_music_cue_scope");
        table.index(["planId"], "idx_music_cue_plan");
      },
    },
    {
      name: "o_musicCueAsset",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("projectId").notNullable();
        table.integer("cueId").notNullable();
        table.integer("version").notNullable();
        table.integer("assetsId");
        table.integer("childAssetId");
        table.text("prompt");
        table.text("compiledPromptJson").notNullable().defaultTo("{}");
        table.text("model");
        table.string("state").notNullable().defaultTo("complete");
        table.text("errorReason");
        table.integer("selected").notNullable().defaultTo(0);
        table.integer("createTime").notNullable();
        table.integer("updateTime").notNullable();
        table.primary(["id"]);
        table.unique(["id"]);
        table.unique(["cueId", "version"], { indexName: "uq_music_cue_asset_version" });
        table.index(["projectId", "cueId"], "idx_music_cue_asset_scope");
        table.index(["cueId", "selected"], "idx_music_cue_asset_selected");
      },
    },
    {
      name: "o_workbenchMergedReference",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("projectId").notNullable();
        table.integer("scriptId").notNullable();
        table.integer("trackId").notNullable();
        table.string("mergeType").notNullable();
        table.text("name");
        table.text("filePath").notNullable();
        table.string("fileType").notNullable();
        table.text("prompt");
        table.text("sourceRefs").notNullable();
        table.integer("position").notNullable();
        table.string("state").notNullable();
        table.integer("createTime").notNullable();
        table.integer("updateTime").notNullable();
        table.primary(["id"]);
        table.unique(["id"]);
        table.index(["projectId", "scriptId", "trackId"], "idx_merged_reference_owner");
        table.index(["trackId", "state"], "idx_merged_reference_track_state");
      },
    },
    //供应商配置表
    {
      name: "o_directorAsset",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("projectId").notNullable();
        table.integer("scriptId");
        table.integer("flowId");
        table.string("nodeId").notNullable();
        table.string("targetType");
        table.integer("targetId");
        table.integer("assetId").notNullable();
        table.integer("imageId").notNullable();
        table.string("assetType").notNullable();
        table.text("name").notNullable();
        table.text("promptFragment");
        table.text("sourceRefs").notNullable();
        table.text("camera");
        table.text("stageDraft");
        table.integer("createTime").notNullable();
        table.integer("updateTime").notNullable();
        table.primary(["id"]);
        table.unique(["id"]);
        table.index(["projectId", "scriptId"], "idx_director_asset_project_script");
        table.index(["assetId"], "idx_director_asset_asset");
        table.index(["flowId", "nodeId"], "idx_director_asset_flow_node");
        table.index(["targetType", "targetId"], "idx_director_asset_target");
        table.index(["assetType"], "idx_director_asset_type");
      },
    },
    {
      name: "o_vendorConfig",
      builder: (table) => {
        table.string("id").notNullable();
        table.text("inputValues"); // 输入项值 JSON
        table.text("models"); // 模型配置 JSON
        table.integer("enable"); //是否启用供应商
        table.primary(["id"]);
        table.unique(["id"]);
      },
      initData: async (knex) => {
        await knex("o_vendorConfig").insert([
          {
            id: "toonflow",
            inputValues: "{}",
            models: "[]",
            enable: 0,
          },
          {
            id: "deepseek",
            inputValues: "{}",
            models: "[]",
            enable: 0,
          },
          {
            id: "atlascloud",
            inputValues: "{}",
            models: "[]",
            enable: 0,
          },
          {
            id: "dreamina",
            inputValues: "{}",
            models: "[]",
            enable: 0,
          },
          {
            id: "volcengine",
            inputValues: "{}",
            models: "[]",
            enable: 0,
          },
          {
            id: "minimax",
            inputValues: "{}",
            models: "[]",
            enable: 0,
          },
          {
            id: "openai",
            inputValues: "{}",
            models: "[]",
            enable: 0,
          },
          {
            id: "klingai",
            inputValues: "{}",
            models: "[]",
            enable: 0,
          },
          {
            id: "vidu",
            inputValues: "{}",
            models: "[]",
            enable: 0,
          },
        ]);
      },
    },
    //图片工作流表
    {
      name: "o_imageFlow",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("flowData").notNullable();
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    {
      name: "o_assets2Storyboard",
      builder: (table) => {
        table.integer("storyboardId").notNullable();
        table.integer("assetId").notNullable();
        table.primary(["storyboardId", "assetId"]);
        table.unique(["storyboardId", "assetId"]);
      },
    },
    {
      name: "o_scriptAssets",
      builder: (table) => {
        table.integer("scriptId").notNullable();
        table.integer("assetId").notNullable();
        table.primary(["scriptId", "assetId"]);
        table.unique(["scriptId", "assetId"]);
      },
    },
    {
      // Legacy skill metadata retained for database compatibility. Runtime loading uses skillResolver and stage registries.
      name: "o_skillList",
      builder: (table) => {
        table.text("id").notNullable();
        table.text("md5").notNullable();
        table.text("path").notNullable();
        table.text("name").notNullable(); //文件名
        table.text("description").notNullable(); //描述
        table.text("embedding"); // 向量嵌入 JSON
        table.text("type").notNullable(); // "main" | "references"
        table.integer("createTime").notNullable();
        table.integer("updateTime").notNullable();
        table.integer("state").notNullable(); // 1正常，0正在生成description，-1description为空。-2归属为空,-3md5变动，-4文件不存在
        table.primary(["id"]);
      },
      initData: async (knex) => {
        const list = [
          {
            id: "4fb36012e56e395b425569987f5dab0e",
            md5: "fca3c269c5f325a65dafa663c9bb9773",
            path: "production_agent_decision.md",
            name: "production_agent_decision",
            description: "",
            embedding: "",
            type: "main",
            createTime: 1774447310118,
            updateTime: 1774447310118,
            state: -1,
          },
          {
            id: "017b6338d7aa227cd614ec1fb25fd83e",
            md5: "2610b80abe4bd048fe61c73adc7388ac",
            path: "production_agent_execution.md",
            name: "production_agent_execution",
            description: "",
            embedding: "",
            type: "main",
            createTime: 1774447310118,
            updateTime: 1774447310118,
            state: -1,
          },
          {
            id: "f03c8e67b61580de9ea5b9d166521b67",
            md5: "d41d8cd98f00b204e9800998ecf8427e",
            path: "production_agent_supervision.md",
            name: "production_agent_supervision",
            description: "",
            embedding: "",
            type: "main",
            createTime: 1774447310118,
            updateTime: 1774447310118,
            state: -1,
          },
          {
            id: "50b49d8af5d364665b463c23f6a4d8bb",
            md5: "fbba66e0df2426996277b299710c3033",
            path: "script_agent_decision.md",
            name: "script_agent_decision",
            description: "",
            embedding: "",
            type: "main",
            createTime: 1774447310118,
            updateTime: 1774447310118,
            state: -1,
          },
          {
            id: "427727727e1095c54b6840cd21382d82",
            md5: "7e5911242af7233854d533278c6a8ccb",
            path: "script_agent_execution.md",
            name: "script_agent_execution",
            description: "",
            embedding: "",
            type: "main",
            createTime: 1774447310118,
            updateTime: 1774447310118,
            state: -1,
          },
          {
            id: "02848fb0dd582fd926502c77ecf9679c",
            md5: "7a8b6a311b015cd47bf17cc52b935348",
            path: "script_agent_supervision.md",
            name: "script_agent_supervision",
            description: "",
            embedding: "",
            type: "main",
            createTime: 1774447310118,
            updateTime: 1774447310118,
            state: -1,
          },
          {
            id: "a1e818cc03a0b355b239ac1fb0512969",
            md5: "1fd22029e8047aa30b0dfd703cb837ed",
            path: "universal_agent.md",
            name: "universal_agent",
            description: "",
            embedding: "",
            type: "main",
            createTime: 1774447310118,
            updateTime: 1774447310118,
            state: -1,
          },
          {
            id: "3e5efec258c8d8e6a39bcef12f8ee058",
            md5: "efccb0464cfd472861b49ebf737d4820",
            path: "references/event_extract.md",
            name: "event_extract",
            description:
              "专为小说改编短剧设计的文本分析助手，逐章提取涉及角色、核心事件、主线关系、信息密度、预估集长及情绪强度等结构化信息，以Markdown表格形式输出，并附汇总统计，辅助短剧制作的内容规划与时长估算。",
            embedding: "",
            type: "references",
            createTime: 1774447310118,
            updateTime: 1774450165911,
            state: 1,
          },
          {
            id: "52c51fa8655f899a1b7aae9b6aad7251",
            md5: "783678aaab829b34e7c30a414c356bf6",
            path: "references/novel_character_extract.md",
            name: "novel_character_extract",
            description:
              "专为小说内容分析设计的角色提取助手，从原文中识别并结构化输出所有重要角色的视觉描述信息，包括外貌、服饰、体态、状态变体等字段，供美术制作和AI角色图生成使用。",
            embedding: "",
            type: "references",
            createTime: 1774447310118,
            updateTime: 1774450080903,
            state: 1,
          },
          {
            id: "6d46cdca10b2f49e07e515885d1387a0",
            md5: "10544d12c4ef011e6b3b63a99b8c7fa8",
            path: "references/novel_props_extract.md",
            name: "novel_props_extract",
            description:
              "专注于从小说原文中提取道具物品信息的分析助手，能识别武器、法器、药物等各类道具，生成包含外观、材质、尺寸、功能及状态变体的结构化视觉描述表格，供美术制作和AI绘图使用。",
            embedding: "",
            type: "references",
            createTime: 1774447310118,
            updateTime: 1774450094771,
            state: 1,
          },
          {
            id: "1864df75d1d65f76e275046649ecaef8",
            md5: "65603aa495a541f54c55b7f30e149f45",
            path: "references/novel_scene_extract.md",
            name: "novel_scene_extract",
            description:
              "专注于从小说原文中提取并结构化场景信息的分析助手，可识别各类场景地点，输出包含空间描述、光照氛围、关键陈设、色调基调等字段的标准化场景资产表，用于美术制作和AI绘图的场景概念图生成。",
            embedding: "",
            type: "references",
            createTime: 1774447310118,
            updateTime: 1774450161878,
            state: 1,
          },
          {
            id: "7fbce6f90d7d85496ba9817e9622e640",
            md5: "830559e8f2cd5d0fa8e6df48a164fe2d",
            path: "references/video_dialogue_extract.md",
            name: "video_dialogue_extract",
            description:
              "这是一个专门从视频分镜提示词中提取结构化台词、旁白与音效信息的AI助手配置文档，定义了完整的输出格式（含镜号、角色、台词类型、表演指导等字段）、提取规则及处理流程，用于将视频分镜描述转化为标准化台词表。",
            embedding: "",
            type: "references",
            createTime: 1774447310118,
            updateTime: 1774450180712,
            state: 1,
          },
          {
            id: "31fb5c5a1f514ec1e66b4eba9f22d4db",
            md5: "43e63450efe0c9af8a3a40b036d36cb4",
            path: "references/pipeline.md",
            name: "pipeline",
            description:
              "面向短剧改编项目的四阶段流水线说明文档，涵盖事件提取、故事骨架、改编策略、剧本编写的串行执行流程，定义了决策层、执行层、监督层的协作规范及派发、审核、修复的交互格式与质量门控标准。",
            embedding: "",
            type: "references",
            createTime: 1774451946248,
            updateTime: 1774451984533,
            state: 1,
          },
          {
            id: "27dc2dfc901de2180227d0269217583a",
            md5: "7d353be4bab7a794436d9abff2b9c6ee",
            path: "references/adaptation_format.md",
            name: "adaptation_format",
            description:
              "本文档规定了改编策略输出的标准格式，包括核心改编原则、删除决策和世界观呈现策略三大模块的书写规范，明确各模块所需涵盖的维度与要素，用于指导竖屏短剧等载体的文学改编工作。",
            embedding: "",
            type: "references",
            createTime: 1774452010535,
            updateTime: 1774452022083,
            state: 1,
          },
          {
            id: "d49fa09504fe784a8e6eb102756c6d56",
            md5: "2ef08a7479f29d74986999ceb02092c8",
            path: "references/event_format.md",
            name: "event_format",
            description:
              "本文档规定了影视改编项目中事件表的标准输出格式，包括文件头、事件表格、各字段填写规范（章节、角色、核心事件、主线关系、情绪强度、预估时长）及汇总统计模板，用于指导从原著提取事件并评估改编集数与压缩比的第一阶段工作。",
            embedding: "",
            type: "references",
            createTime: 1774452010535,
            updateTime: 1774452030858,
            state: 1,
          },
          {
            id: "797906c2ddf0750f050bcdeae23eae3d",
            md5: "f5e7fe6db7e05db69d5dc327c4c538f2",
            path: "references/script_format.md",
            name: "script_format",
            description:
              "本文档为竖屏短剧剧本的输出格式规范，定义了文件头、节拍结构、分镜脚本、画面描述、台词、转场标注等标准格式要求，并附有时长控制参数与自查清单，供AI视频生成和导演制作使用。",
            embedding: "",
            type: "references",
            createTime: 1774452010535,
            updateTime: 1774452042934,
            state: 1,
          },
          {
            id: "1abd8675c0c3e62b20c0b151d2ec0fb1",
            md5: "a587532c737ce15022e1522021f099bb",
            path: "references/skeleton_format.md",
            name: "skeleton_format",
            description:
              "本文档定义了故事骨架文件（skeleton.md）的标准化输出格式，涵盖故事核、人物成长隐线、三幕结构、分集决策模板、全局删减记录、付费卡点设计及自查清单，用于指导编剧将章节事件列表转化为结构完整的剧集改编方案。",
            embedding: "",
            type: "references",
            createTime: 1774452010535,
            updateTime: 1774452057184,
            state: 1,
          },
          {
            id: "0b7828d7a6ab458a4b201122f08d6c16",
            md5: "120b3c856f1b2a8a429e11319e8c95fe",
            path: "references/quality_criteria.md",
            name: "quality_criteria",
            description:
              "本文档为影视/短剧项目的质量审核标准手册，涵盖事件表、故事骨架、改编策略和剧本四大模块的详细审核规则，规定了格式规范、角色名称统一、时长合理性、画面可执行性及场景氛围一致性等审核要求，用于确保各阶段产出物的内容准确性与制作可行性。",
            embedding: "",
            type: "references",
            createTime: 1774452068093,
            updateTime: 1774452087877,
            state: 1,
          },
          {
            id: "5c1772b5f9c420d9eae9ca02914ba087",
            md5: "c710ab7d237e1f0c5aa3d208e0f5b484",
            path: "references/plan.md",
            name: "plan",
            description:
              "该文档定义了AI代理生成执行计划的规范，包括任务总览、步骤列表（含编号、名称、详细内容、预期输出及依赖关系）和执行顺序标注，并提供标准回复模板，用于将用户需求拆解为可直接传入子代理工具执行的具体步骤。",
            embedding: "",
            type: "references",
            createTime: 1774452098447,
            updateTime: 1774452109574,
            state: 1,
          },
          {
            id: "75a45cf996015ca819582873887ec301",
            md5: "6045d76873fd58b8b87a914a21a38439",
            path: "references/derive_assets_extraction.md",
            name: "derive_assets_extraction",
            description:
              "本文档是一份技术操作指南，说明如何根据剧本内容和已有资产列表，提取每个资产在剧情中出现的不同视觉状态变体（derive），并通过工具函数读取和写入数据，用于后续图片生成参考。",
            embedding: "",
            type: "references",
            createTime: 1774452119499,
            updateTime: 1774452129516,
            state: 1,
          },
          {
            id: "fce75f69d704c19bebcb356bc1bd6e81",
            md5: "a3b3432854970f22949ba47236a6532f",
            path: "references/storyboard_generation.md",
            name: "storyboard_generation",
            description:
              "根据剧本和资产列表生成结构化分镜面板的工具指南，涵盖分镜拆分原则、字段填写规范及工具调用流程，用于将剧本转化为含画面描述、镜头语言、台词和AI绘图提示词的分镜数据。",
            embedding: "",
            type: "references",
            createTime: 1774452119499,
            updateTime: 1774452140873,
            state: 1,
          },
        ];
        if (process.env.TOONFLOW_SKIP_SKILL_EMBEDDINGS !== "1") {
          await Promise.all(
            list.map(async (item) => {
              const embedding = await getEmbedding(item.description);
              item.embedding = JSON.stringify(embedding);
            }),
          );
        }
        await knex("o_skillList").insert(list);
      },
    },
    {
      name: "o_skillAttribution",
      builder: (table) => {
        table.text("skillId").notNullable().references("id").inTable("o_skillList").onDelete("CASCADE");
        table.text("attribution").notNullable(); // "production_agent_decision.md" | "production_agent_execution.md" | "production_agent_supervision.md" | "script_agent_decision.md" | "script_agent_execution.md" | "script_agent_supervision.md" | "universal_agent.md"
        table.primary(["skillId", "attribution"]);
        table.index(["attribution"]);
      },
      initData: async (knex) => {
        await knex("o_skillAttribution").insert([
          {
            skillId: "52c51fa8655f899a1b7aae9b6aad7251",
            attribution: "universal_agent.md",
          },
          {
            skillId: "6d46cdca10b2f49e07e515885d1387a0",
            attribution: "universal_agent.md",
          },
          {
            skillId: "1864df75d1d65f76e275046649ecaef8",
            attribution: "universal_agent.md",
          },
          {
            skillId: "3e5efec258c8d8e6a39bcef12f8ee058",
            attribution: "universal_agent.md",
          },
          {
            skillId: "7fbce6f90d7d85496ba9817e9622e640",
            attribution: "universal_agent.md",
          },
          {
            skillId: "31fb5c5a1f514ec1e66b4eba9f22d4db",
            attribution: "script_agent_decision.md",
          },
          {
            skillId: "27dc2dfc901de2180227d0269217583a",
            attribution: "script_agent_execution.md",
          },
          {
            skillId: "d49fa09504fe784a8e6eb102756c6d56",
            attribution: "script_agent_execution.md",
          },
          {
            skillId: "797906c2ddf0750f050bcdeae23eae3d",
            attribution: "script_agent_execution.md",
          },
          {
            skillId: "1abd8675c0c3e62b20c0b151d2ec0fb1",
            attribution: "script_agent_execution.md",
          },
          {
            skillId: "0b7828d7a6ab458a4b201122f08d6c16",
            attribution: "script_agent_supervision.md",
          },
          {
            skillId: "5c1772b5f9c420d9eae9ca02914ba087",
            attribution: "production_agent_decision.md",
          },
          {
            skillId: "75a45cf996015ca819582873887ec301",
            attribution: "production_agent_execution.md",
          },
          {
            skillId: "fce75f69d704c19bebcb356bc1bd6e81",
            attribution: "production_agent_execution.md",
          },
        ]);
      },
    },
    //记忆表（message=原始消息, summary=压缩摘要）
    {
      name: "memories",
      builder: (table) => {
        table.text("id").notNullable();
        table.text("isolationKey").notNullable(); // 记忆隔离键
        table.text("type").notNullable(); // 'message' | 'summary'
        table.text("role"); // 'user' | 'assistant'
        table.text("name");
        table.text("content").notNullable();
        table.text("embedding"); // 向量嵌入 JSON
        table.text("relatedMessageIds"); // summary关联的message id列表 JSON
        table.integer("summarized").defaultTo(0); // message是否已被总结 0/1
        table.integer("createTime").notNullable();
        table.primary(["id"]);
        table.index(["isolationKey", "type"]);
        table.index(["isolationKey", "summarized"]);
      },
    },
    {
      name: "o_assetsRole2Audio",
      builder: (table) => {
        table.integer("assetsRoleId").notNullable();
        table.integer("assetsAudioId").notNullable();
        table.primary(["assetsAudioId", "assetsRoleId"]);
        table.unique(["assetsAudioId", "assetsRoleId"]);
      },
    },
    {
      name: "o_editImageTask",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("projectId");
        table.integer("scriptId");
        table.integer("deriveAssetId");
        table.string("targetType");
        table.integer("targetId");
        table.integer("flowId");
        table.text("nodeId");
        table.text("references");
        table.text("model");
        table.text("quality");
        table.text("ratio");
        table.text("prompt");
        table.string("status");
        table.string("state");
        table.text("url");
        table.text("reason");
        table.integer("taskCenterId");
        table.integer("createTime");
        table.integer("updateTime");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
  ];

  const pendingInitData: TableSchema[] = [];
  for (const t of tables) {
    if (options.includeTables && !options.includeTables.has(t.name)) continue;
    if (options.excludeTables?.has(t.name)) continue;
    const tableExists = await knex.schema.hasTable(t.name);
    if (!tableExists || forceInit) {
      if (tableExists && forceInit) {
        await knex.schema.dropTable(t.name);
        console.log("[初始化数据库] 已存在表删除并重建:", t.name);
      } else {
        console.log("[初始化数据库] 创建数据表:", t.name);
      }
      await knex.schema.createTable(t.name, t.builder);
      if (t.initData) pendingInitData.push(t);
    }
  }
  for (const t of pendingInitData) {
    await t.initData?.(knex);
    console.log("[初始化数据库] 表数据初始化:", t.name);
  }
};
