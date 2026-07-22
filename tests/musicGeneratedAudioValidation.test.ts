import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectGeneratedMusicFile } from "../src/services/musicAudioMetadata";

test("generated music inspection records real duration and rejects provider output above the model maximum", async () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "toonflow-generated-music-"));
  const filePath = path.join(root, "two-seconds.mp3");
  try {
    const ffmpeg = String((await import("ffmpeg-static")).default || "");
    execFileSync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:a",
      "libmp3lame",
      "-y",
      filePath,
    ]);

    const accepted = await inspectGeneratedMusicFile({ filePath, model: "test:music", maxDurationSec: 3 });
    assert.ok(accepted.durationMs >= 1900 && accepted.durationMs <= 2100);
    assert.equal(accepted.durationSec, 2);

    await assert.rejects(
      () => inspectGeneratedMusicFile({ filePath, model: "test:music", maxDurationSec: 0.5 }),
      /exceeding the declared maximum/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
