import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-material-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let db: any;
let materialService: typeof import("../src/services/projectMaterial");
let u: typeof import("../src/utils").default;

before(async () => {
  db = (await import("../src/utils/db")).db;
  u = (await import("../src/utils")).default;
  materialService = await import("../src/services/projectMaterial");

  await db.schema.createTable("o_project", (table: any) => {
    table.integer("id").primary();
    table.text("name");
    table.text("intro");
    table.text("type");
    table.text("artStyle");
  });
  await db.schema.createTable("o_projectMaterial", (table: any) => {
    table.integer("id").primary();
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
  });
  await db.schema.createTable("o_textAsset", (table: any) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.string("targetType");
    table.string("targetId");
    table.string("filePath");
    table.text("summary");
    table.integer("size");
    table.string("hash");
    table.integer("version");
    table.string("state");
    table.integer("createTime");
    table.integer("updateTime");
  });
  await db("o_project").insert([
    { id: 1, name: "Project A" },
    { id: 2, name: "Project B" },
    { id: 3, name: "Project C", intro: "都市短剧", type: "series", artStyle: "真人都市" },
    { id: 4, name: "Project D", intro: "都市短剧", type: "series", artStyle: "真人都市" },
    { id: 5, name: "Project E", intro: "都市短剧", type: "series", artStyle: "真人都市" },
    { id: 6, name: "Project F", intro: "都市短剧", type: "series", artStyle: "真人都市" },
    { id: 7, name: "Project G", intro: "都市短剧", type: "series", artStyle: "真人都市" },
  ]);
});

after(async () => {
  await db?.destroy?.();
  await fsp.rm(dataDir, { recursive: true, force: true });
});

test("saves text project material as file metadata and reads it by pages", async () => {
  const content = "第一集大纲\n主角进入餐厅。\n".repeat(20);
  const base64Data = `data:text/plain;base64,${Buffer.from(content, "utf8").toString("base64")}`;
  const material = await materialService.saveProjectMaterial({
    projectId: 1,
    category: "outline",
    name: "story-outline.txt",
    base64Data,
  });

  assert.equal(material.projectId, 1);
  assert.equal(material.category, "outline");
  assert.equal(material.state, "ready");
  assert.equal(material.ext, "txt");
  assert.match(material.filePath, /^projects\/1\/materials\/outline\//);
  assert.ok(material.summary?.includes("第一集大纲"));

  const dbRow = await db("o_projectMaterial").where({ id: material.id }).first();
  assert.equal(dbRow.filePath, material.filePath);
  assert.equal(dbRow.textPath, null);
  assert.equal(dbRow.summary.includes("主角进入餐厅"), true);

  const absolute = materialService.resolveProjectMaterialPath(material.filePath);
  assert.equal(await fsp.readFile(absolute, "utf8"), content);

  const page = await materialService.readProjectMaterial({ id: material.id, projectId: 1, offset: 0, limit: 12 });
  assert.equal(page.content.length, 12);
  assert.equal(page.eof, false);
});

test("saves non-text original with textContent sidecar for agent reads", async () => {
  const original = Buffer.from([1, 2, 3, 4, 5]);
  const textContent = "人物设定：林若溪，冷静克制。";
  const material = await materialService.saveProjectMaterial({
    projectId: 1,
    category: "character",
    name: "characters.pdf",
    mime: "application/pdf",
    base64Data: original.toString("base64"),
    textContent,
  });

  assert.equal(material.ext, "pdf");
  assert.equal(material.state, "ready");
  assert.ok(material.textPath);
  assert.equal(material.textSize, Buffer.byteLength(textContent, "utf8"));

  const originalPath = materialService.resolveProjectMaterialPath(material.filePath);
  assert.deepEqual(await fsp.readFile(originalPath), original);

  const page = await materialService.readProjectMaterial({ id: material.id, projectId: 1 });
  assert.equal(page.content, textContent);
});

test("rejects invalid category and cross-project material reads", async () => {
  await assert.rejects(
    () =>
      materialService.saveProjectMaterial({
        projectId: 1,
        category: "script" as any,
        name: "bad.txt",
        textContent: "bad",
      }),
    /Invalid project material category/,
  );

  const material = await materialService.saveProjectMaterial({
    projectId: 1,
    category: "notes",
    name: "note.md",
    textContent: "private project note",
  });
  await assert.rejects(
    () => materialService.readProjectMaterial({ id: material.id, projectId: 2 }),
    /Project material not found/,
  );
});

test("archives material so default list and read no longer return it", async () => {
  const material = await materialService.saveProjectMaterial({
    projectId: 1,
    category: "music",
    name: "music.md",
    textContent: "配乐参考：钢琴，弱起。",
  });

  await materialService.archiveProjectMaterial({ projectId: 1, id: material.id });
  const list = await materialService.listProjectMaterials({ projectId: 1, category: "music" });
  assert.equal(list.some((item) => item.id === material.id), false);
  await assert.rejects(
    () => materialService.readProjectMaterial({ id: material.id, projectId: 1 }),
    /Project material not found/,
  );
});

type MockAiOutput = string | ((input: any, index: number) => string);

async function withMockAiText(outputs: MockAiOutput[], fn: () => Promise<void>) {
  const original = u.Ai.Text;
  let index = 0;
  (u.Ai as any).Text = () => ({
    invoke: async (input: any) => {
      const output = outputs[index];
      const text = typeof output === "function" ? output(input, index) : output;
      index += 1;
      if (text == null) throw new Error("Unexpected AI call");
      return { text };
    },
  });
  try {
    await fn();
  } finally {
    (u.Ai as any).Text = original;
  }
}

const validContextPack = [
  "## 项目硬事实",
  "- 主角林若溪在现代城市工作。",
  "## 资产复用参考",
  "- 林若溪：鹅蛋脸、齐肩黑发、常穿浅灰衬衫；声音/台词表现待设定；作为同一角色资产复用。",
  "## 连续性锚点",
  "- 林若溪保持冷静克制，常用停顿和视线回避表达压力。",
  "## 视觉与导演参考",
  "- 室内戏优先自然窗光和克制构图。",
  "## 配乐参考",
  "- 后期配乐以钢琴弱起为主，不写入视频模型提示词。",
  "## 缺资料与不确定项",
  "- 角色年龄暂无明确资料。",
].join("\n");

test("context-pack skills require compact asset facts and evidence-based role voice design", () => {
  const flow = fs.readFileSync(path.join(process.cwd(), "data", "skills", "project_context_pack_flow.md"), "utf8");
  const technique = fs.readFileSync(path.join(process.cwd(), "data", "skills", "project_context_pack_technique.md"), "utf8");
  const review = fs.readFileSync(path.join(process.cwd(), "data", "skills", "project_context_pack_review.md"), "utf8");

  assert.match(flow, /人物的稳定外形与声音\/台词表现/);
  assert.match(flow, /不得生成 TTS 供应商、音色 ID、真人模仿对象、克隆参数或音频文件/);
  assert.match(technique, /角色事实卡：身份和关系边界、年龄感、面部\/发型\/体态锚点/);
  assert.match(technique, /声音\/台词表现/);
  assert.match(technique, /不得由性别、年龄、职业或地域推断/);
  assert.match(review, /音色 ID/);
  const extraction = fs.readFileSync(path.join(process.cwd(), "data", "skills", "project_context_pack_extraction.md"), "utf8");
  assert.match(extraction, /只处理当前输入的一段原始项目资料/);
  assert.match(extraction, /声音\/台词表现/);
  assert.match(extraction, /本段未出现某项就写“待设定”/);
});

test("splits complete source text at boundaries without dropping any characters", () => {
  const content = `${"开头资料。\n".repeat(80)}\n声音绑定设定：中低音、咬字清晰。\n${"结尾资料。\n".repeat(80)}`;
  const chunks = materialService.buildProjectMaterialSourceChunks({
    material: { id: 91, projectId: 3, category: "character", name: "long-character.md" },
    content,
    maxChars: 512,
  });
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map((item) => item.content).join(""), content);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1)?.end, content.length);
  assert.ok(chunks.some((item) => item.content.includes("声音绑定设定")));
});

