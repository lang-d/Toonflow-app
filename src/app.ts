// import "./logger";
import "./err";
import "./env";
import express, { Request, Response, NextFunction } from "express";
import { Server } from "socket.io";
import http from "node:http";
import expressWs from "express-ws";
import logger from "morgan";
import cors from "cors";
import { randomUUID } from "node:crypto";
import buildRoute from "@/core";
import path from "path";
import fs from "fs";
import u from "@/utils";
import jwt from "jsonwebtoken";
import socketInit from "@/socket/index";
import { isEletron } from "@/utils/getPath";
import { isThumbnailImagePath, ThumbnailSize } from "@/utils/image";
import { apiContract } from "@/middleware/apiContract";
import { dbReady } from "@/utils/db";
import { startVideoGenerationQueue, stopVideoGenerationQueue } from "@/utils/videoGenerationQueue";
import { getTokenKey } from "@/services/authToken";
import { enqueueThumbnail } from "@/services/thumbnailQueue";
import { RUNTIME_API_HOST, RUNTIME_API_PORT } from "@/runtime/runtimeProtocol";
import {
  cacheDataPath,
  resolveThumbnailFilePath,
  storageMode,
} from "@/services/storagePaths";
import { isStorageMaintenanceActive } from "@/services/storageMigration";
import { initLogger, createLogger } from "@/logger";

const app = express();
const server = http.createServer(app);
let startPromise: Promise<number> | null = null;
initLogger({ role: process.env.TOONFLOW_RUNTIME_ROLE || "api", hijackConsole: true });
const apiLog = createLogger("api");

async function checkPermissions() {
  if (!isEletron()) return true;
  const userDataPath = u.getPath();
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    const testFile = path.join(userDataPath, ".access_test");
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);
  } catch (e) {
    const { dialog, app } = require("electron");
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "权限不足",
      message: "应用无法访问数据目录",
      detail: `无法读写以下目录：\n${userDataPath}\n\n请联系管理员授予权限，或以管理员身份运行本程序。`,
      buttons: ["确认退出"],
      defaultId: 0,
    });
    if (response === 0) {
      app.quit();
    }
  }
}

