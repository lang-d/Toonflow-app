import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const storyboardTableSkill = fs.readFileSync(
  path.join(repoRoot, "data", "skills", "production_execution_storyboard_table.md"),
  "utf8",
);

test("storyboard table skill keeps groupKey as an ASCII machine id", () => {
  assert.match(storyboardTableSkill, /`groupKey` 是机器 ID/);
  assert.match(storyboardTableSkill, /ASCII 稳定格式/);
  assert.match(storyboardTableSkill, /`G01`、`G02`、`G03`/);
  assert.match(storyboardTableSkill, /禁止把中文标题、动作词、事件名或分组名写入 `groupKey`/);
  assert.match(storyboardTableSkill, /`groupName` 才能写中文事件名或展示名/);
});