test("asset foundation receives full hard-fact and reusable-asset sections instead of a leading pack slice", async () => {
  const { selectAssetFoundationContextPack } = await import("../src/services/assetFoundation");
  const pack = [
    "## 项目硬事实",
    "- 项目硬事实。",
    "## 资产复用参考",
    `- 林若溪：稳定声音/台词表现为中低音、咬字清晰。${"外形锚点。".repeat(2000)}`,
    "## 连续性锚点",
    "- 不应发送给资产基础设定的后续栏目。",
  ].join("\n");
  const selected = selectAssetFoundationContextPack(pack);
  assert.match(selected, /项目硬事实/);
  assert.match(selected, /稳定声音\/台词表现/);
  assert.ok(selected.length > 7000);
  assert.doesNotMatch(selected, /不应发送给资产基础设定/);
});

test("generates and saves complete project context pack from XML output", async () => {
  await materialService.saveProjectMaterial({
    projectId: 3,
    category: "character",
    name: "character.md",
    textContent: "林若溪：现代城市职场女性，冷静克制。",
  });

  await withMockAiText(
    [
      `<projectMaterialFacts>- 林若溪：现代城市职场女性，冷静克制。</projectMaterialFacts>`,
      `<projectContextPack>${validContextPack}</projectContextPack>`,
      `{"status":"passed","issues":[]}`,
    ],
    async () => {
      const result = await materialService.generateProjectContextPack({ projectId: 3 });
      assert.equal(result.content, validContextPack);
      assert.equal(result.contextPack.state, "complete");
      assert.equal(result.review.status, "passed");

      const latest = await materialService.getProjectContextPack(3);
      assert.equal(latest?.content, validContextPack);
    },
  );
});

