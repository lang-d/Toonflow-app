import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-storyboard-table-text-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let db: typeof import("../src/utils/db").db;
let renderStoryboardTableFromRows: typeof import("../src/services/storyboardTableText").renderStoryboardTableFromRows;

function row(index: number, cameraAngle?: string) {
  return {
    version: 2,
    index,
    groupKey: "G01",
    beatId: `B${String(index + 1).padStart(2, "0")}`,
    durationSec: 3,
    location: "柜台前",
    timeOfDay: "日",
    picture: "两人隔柜台对话",
    shotSize: "中景",
    cameraMove: "固定",
    ...(cameraAngle === undefined ? {} : { cameraAngle }),
    action: "角色甲递出单据",
    dialogue: [],
    soundEffects: ["室内环境声"],
    requiredAssets: [],
  };
}

before(async () => {
  db = (await import("../src/utils/db")).db;
  ({ renderStoryboardTableFromRows } = await import("../src/services/storyboardTableText"));
  await db.schema.createTable("o_storyboard", (table) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("scriptId");
    table.integer("index");
    table.text("tableRowJson");
    table.string("factStatus");
    table.string("groupName");
  });
  await db("o_storyboard").insert([
    {
      id: 1,
      projectId: 10,
      scriptId: 20,
      index: 0,
      factStatus: "ready",
      groupName: "开场",
      tableRowJson: JSON.stringify(row(0, "对话轴 A｜A1\n朝角色甲 | 保持同侧")),
    },
    {
      id: 2,
      projectId: 10,
      scriptId: 20,
      index: 1,
      factStatus: "ready",
      groupName: "开场",
      tableRowJson: JSON.stringify({
        ...row(1),
        version: 1,
        groupName: "开场",
        groupIntent: "建立人物关系",
        cameraMove: "固定",
        characters: [],
        visibleEmotion: "平静",
      }),
    },
    {
      id: 3,
      projectId: 10,
      scriptId: 20,
      index: 2,
      factStatus: "ready",
      groupName: "变化",
      tableRowJson: JSON.stringify({
        version: 3,
        index: 2,
        groupKey: "G02",
        beatId: "B03",
        durationSec: 5,
        location: "柜台前",
        timeOfDay: "日",
        shotDescription: "角色甲握着单据站在柜台外。角色乙确认内容后接过单据；镜头结束时单据留在角色乙手中。",
        shotSize: "中景",
        cameraMove: "固定",
        cameraAngle: "交接轴 A1\n保持同侧 | 朝柜台",
        dialogue: [],
        soundEffects: ["室内环境声"],
        requiredAssets: [],
      }),
    },
  ]);
});

after(async () => {
  await db?.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("renders the axis and camera column from structured storyboard rows", async () => {
  const rendered = await renderStoryboardTableFromRows(10, 20);

  assert.match(rendered.content, /\| 镜头描述 \| 起始画面 \| 主要动作 \| 景别 \| 运镜 \| 轴线 \/ 机位 \|/);
  assert.match(rendered.content, /固定 \| 对话轴 A｜A1<br>朝角色甲 \\| 保持同侧 \|/);
  assert.match(rendered.content, /角色甲握着单据站在柜台外。角色乙确认内容后接过单据/);
  assert.match(rendered.content, /交接轴 A1<br>保持同侧 \\| 朝柜台/);
  assert.equal(rendered.meta.source, "structured");
});

test("keeps the axis and camera cell empty for older structured rows", async () => {
  const rendered = await renderStoryboardTableFromRows(10, 20);
  const secondRow = rendered.content.split("\n").find((line) => line.startsWith("| 2 |"));

  assert.ok(secondRow);
  assert.match(secondRow, /\| 固定 \|  \| 无台词 \|/);
});
