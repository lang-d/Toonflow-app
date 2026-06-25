import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

test("frontend workspace integration doc separates createWorkspace from startMigration", async () => {
  const doc = await fs.readFile(
    path.resolve("docs/frontend-workspace-migration-integration.md"),
    "utf8",
  );

  assert.match(doc, /createWorkspace/);
  assert.match(doc, /startMigration/);
  assert.match(doc, /创建空作品库/);
  assert.match(doc, /迁移旧数据/);
  assert.match(doc, /不显示“备份数据”/);
  assert.match(doc, /必须传 `sourcePath`/);
  assert.match(doc, /不要再把“创建空作品库”提交到 `startMigration`/);
});