test("compresses every ready material and sends tail facts beyond 6000 characters", async () => {
  const longVoiceFact = "声音绑定设定：林若溪为中低音、清爽偏干、咬字清晰，忙时语速略快但不尖喊。";
  await materialService.saveProjectMaterial({
    projectId: 6,
    category: "character",
    name: "long-character-source.md",
    textContent: `${"人物前文资料。\n".repeat(1000)}\n${longVoiceFact}`,
  });
  for (let index = 0; index < 6; index += 1) {
    await materialService.saveProjectMaterial({
      projectId: 6,
      category: "character",
      name: `character-${index + 1}.md`,
      textContent: `角色 ${index + 1} 的稳定资料。`,
    });
  }

  const inputs: any[] = [];
  await withMockAiText(
    [
      (input) => {
        inputs.push(input);
        return `<projectMaterialFacts>${String(input.messages?.[0]?.content || "").includes(longVoiceFact) ? `- ${longVoiceFact}` : "- 已确认资料事实。"}</projectMaterialFacts>`;
      },
      (input) => {
        inputs.push(input);
        return `<projectMaterialFacts>- 已确认资料事实。</projectMaterialFacts>`;
      },
      (input) => {
        inputs.push(input);
        return `<projectMaterialFacts>- 已确认资料事实。</projectMaterialFacts>`;
      },
      (input) => {
        inputs.push(input);
        return `<projectMaterialFacts>- 已确认资料事实。</projectMaterialFacts>`;
      },
      (input) => {
        inputs.push(input);
        return `<projectMaterialFacts>- 已确认资料事实。</projectMaterialFacts>`;
      },
      (input) => {
        inputs.push(input);
        return `<projectMaterialFacts>- 已确认资料事实。</projectMaterialFacts>`;
      },
      (input) => {
        inputs.push(input);
        return `<projectMaterialFacts>- 已确认资料事实。</projectMaterialFacts>`;
      },
      (input) => {
        inputs.push(input);
        return `<projectMaterialFacts>- 已确认资料事实。</projectMaterialFacts>`;
      },
      `<projectContextPack>${validContextPack}</projectContextPack>`,
      `{"status":"passed","issues":[]}`,
    ],
    async () => {
      await materialService.generateProjectContextPack({ projectId: 6 });
    },
  );
  const extractionInputs = inputs.filter((item) => String(item?.system || "").includes("项目资料片段事实提取"));
  assert.equal(extractionInputs.length, 8);
  assert.ok(extractionInputs.some((item) => String(item.messages?.[0]?.content || "").includes(longVoiceFact)));
  assert.ok(extractionInputs.some((item) => String(item.messages?.[0]?.content || "").includes("character-6.md")));
});

test("does not save a context pack when any material fact extraction is malformed", async () => {
  const before = await db("o_textAsset").where({ projectId: 7, targetType: "projectContextPack" }).count("* as count").first();
  await materialService.saveProjectMaterial({
    projectId: 7,
    category: "notes",
    name: "broken-extraction.md",
    textContent: "资料必须完整提取。",
  });
  await withMockAiText(["not the required XML"], async () => {
    await assert.rejects(
      () => materialService.generateProjectContextPack({ projectId: 7 }),
      /Project material fact extraction failed/,
    );
  });
  const after = await db("o_textAsset").where({ projectId: 7, targetType: "projectContextPack" }).count("* as count").first();
  assert.equal(Number(after.count), Number(before.count));
});

test("adjusts previous project context pack with one generate call and keeps versions", async () => {
  await materialService.saveProjectContextPack({ projectId: 4, content: validContextPack });
  const revised = validContextPack.replace("钢琴弱起", "轻电子与钢琴弱起");

  await withMockAiText(
    [
      `<projectContextPack>${revised}</projectContextPack>`,
      `{"status":"passed","issues":[{"severity":"info","message":"已按用户指令调整配乐方向"}]}`,
    ],
    async () => {
      const result = await materialService.generateProjectContextPack({
        projectId: 4,
        previousContent: validContextPack,
        instruction: "配乐加入轻电子，但保持克制。",
      });
      assert.equal(result.content, revised);
      assert.equal(result.contextPack.version, 2);
      const rows = await db("o_textAsset").where({ projectId: 4, targetType: "projectContextPack" }).orderBy("version", "asc");
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((row: any) => Number(row.version)), [1, 2]);
    },
  );
});

test("does not save project context pack without complete XML or when review blocks it", async () => {
  const before = await db("o_textAsset").where({ projectId: 5, targetType: "projectContextPack" }).count("* as count").first();
  await withMockAiText(["plain markdown without xml"], async () => {
    await assert.rejects(
      () => materialService.generateProjectContextPack({ projectId: 5, previousContent: validContextPack, instruction: "重新生成" }),
      /complete XML/,
    );
  });

  await withMockAiText(
    [
      `<projectContextPack>## 项目硬事实\n太短。</projectContextPack>`,
      `{"status":"passed","issues":[]}`,
    ],
    async () => {
      await assert.rejects(
        () => materialService.generateProjectContextPack({ projectId: 5, previousContent: validContextPack, instruction: "生成一个很短的版本" }),
        /review failed/,
      );
    },
  );
  const after = await db("o_textAsset").where({ projectId: 5, targetType: "projectContextPack" }).count("* as count").first();
  assert.equal(Number(after.count), Number(before.count));
});
