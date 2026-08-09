import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

type Scenario = "stderr" | "stdout";

function runScenario(sink: Scenario) {
  const script = String.raw`
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import loggerModule from "./src/logger.ts";

    const { closeLogger, getLoggerStatus, initLogger } = loggerModule;
    const sink = ${JSON.stringify(sink)};
    const wait = () => new Promise((resolve) => setTimeout(resolve, 25));
    const brokenPipeError = () => Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-logger-"));
    const stdoutSentinel = () => {};
    const stderrSentinel = () => {};
    process.stdout.on("error", stdoutSentinel);
    process.stderr.on("error", stderrSentinel);

    try {
      initLogger({ role: "logger-epipe-" + sink, logDir, hijackConsole: true });
      assert.ok(process.stdout.listeners("error").includes(stdoutSentinel));
      assert.ok(process.stderr.listeners("error").includes(stderrSentinel));
      if (sink === "stdout") console.log("first stdout record");
      else console.error("first stderr record");
      await wait();
      (sink === "stdout" ? process.stdout : process.stderr).emit("error", brokenPipeError());
      await wait();
      const sinkStatus = getLoggerStatus().outputSinks[sink];
      assert.equal(sinkStatus.available, false);
      assert.equal(sinkStatus.failure.code, "EPIPE");
      if (sink === "stdout") {
        console.log("second stdout record");
        console.error("stderr remains available");
      } else {
        console.error("second stderr record");
      }
      await wait();
      closeLogger();
      await wait();
      assert.ok(process.stdout.listeners("error").includes(stdoutSentinel));
      assert.ok(process.stderr.listeners("error").includes(stderrSentinel));
      const file = path.join(logDir, new Date().toISOString().slice(0, 10), "logger-epipe-" + sink + ".jsonl");
      const content = fs.readFileSync(file, "utf8");
      assert.match(content, sink === "stdout" ? /first stdout record/ : /first stderr record/);
      assert.match(content, sink === "stdout" ? /second stdout record/ : /second stderr record/);
      assert.match(content, /output-sink-unavailable/);
      process.stdout.removeListener("error", stdoutSentinel);
      process.stderr.removeListener("error", stderrSentinel);
      fs.rmSync(logDir, { recursive: true, force: true });
      process.stdout.write("__RESULT__" + JSON.stringify({ sink }));
    } catch (error) {
      closeLogger();
      process.stdout.removeListener("error", stdoutSentinel);
      process.stderr.removeListener("error", stderrSentinel);
      fs.rmSync(logDir, { recursive: true, force: true });
      throw error;
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout, stderr: result.stderr };
}

function runCloseRestoreScenario() {
  const script = String.raw`
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import loggerModule from "./src/logger.ts";

    const { closeLogger, initLogger } = loggerModule;
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-logger-"));
    const stdoutListenersBefore = process.stdout.listenerCount("error");
    const stderrListenersBefore = process.stderr.listenerCount("error");
    initLogger({ role: "logger-close-restore", logDir, hijackConsole: true });
    assert.equal(process.stdout.listenerCount("error"), stdoutListenersBefore + 1);
    assert.equal(process.stderr.listenerCount("error"), stderrListenersBefore + 1);
    closeLogger();
    assert.equal(process.stdout.listenerCount("error"), stdoutListenersBefore);
    assert.equal(process.stderr.listenerCount("error"), stderrListenersBefore);
    fs.rmSync(logDir, { recursive: true, force: true });
    process.stdout.write("__RESULT__close-restore");
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("stderr EPIPE disables only its mirror while JSONL logging continues", () => {
  const { stdout, stderr } = runScenario("stderr");
  assert.match(stderr, /first stderr record/);
  assert.doesNotMatch(stderr, /second stderr record/);
  assert.match(stdout, /__RESULT__{"sink":"stderr"}/);
});

test("stdout EPIPE leaves stderr available and closeLogger restores listeners", () => {
  const { stdout, stderr } = runScenario("stdout");
  assert.match(stdout, /first stdout record/);
  assert.doesNotMatch(stdout, /second stdout record/);
  assert.match(stderr, /stderr remains available/);
  assert.match(stdout, /__RESULT__{"sink":"stdout"}/);
});

test("closeLogger removes its output listeners when no stream error occurs", () => {
  assert.match(runCloseRestoreScenario(), /__RESULT__close-restore/);
});
