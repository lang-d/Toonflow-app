import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  downloadDreaminaVideoUrl,
  retrieveValidatedDreaminaVideo,
  validateDreaminaVideoFile,
} from "../src/utils/dreaminaCli";

const localRequire = createRequire(typeof __filename === "string" ? __filename : path.resolve(process.cwd(), "package.json"));

function createVideoFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-dreamina-video-integrity-"));
  const complete = path.join(dir, "complete.mp4");
  const truncated = path.join(dir, "truncated.mp4");
  const ffmpeg = String(localRequire("ffmpeg-static"));
  execFileSync(ffmpeg, [
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=96x64:rate=24",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-y",
    complete,
  ], { stdio: "ignore" });
  const bytes = fs.readFileSync(complete);
  fs.writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
  return { dir, complete, truncated };
}

test("Dreamina video integrity validation rejects a truncated MP4 even when its header remains readable", async () => {
  const fixture = createVideoFixtures();
  try {
    const valid = await validateDreaminaVideoFile(fixture.complete);
    assert.equal(valid.bytes, fs.statSync(fixture.complete).size);
    await assert.rejects(() => validateDreaminaVideoFile(fixture.truncated), /incomplete or corrupt/i);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Dreamina retrieval retries only the existing submit task and accepts the first complete download", async () => {
  const fixture = createVideoFixtures();
  const tempRoot = path.join(fixture.dir, "attempts");
  const submitId = "existing-submit-id";
  let calls = 0;
  try {
    const result = await retrieveValidatedDreaminaVideo(
      { submitId, tempRoot },
      {
        queryResult: async (receivedSubmitId, downloadDir) => {
          calls += 1;
          assert.equal(receivedSubmitId, submitId);
          fs.copyFileSync(calls === 1 ? fixture.truncated : fixture.complete, path.join(downloadDir, `result-${calls}.mp4`));
          return { stdout: JSON.stringify({ submit_id: submitId, gen_status: "success" }), stderr: "", code: 0 };
        },
      },
    );
    assert.equal(calls, 2);
    assert.equal(fs.readFileSync(result.file).equals(fs.readFileSync(fixture.complete)), true);
    assert.match(result.rawOutput, /attempt 1: rejected/i);
    assert.match(result.rawOutput, /attempt 2: accepted/i);
    assert.equal(fs.readdirSync(tempRoot).length, 1, "the rejected attempt directory is removed");
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Dreamina retrieval leaves no result after three invalid downloads", async () => {
  const fixture = createVideoFixtures();
  const tempRoot = path.join(fixture.dir, "attempts");
  let calls = 0;
  try {
    await assert.rejects(
      () =>
        retrieveValidatedDreaminaVideo(
          { submitId: "existing-submit-id", tempRoot },
          {
            queryResult: async (_submitId, downloadDir) => {
              calls += 1;
              fs.copyFileSync(fixture.truncated, path.join(downloadDir, `result-${calls}.mp4`));
              return { stdout: "", stderr: "", code: 0 };
            },
          },
        ),
      /after 3 attempts/i,
    );
    assert.equal(calls, 3);
    assert.equal(fs.existsSync(tempRoot) ? fs.readdirSync(tempRoot).length : 0, 0);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Dreamina URL fallback rejects partial and byte-incomplete HTTP responses before validation", async () => {
  const fixture = createVideoFixtures();
  const bytes = fs.readFileSync(fixture.complete);
  const server = http.createServer((req, res) => {
    if (req.url === "/partial") {
      res.writeHead(206, { "Content-Length": bytes.length, "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}` });
      res.end(bytes);
      return;
    }
    res.writeHead(200, { "Content-Length": bytes.length + 10 });
    res.end(bytes);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    await assert.rejects(() => downloadDreaminaVideoUrl(`${base}/partial`, path.join(fixture.dir, "partial")), /HTTP 206/i);
    await assert.rejects(() => downloadDreaminaVideoUrl(`${base}/short`, path.join(fixture.dir, "short")));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
