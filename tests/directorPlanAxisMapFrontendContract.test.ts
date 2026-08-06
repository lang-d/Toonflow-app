import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const doc = fs.readFileSync(path.join(root, "docs", "frontend-director-plan-generation.md"), "utf8");

test("director-plan frontend contract removes active axis-map rendering while preserving historical text", () => {
  assert.match(doc, /不再要求输出 `axis-map`、逐场机位图/);
  assert.match(doc, /历史版本中的 `axis-map` 仍按普通 Markdown 代码块兼容展示/);
  assert.match(doc, /前端不需要继续建设或维护专用 SVG 渲染器/);
  assert.match(doc, /一句自然语言/);
  assert.match(doc, /公开媒介名称/);
  assert.match(doc, /不包含内部目录 ID/);
  assert.doesNotMatch(doc, /```axis-map/);
});
