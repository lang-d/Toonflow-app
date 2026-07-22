import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import generateRouter from "../src/core";

// 打包默认使用 prod 环境变量
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "prod";
}

const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));

const external = [
  "electron",
  "@huggingface/transformers",
  "onnxruntime-node",
  "vm2",
  "sqlite3",
  "better-sqlite3",
  "sharp",
  "ffmpeg-static",
  "ffprobe-static",
  "mysql",
  "mysql2",
  "pg",
  "pg-query-stream",
  "oracledb",
  "tedious",
  "mssql",
  "tsx/cjs",
];

const packagedModuleResolverBanner = `
(() => {
  try {
    const path = require("node:path");
    const Module = require("node:module");
    const resourcesPath = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
    if (!resourcesPath) return;
    const extraPaths = [
      path.join(resourcesPath, "app.asar", "node_modules"),
      path.join(resourcesPath, "app.asar.unpacked", "node_modules"),
    ];
    const existingPaths = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [];
    process.env.NODE_PATH = [...new Set([...extraPaths, ...existingPaths].filter(Boolean))].join(path.delimiter);
    Module._initPaths();
  } catch {
  }
})();
`;

// 后端服务打包配置
const appBuildConfig: esbuild.BuildOptions = {
  entryPoints: ["src/app.ts"],
  bundle: true,
  minify: false,
  format: "cjs",
  allowOverwrite: true,
  outfile: "data/serve/app.js",
  platform: "node",
  target: "esnext",
  tsconfig: "./tsconfig.json",
  alias: {
    "@": "./src",
  },
  sourcemap: false,
  external,
  banner: {
    js: packagedModuleResolverBanner,
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
};

// Electron 主进程打包配置
const mainBuildConfig: esbuild.BuildOptions = {
  entryPoints: ["scripts/main.ts"],
  bundle: true,
  minify: false,
  format: "cjs",
  outfile: "build/main.js",
  allowOverwrite: true,
  platform: "node",
  target: "esnext",
  tsconfig: "./tsconfig.json",
  alias: {
    "@": "./src",
  },
  sourcemap: false,
  external,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
};

const runtimeBuildConfig: esbuild.BuildOptions = {
  entryPoints: {
    "api-process": "src/runtime/apiProcess.ts",
    "task-worker": "src/runtime/taskWorker.ts",
    "agent-process": "src/runtime/agentProcess.ts",
  },
  bundle: true,
  minify: false,
  format: "cjs",
  outdir: "data/serve/runtime",
  allowOverwrite: true,
  platform: "node",
  target: "esnext",
  tsconfig: "./tsconfig.json",
  alias: {
    "@": "./src",
  },
  sourcemap: false,
  external,
  banner: {
    js: packagedModuleResolverBanner,
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
};

(async () => {
  try {
    console.log("🔨 开始构建...\n");

    await generateRouter();

    // 并行构建
    await Promise.all([esbuild.build(appBuildConfig), esbuild.build(mainBuildConfig), esbuild.build(runtimeBuildConfig)]);

    console.log("✅ 后端服务构建完成: data/serve/app.js");
    console.log("✅ Electron 主进程构建完成: build/main.js");
    console.log("\n🎉 所有构建任务完成!\n");
  } catch (err) {
    console.error("❌ 构建失败:", err);
    process.exit(1);
  }
})();
