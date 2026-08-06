import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-production-resource-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let db: any;
let resources: typeof import("../src/services/productionResource");

before(async () => {
  db = (await import("../src/utils/db")).db;
  resources = await import("../src/services/productionResource");
  await db.schema.createTable("o_script", (table: any) => {
    table.increments("id").primary();
    table.integer("projectId").notNullable();
    table.text("content");
    table.integer("contentTextAssetId");
    table.integer("createTime");
  });
  await db("o_script").insert({
    id: 2,
    projectId: 1,
    content: "alpha 0123456789 alpha 0123456789 omega",
    contentTextAssetId: null,
    createTime: 1,
  });
});

after(async () => {
  await db.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("text resources expose exact ranges, literal search and bound cursors", async () => {
  const descriptor = await resources.createProductionResourceRef(1, 2, "script");
  assert.equal(descriptor.resourceType, "text");

  const first = await resources.accessProductionResource(
    { projectId: 1, scriptId: 2 },
    { resourceRef: descriptor.resourceRef, operation: "read", position: 0, limit: 5 },
  );
  assert.equal(first.content, "alpha");
  assert.deepEqual(first.returnedRange, { unit: "character", start: 0, end: 5 });
  assert.equal(first.eof, false);

  const second = await resources.accessProductionResource(
    { projectId: 1, scriptId: 2 },
    { resourceRef: descriptor.resourceRef, operation: "read", cursor: String(first.nextCursor), limit: 5 },
  );
  assert.equal(second.content, " 0123");
  assert.deepEqual(second.returnedRange, { unit: "character", start: 5, end: 10 });

  const search = await resources.accessProductionResource(
    { projectId: 1, scriptId: 2 },
    { resourceRef: descriptor.resourceRef, operation: "search", query: "alpha", limit: 1 },
  );
  assert.equal(search.hits?.[0]?.position, 0);
  assert.equal(search.eof, false);
  assert.equal(typeof search.nextCursor, "string");
});

test("resource references cannot cross scope and become stale when the source changes", async () => {
  const descriptor = await resources.createProductionResourceRef(1, 2, "script");
  await assert.rejects(
    resources.accessProductionResource(
      { projectId: 9, scriptId: 2 },
      { resourceRef: descriptor.resourceRef, operation: "stat" },
    ),
    /RESOURCE_SCOPE_MISMATCH/,
  );

  await db("o_script").where({ id: 2, projectId: 1 }).update({ content: "changed with the same overall length perhaps" });
  await assert.rejects(
    resources.accessProductionResource(
      { projectId: 1, scriptId: 2 },
      { resourceRef: descriptor.resourceRef, operation: "read" },
    ),
    /RESOURCE_CHANGED/,
  );
});

test("future adapters register behind the same resource protocol", async () => {
  resources.registerProductionResourceAdapter({
    key: "external-example",
    kind: "text",
    async version() {
      return "external-v1";
    },
    async load() {
      return "external text";
    },
  });
  const descriptor = await resources.createProductionResourceRef(1, 2, "external-example");
  const result = await resources.accessProductionResource(
    { projectId: 1, scriptId: 2 },
    { resourceRef: descriptor.resourceRef, operation: "read" },
  );
  assert.equal(result.content, "external text");

  resources.registerProductionResourceAdapter({
    key: "external-collection",
    kind: "collection",
    async version() {
      return "collection-v1";
    },
    async load() {
      return Array.from({ length: 25 }, (_, index) => ({ index, value: `item-${index}` }));
    },
  });
  const collection = await resources.createProductionResourceRef(1, 2, "external-collection");
  const collectionResult = await resources.accessProductionResource(
    { projectId: 1, scriptId: 2 },
    { resourceRef: collection.resourceRef, operation: "read", position: 0, limit: 100 },
  );
  assert.equal(collectionResult.items?.length, resources.PRODUCTION_RESOURCE_COLLECTION_MAX_LIMIT);
  assert.deepEqual(collectionResult.items?.[0], { index: 0, value: "item-0" });
  assert.deepEqual(collectionResult.returnedRange, { unit: "item", start: 0, end: 20 });
  assert.equal(collectionResult.eof, false);
});
