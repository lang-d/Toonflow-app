import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("workspace paths, portable snapshot and copy import use project media directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-workspace-test-"));
  const appData = path.join(root, "app");
  const workspace = path.join(root, "workspace");
  process.env.TOONFLOW_APP_DATA_DIR = appData;
  process.env.TOONFLOW_WORKSPACE_DIR = workspace;
  process.env.TOONFLOW_STORAGE_MODE = "workspace";
  process.env.TOONFLOW_SYSTEM_DATA_DIR = path.resolve("data");
  process.env.TOONFLOW_SKIP_SKILL_EMBEDDINGS = "1";
  process.env.NODE_ENV = "test";

  let database: any;
  try {
    const dbModule = await import("../src/utils/db");
    database = dbModule.default as any;
    await dbModule.dbReady;
    const paths = await import("../src/services/storagePaths");
    const portable = await import("../src/services/projectPortable");

    const projectId = 1700000000001;
    await database("o_project").insert({ id: projectId, name: "Portable project", createTime: Date.now() });
    await database("o_script").insert({ id: 2001, projectId, name: "Episode 1", content: "content" });
    await database("o_image").insert({ id: 4001, assetsId: 3001, filePath: `/${projectId}/storyboard/frame.png` });
    await database("o_assets").insert({ id: 3001, projectId, scriptId: 2001, name: "Role", imageId: 4001 });
    const mediaPath = path.join(paths.projectMediaDirectory(projectId), "storyboard", "frame.png");
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.writeFile(mediaPath, Buffer.from("original-media"));

    const exported = await portable.generateProjectSnapshot(projectId, database);
    const snapshot = JSON.parse(await fs.readFile(exported.snapshotPath, "utf8"));
    assert.equal(snapshot.format, "toonflow-project");
    assert.equal(snapshot.projectId, projectId);
    assert.equal(snapshot.media[0].path, "storyboard/frame.png");
    assert.equal(snapshot.tables.o_script[0].projectId, projectId);
    assert.equal("snapshot" in exported, false);
    assert.equal(snapshot.tables.o_tasks, undefined);
    assert.equal(snapshot.tables.o_taskEvent, undefined);
    assert.equal(snapshot.tables.o_videoGenerationTask, undefined);
    assert.equal(snapshot.tables.o_agentWorkData, undefined);

    const readyStorage = await database("o_projectStorage").where("projectId", projectId).first();
    await database("o_tasks").insert({
      id: 5001,
      projectId,
      taskId: "task-5001",
      taskClass: "Edit image",
      taskType: "image",
      status: "processing",
      phase: "provider",
      state: "processing",
      startTime: Date.now(),
      createdAt: Date.now(),
      updateTime: Date.now(),
    });
    await database("o_taskEvent").insert({
      taskId: "task-5001",
      legacyTaskId: 5001,
      version: 1,
      taskType: "image",
      projectId,
      status: "processing",
      phase: "provider",
      createdAt: Date.now(),
    });
    const afterRuntimeTask = await database("o_projectStorage").where("projectId", projectId).first();
    assert.equal(afterRuntimeTask.snapshotState, "ready");
    assert.equal(afterRuntimeTask.revision, readyStorage.revision);
    await database("o_tasks").where("id", 5001).update({
      status: "completed",
      phase: "completed",
      progress: 100,
      finishTime: Date.now(),
      updateTime: Date.now(),
    });

    await database("o_image").where("id", 4001).update({ state: "completed" });
    const stale = await database("o_projectStorage").where("projectId", projectId).first();
    assert.equal(stale.snapshotState, "stale");
    await portable.generateProjectSnapshot(projectId, database);

    const imported = await portable.importPortableProject(exported.directory, database);
    assert.notEqual(imported.projectId, projectId);
    assert.equal(
      await fs.readFile(path.join(paths.projectMediaDirectory(imported.projectId), "storyboard", "frame.png"), "utf8"),
      "original-media",
    );
    const importedProject = await database("o_project").where("id", imported.projectId).first();
    assert.equal(importedProject.name, "Portable project");

    const migration = await import("../src/services/storageMigration");
    const migratedWorkspace = path.join(root, "migrated-workspace");
    const migrated = await migration.performStorageMigration(
      { sourcePath: workspace, targetPath: migratedWorkspace },
      999999,
    );
    assert.equal(migrated.restartRequired, true);
    assert.equal(await fs.stat(path.join(migratedWorkspace, "workspace.sqlite")).then(() => true), true);
    assert.equal(
      await fs.readFile(
        path.join(migratedWorkspace, "projects", String(projectId), "media", "storyboard", "frame.png"),
        "utf8",
      ),
      "original-media",
    );
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    await database?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});
