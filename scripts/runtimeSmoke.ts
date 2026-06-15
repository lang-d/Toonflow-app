import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, utilityProcess, type UtilityProcess } from "electron";
import { RUNTIME_API_PORT } from "../src/runtime/runtimeProtocol";

type Role = "api" | "worker" | "agent";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-runtime-smoke-"));
const children: UtilityProcess[] = [];
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
fs.cpSync(path.join(process.cwd(), "data", "models"), path.join(dataDir, "models"), { recursive: true });

function spawnRole(role: Role) {
  const devMode = process.env.RUNTIME_SMOKE_DEV === "1";
  const fileName = role === "api" ? "api-process.js" : role === "worker" ? "task-worker.js" : "agent-process.js";
  const sourceName = role === "api" ? "apiProcess.ts" : role === "worker" ? "taskWorker.ts" : "agentProcess.ts";
  const child = utilityProcess.fork(
    devMode
      ? path.join(process.cwd(), "scripts", "runtimeBootstrap.cjs")
      : path.join(process.cwd(), "data", "serve", "runtime", fileName),
    [],
    {
    cwd: process.cwd(),
    serviceName: `Toonflow smoke ${role}`,
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TOONFLOW_UTILITY: "1",
      TOONFLOW_RUNTIME_ROLE: role,
      TOONFLOW_DATA_DIR: dataDir,
      NODE_ENV: devMode ? "dev" : "prod",
      ...(devMode ? { TOONFLOW_RUNTIME_ENTRY: path.join(process.cwd(), "src", "runtime", sourceName) } : {}),
    },
  });
  children.push(child);
  child.stderr?.on("data", (chunk) => process.stderr.write(`[${role}] ${chunk}`));
  return new Promise<{ role: Role; pid: number; port?: number }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${role} startup timeout`)), 60_000);
    child.on("message", (message: any) => {
      if (message?.type === "runtime:error") {
        clearTimeout(timeout);
        reject(new Error(message.message));
      }
      if (message?.type === "runtime:ready" && message.role === role) {
        clearTimeout(timeout);
        resolve({ role, pid: Number(message.pid || child.pid), port: message.port });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`${role} exited before ready: ${code}`));
    });
  });
}

async function shutdown() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            child.kill();
            resolve();
          }, 15_000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
          child.postMessage({ type: "shutdown" });
        }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  } catch (error) {
    console.warn(`[runtime-smoke] 临时目录清理失败，可稍后手动删除: ${dataDir}`, error);
  }
}

void app.whenReady().then(async () => {
  try {
    const api = await spawnRole("api");
    if (api.port !== RUNTIME_API_PORT) {
      throw new Error(`API expected port ${RUNTIME_API_PORT}, got ${api.port}`);
    }
    const [worker, agent] = await Promise.all([spawnRole("worker"), spawnRole("agent")]);
    console.log(JSON.stringify({ ok: true, dataDir, processes: [api, worker, agent] }));
    await shutdown();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await shutdown().catch(() => {});
    app.exit(1);
  }
});