async function startServeOnce(options: { startQueue?: boolean; portRetryMs?: number } = {}) {
  process.env.PORT = String(RUNTIME_API_PORT);
  await checkPermissions();
  await dbReady;
  if (options.startQueue !== false) startVideoGenerationQueue();

  await u.writeVersion();
  const io = new Server(server, { cors: { origin: "*" } });
  socketInit(io);

  if (process.env.NODE_ENV == "dev") await buildRoute();

  expressWs(app);

  if (process.env.NODE_ENV === "dev") app.use(logger("dev"));
  app.use(cors({ origin: "*" }));
  app.use((req, res, next) => {
    const requestId = String(req.headers["x-request-id"] || randomUUID());
    (req as any).requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    const startedAt = performance.now();
    res.on("finish", () => {
      if (!req.path.startsWith("/api/")) return;
      apiLog.info("HTTP request completed", {
        event: "http.request",
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
      });
    });
    next();
  });
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ extended: true, limit: "100mb" }));
  app.use(apiContract);
  app.use((req, res, next) => {
    if (
      isStorageMaintenanceActive() &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !req.path.startsWith("/api/task/status/") &&
      req.path !== "/api/setting/storage/status"
    ) {
      return res.status(503).send({
        code: 503,
        data: { maintenance: true },
        message: "Workspace migration is in progress",
      });
    }
    next();
  });

  // oss 静态资源
  const ossDir = u.getPath("oss");
  if (!fs.existsSync(ossDir)) {
    fs.mkdirSync(ossDir, { recursive: true });
  }
  const localMediaSendOptions = {
    acceptRanges: false,
    etag: false,
    lastModified: false,
    cacheControl: true,
    setHeaders(res: Response) {
      res.setHeader("Cache-Control", "no-store");
    },
  };
  const sendOssFile = async (req: Request, res: Response, next: NextFunction) => {
    if (storageMode() !== "workspace") {
      express.static(ossDir, localMediaSendOptions)(req, res, next);
      return;
    }
    try {
      const filePath = await u.oss.getLocalFilePath(req.path.replace(/^[/\\]+/, ""));
      res.sendFile(filePath, localMediaSendOptions);
    } catch {
      next();
    }
  };
  apiLog.info("OSS directory ready", { event: "static.oss", path: ossDir });
  app.use(
    "/oss",
    async (req, res, next) => {
      // 如果传参 type=small，则返回小图
      if (req.query.size) {
        const size = req.query.size as string;
        const smallImageBaseDir =
          storageMode() === "workspace" ? cacheDataPath("thumbnails") : path.join(ossDir, "smallImage");
        let originalPath: string;
        try {
          originalPath = await u.oss.getLocalFilePath(req.path.replace(/^[/\\]+/, ""));
        } catch {
          next();
          return;
        }
        if (!isThumbnailImagePath(originalPath)) {
          next();
          return;
        }

        // 解析 size 参数
        let sizeSubDir: string;
        let sizeOpts: ThumbnailSize | undefined;

        // 判断是否为 WIDTHxHEIGHT 格式，如 "200x300"：等比压缩到指定宽高边界
        const dimensMatch = size.match(/^(\d+)x(\d+)$/i);
        // 判断是否为百分比格式，如 "30"、"30%"：等比压缩到原图的指定百分比
        const percentMatch = size.match(/^(\d+(?:\.\d+)?)\s*%?$/);

        if (dimensMatch) {
          const w = parseInt(dimensMatch[1], 10);
          const h = parseInt(dimensMatch[2], 10);
          sizeSubDir = `${w}x${h}`;
          sizeOpts = { type: "dimensions", width: w, height: h };
        } else if (percentMatch) {
          const pct = parseFloat(percentMatch[1]);
          sizeSubDir = `${percentMatch[1]}p`;
          sizeOpts = { type: "percentage", value: pct };
        } else {
          // 无效的 size 参数，降级返回原图
          await sendOssFile(req, res, next);
          return;
        }

        const ext = path.extname(req.path);
        const base = path.basename(req.path, ext);
        const dir = path.dirname(req.path);
        const smallImagePath =
          storageMode() === "workspace"
            ? resolveThumbnailFilePath(req.path, sizeSubDir)
            : path.join(smallImageBaseDir, dir, `${base}_${sizeSubDir}${ext}`);

        if (fs.existsSync(smallImagePath)) {
          res.sendFile(smallImagePath, localMediaSendOptions);
          return;
        }
        const originalRelativePath = req.path.replace(/^[/\\]+/, "");
        const thumbnailRelativePath = path
          .relative(storageMode() === "workspace" ? smallImageBaseDir : ossDir, smallImagePath)
          .split(path.sep)
          .join("/");
        void enqueueThumbnail({
          originalPath: originalRelativePath,
          thumbnailPath: thumbnailRelativePath,
          size: sizeOpts,
        }).catch((cause) => apiLog.warn("Thumbnail enqueue failed", { event: "thumbnail.enqueue.failed", error: cause }));
        res.sendFile(originalPath, localMediaSendOptions);
        return;
      }
      next();
    },
    sendOssFile,
  );
  // skills 静态资源
  const skillsDir = u.getPath("skills");
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }
  apiLog.info("Skills directory ready", { event: "static.skills", path: skillsDir });
  // 只允许图片文件访问
  app.use(
    "/skills",
    (req, res, next) => {
      /\.(jpe?g|png|gif|webp|svg|ico|bmp)$/i.test(req.path) ? next() : res.status(403).end();
    },
    express.static(skillsDir, { acceptRanges: false }),
  );

  // assets 静态资源
  const assetsDir = u.getPath("assets");
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }
  apiLog.info("Assets directory ready", { event: "static.assets", path: assetsDir });
  app.use("/assets", express.static(assetsDir, { acceptRanges: false }));

  // data/web 静态网站
  const webDir = u.getPath("web");
  if (fs.existsSync(webDir)) {
    apiLog.info("Static web directory ready", { event: "static.web", path: webDir });
    app.use(express.static(webDir, { acceptRanges: false }));
  } else {
    apiLog.warn("Static web directory missing", { event: "static.web.missing", path: webDir });
  }

  app.use(async (req, res, next) => {
    const tokenKey = await getTokenKey();
    if (!tokenKey) return res.status(444).send({ message: "服务器密钥未配置，请联系管理员" });
    // 从 header 或 query 参数获取 token
    const rawToken = req.headers.authorization || (req.query.token as string) || "";
    const token = rawToken.replace("Bearer ", "");
    // 白名单路径
    if (req.path === "/api/login/login") return next();

    if (!token) return res.status(401).send({ message: "未提供 token" });
    try {
      const decoded = jwt.verify(token, tokenKey);
      (req as any).user = decoded;
      next();
    } catch (err) {
      return res.status(401).send({ message: "无效的 token" });
    }
  });

  const router = require("@/router") as typeof import("@/router");
  await router.default(app);

  // 404 处理
  app.use((_, res, next: NextFunction) => {
    return res.status(404).send({ message: "API 404 Not Found" });
  });

  // 错误处理
  app.use((err: any, _: Request, res: Response, __: NextFunction) => {
    res.locals.message = err.message;
    res.locals.error = err;
    apiLog.error("Unhandled API error", { event: "http.error", error: err });
    res.status(err.status || 500).send(err);
  });

  const retryDeadline = Date.now() + Math.max(0, options.portRetryMs ?? 0);
  return await new Promise<number>((resolve, reject) => {
    const listen = () => {
      const onError = (cause: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (cause.code === "EADDRINUSE" && Date.now() < retryDeadline) {
          const remainingMs = Math.max(0, retryDeadline - Date.now());
          apiLog.warn("API port is in use; retrying", {
            event: "api.port-retry",
            host: RUNTIME_API_HOST,
            port: RUNTIME_API_PORT,
            remainingSec: Math.ceil(remainingMs / 1000),
          });
          setTimeout(listen, Math.min(1_000, remainingMs || 1_000));
          return;
        }
        reject(cause);
      };
      const onListening = () => {
        server.off("error", onError);
        apiLog.info("API server listening", { event: "api.listening", host: RUNTIME_API_HOST, port: RUNTIME_API_PORT });
        resolve(RUNTIME_API_PORT);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(RUNTIME_API_PORT, RUNTIME_API_HOST);
    };
    listen();
  });
}

export default function startServe(options: { startQueue?: boolean; portRetryMs?: number } = {}) {
  if (!startPromise) {
    startPromise = startServeOnce(options).catch((error) => {
      startPromise = null;
      throw error;
    });
  }
  return startPromise;
}

// 支持await关闭
export async function closeServe(): Promise<void> {
  await stopVideoGenerationQueue();
  return new Promise((resolve, reject) => {
    if (server) {
      server.close((err?: Error) => {
        if (err) return reject(err);
        startPromise = null;
        apiLog.info("API server closed", { event: "api.closed" });
        resolve();
      });
    } else {
      resolve();
    }
  });
}

const isElectron = typeof process.versions?.electron !== "undefined";
if (!isElectron && process.env.TOONFLOW_UTILITY !== "1") startServe();
