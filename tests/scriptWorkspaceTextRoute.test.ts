import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "toonflow-script-text-route-"));
process.env.TOONFLOW_APP_DATA_DIR = path.join(root, "app");
process.env.TOONFLOW_WORKSPACE_DIR = path.join(root, "workspace");
process.env.TOONFLOW_STORAGE_MODE = "workspace";
process.env.TOONFLOW_SYSTEM_DATA_DIR = path.resolve("data");
process.env.TOONFLOW_SKIP_SKILL_EMBEDDINGS = "1";
process.env.NODE_ENV = "test";

let db: any;
let listRoute: any;
let workspaceRoute: any;
let textRoute: any;
let textStorage: typeof import("../src/services/scriptWorkspaceText");
let workspace: typeof import("../src/services/scriptAgentWorkspace");

async function post(route: any, body: Record<string, unknown>) {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json({ limit: "100mb" }));
  app.use("/", route);
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

before(async () => {
  const [dbModule, listModule, workspaceModule, textModule, storageModule, workspaceService] = await Promise.all([
    import("../src/utils/db"),
    import("../src/routes/script/getScrptApi"),
    import("../src/routes/scriptAgent/workspaceDetail"),
    import("../src/routes/textAsset/getContent"),
    import("../src/services/scriptWorkspaceText"),
    import("../src/services/scriptAgentWorkspace"),
  ]);
  db = dbModule.default;
  await dbModule.dbReady;
  listRoute = listModule.default;
  workspaceRoute = workspaceModule.default;
  textRoute = textModule.default;
  textStorage = storageModule;
  workspace = workspaceService;
});

after(async () => {
  await db?.destroy();
  await fs.rm(root, { recursive: true, force: true });
});

test("script list and workspace support metadata-only reads with paged content", async () => {
  const projectId = 2026072701;
  const otherProjectId = 2026072702;
  await db("o_project").insert([
    { id: projectId, name: "Large scripts", createTime: Date.now() },
    { id: otherProjectId, name: "Other", createTime: Date.now() },
  ]);
  const content = "超过五千字的剧本正文。\n".repeat(50_000);
  const script = await textStorage.createScriptWithContent({ projectId, name: "EP01", content });
  await workspace.saveScriptAgentStage({ projectId, stage: "storySkeleton", content: "大型故事骨架" });

  const metadataResponse = await post(listRoute, { projectId, includeContent: false });
  assert.equal(metadataResponse.status, 200);
  const metadataPayload = (await metadataResponse.json()) as any;
  assert.equal("content" in metadataPayload.data[0], false);
  assert.equal(metadataPayload.data[0].contentAsset.id, script.contentAsset.id);
  assert.equal(metadataPayload.data[0].contentAsset.size, Buffer.byteLength(content, "utf8"));

  const compatibleResponse = await post(listRoute, { projectId });
  const compatiblePayload = (await compatibleResponse.json()) as any;
  assert.equal(compatiblePayload.data[0].content, content);

  const workspaceResponse = await post(workspaceRoute, { projectId, includeContent: false });
  const workspacePayload = (await workspaceResponse.json()) as any;
  assert.equal("storySkeleton" in workspacePayload.data, false);
  assert.equal("content" in workspacePayload.data.scripts[0], false);
  assert.ok(workspacePayload.data.stageAssets.storySkeleton.id > 0);

  const pageResponse = await post(textRoute, {
    projectId,
    id: script.contentAsset.id,
    offset: 0,
    limit: 4096,
  });
  assert.equal(pageResponse.status, 200);
  const page = (await pageResponse.json()) as any;
  assert.equal(page.data.content, content.slice(0, 4096));
  assert.equal(page.data.eof, false);

  const crossProject = await post(textRoute, { projectId: otherProjectId, id: script.contentAsset.id });
  assert.equal(crossProject.status, 404);
});

test("superseded script asset IDs cannot read hidden history", async () => {
  const projectId = 2026072703;
  await db("o_project").insert({ id: projectId, name: "Current only", createTime: Date.now() });
  const script = await textStorage.createScriptWithContent({ projectId, name: "EP01", content: "old" });
  const oldAssetId = script.contentAsset.id;
  await textStorage.replaceScriptContent({ projectId, scriptId: script.id, content: "current" });
  const response = await post(textRoute, { projectId, id: oldAssetId });
  assert.equal(response.status, 404);
});
