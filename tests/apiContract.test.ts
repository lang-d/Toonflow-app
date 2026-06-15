import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { normalizePayload } from "../src/middleware/apiContract";
import { validateFields } from "../src/middleware/middleware";
import { addStatusCompatibility, toLegacyTaskState, toTaskStatus } from "../src/lib/taskStatus";

test("API envelope keeps HTTP status and code aligned", async () => {
  assert.deepEqual(await normalizePayload({ code: 200, data: { id: 1 }, message: "ok" }, 200), {
    code: 200,
    data: { id: 1 },
    message: "ok",
  });
  assert.deepEqual(await normalizePayload({ code: 200, data: null, message: "bad" }, 500), {
    code: 500,
    data: null,
    message: "bad",
  });
  assert.deepEqual(await normalizePayload({ message: "missing" }, 404), {
    code: 404,
    data: null,
    message: "missing",
  });
});

test("API envelope normalizes legacy media fields", async () => {
  const payload = await normalizePayload(
    { code: 200, data: { id: 1, filePath: "1780117726343/role/a.jpg" }, message: "ok" },
    200,
  );
  assert.equal((payload.data as any).filePath, undefined);
  assert.equal((payload.data as any).media.path, "1780117726343/role/a.jpg");
  assert.equal((payload.data as any).media.type, "image");
});

test("API envelope removes empty legacy media fields", async () => {
  const payload = await normalizePayload(
    { code: 200, data: { id: 1, src: "", filePath: null, generatedImage: "" }, message: "ok" },
    200,
  );
  assert.deepEqual(payload.data, { id: 1 });
});

test("API envelope strips public oss prefixes from media paths", async () => {
  const payload = await normalizePayload(
    { code: 200, data: { selectedImageUrl: "/oss/1780117726343/image/a.jpg?size=20" }, message: "ok" },
    200,
  );
  assert.equal((payload.data as any).selectedMedia.path, "1780117726343/image/a.jpg");
  assert.doesNotMatch((payload.data as any).selectedMedia.url, /\/oss\/oss\//);
});

test("validateFields writes Zod transforms and defaults back to the request", async () => {
  const middleware = validateFields({
    projectId: z.union([z.string(), z.number()]).transform(Number),
    scriptId: z.number().default(0),
  });
  const req: any = { body: { projectId: "42" } };
  let sent: any;
  const res: any = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: any) {
      sent = body;
      return this;
    },
  };
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(req.body, { projectId: 42, scriptId: 0 });
  assert.equal(sent, undefined);
});

test("validation errors use data.issues", () => {
  const middleware = validateFields({ projectId: z.number() });
  const req: any = { body: { projectId: "bad" } };
  let sent: any;
  const res: any = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: any) {
      sent = body;
      return this;
    },
  };

  middleware(req, res, () => assert.fail("next should not be called"));

  assert.equal(res.statusCode, 400);
  assert.equal(sent.code, 400);
  assert.equal(sent.message, "参数错误");
  assert.equal(sent.data.issues[0].path, "projectId");
});

test("task status mapping preserves the legacy state for one compatibility release", () => {
  assert.equal(toTaskStatus("生成中"), "processing");
  assert.equal(toLegacyTaskState("completed"), "已完成");
  assert.deepEqual(addStatusCompatibility({ state: "生成失败", reason: "x" }), {
    state: "生成失败",
    reason: "x",
    status: "failed",
  });
});
