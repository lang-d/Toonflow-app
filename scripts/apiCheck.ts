import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";

type HttpMethod = "get" | "post" | "put" | "delete" | "patch";

interface ApiCall {
  method: HttpMethod;
  route: string;
  file: string;
  line: number;
  dynamic: boolean;
}

interface BackendRoute {
  methods: Set<HttpMethod>;
  file: string;
}

const FRONTEND_PENDING_REMOVAL = new Map<string, string>([
  ["/scriptAgent/getPlanData", "Script Agent migration: frontend must switch to /scriptAgent/workspace/detail"],
  ["/scriptAgent/setPlanData", "Script Agent migration: frontend must switch to backend workspace APIs and stop XML full-workspace writeback"],
  ["/scriptAgent/updateData", "Script Agent migration: frontend must switch to backend workspace APIs and stop legacy workspace updates"],
  ["/production/music/stage/state", "Music module migration: frontend must switch to common Run, timeline, task snapshot, and music asset APIs"],
  ["/video/getVideo", "旧视频 store，改用 /production/workbench/getVideoList"],
  ["/video/getVideoConfigs", "旧视频 store，当前生产工作台不再使用"],
  ["/video/deleteVideoConfig", "旧视频 store，当前生产工作台不再使用"],
  ["/video/generateVideo", "旧视频 store，改用 /production/workbench/generateVideo"],
  ["/production/workbench/videoPolling", "旧轮询实现，改用 checkVideoStateList"],
  ["/project/getSingleProject", "旧项目路径，改用 /general/getSingleProject"],
  ["/setting/skillManagement/scanSkills", "前端遗留调用，后端无此能力"],
]);

const COMPATIBILITY_ALIASES = new Map<string, string>([
  ["/assets/polishAssetsPrompt", "/assetsGenerate/polishAssetsPrompt"],
  ["/assets/generateAssets", "/assetsGenerate/generateAssets"],
  ["/production/editImage/updateImageFlow", "/production/editImage/saveImageFlow"],
  ["/production/editImage/generateFlowImage", "/production/editImage/generateFlowImageTask"],
  ["/production/editImage/getAssetImageHistory", "/production/editImage/getImageHistory"],
  ["/production/assets/updateAssetsUrl", "/production/editImage/saveImageFlow"],
  ["/production/storyboard/updateStoryboardUrl", "/production/editImage/saveImageFlow"],
]);

const DYNAMIC_ALLOWLIST = new Map<string, string>([
  ["/setting/dreamina/${action}", "DreaminaCliPanel action 受后端固定 action 集合约束"],
]);

function routeFromFile(file: string, root: string): string {
  let route = path.relative(root, file).replace(/\\/g, "/").replace(/\.ts$/, "");
  route = route.replace(/\[([^\]]+)\]/g, (_, value: string) => (value.startsWith("...") ? "*" : `:${value}`));
  route = route === "index" ? "" : route.replace(/\/index$/, "");
  return `/${route}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

function scanFrontend(frontendRoot: string): ApiCall[] {
  const files = fg.sync(["src/**/*.{ts,tsx,vue}"], { cwd: frontendRoot, absolute: true });
  const calls: ApiCall[] = [];
  const pattern = /axios\.(get|post|put|delete|patch)\s*\(\s*(["'`])([^"'`]+)\2/g;

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const match of content.matchAll(pattern)) {
      const route = match[3].replace(/^\/api(?=\/)/, "");
      if (!route.startsWith("/")) continue;
      calls.push({
        method: match[1] as HttpMethod,
        route,
        file: path.relative(frontendRoot, file).replace(/\\/g, "/"),
        line: lineAt(content, match.index || 0),
        dynamic: route.includes("${"),
      });
    }
  }
  return calls;
}

function scanBackend(backendRoot: string): Map<string, BackendRoute> {
  const routesRoot = path.join(backendRoot, "src", "routes");
  const files = fg.sync(["**/*.ts"], { cwd: routesRoot, absolute: true });
  const routes = new Map<string, BackendRoute>();

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const methods = new Set<HttpMethod>();
    for (const match of content.matchAll(/router\.(get|post|put|delete|patch)\s*\(/g)) {
      methods.add(match[1] as HttpMethod);
    }
    if (!methods.size && /export\s*\{\s*default\s*\}\s*from/.test(content)) methods.add("post");
    routes.set(routeFromFile(file, routesRoot), {
      methods,
      file: path.relative(backendRoot, file).replace(/\\/g, "/"),
    });
  }
  return routes;
}

function routePatternMatches(pattern: string, route: string): boolean {
  const escaped = pattern
    .split("/")
    .map((part) => {
      if (part === "*") return ".*";
      if (part.startsWith(":")) return "[^/]+";
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return new RegExp(`^${escaped}$`).test(route);
}

function findBackendRoute(routes: Map<string, BackendRoute>, route: string): BackendRoute | undefined {
  const exact = routes.get(route);
  if (exact) return exact;
  for (const [pattern, item] of routes) {
    if ((pattern.includes(":") || pattern.includes("*")) && routePatternMatches(pattern, route)) return item;
  }
  return undefined;
}

function uniqueCalls(calls: ApiCall[]): ApiCall[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.method}:${call.route}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scanNakedMediaResponses(backendRoot: string): string[] {
  const files = fg.sync(["src/routes/**/*.ts", "src/services/**/*.ts"], { cwd: backendRoot, absolute: true });
  const issues: string[] = [];
  const pattern = /send\s*\(\s*success\s*\(\s*([A-Za-z_$][\w$]*(?:Url|URL)|url)\s*\)\s*\)/g;
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const match of content.matchAll(pattern)) {
      issues.push(
        `媒体契约禁止裸 URL 返回: ${path.relative(backendRoot, file).replace(/\\/g, "/")}:${lineAt(content, match.index || 0)} (${match[0]})`,
      );
    }
  }
  return issues;
}

const backendRoot = process.cwd();
const frontendRoot = path.resolve(process.env.TOONFLOW_WEB_DIR || path.join(backendRoot, "..", "Toonflow-web"));
if (!fs.existsSync(path.join(frontendRoot, "src"))) {
  throw new Error(`未找到前端源码目录: ${frontendRoot}。可通过 TOONFLOW_WEB_DIR 指定；正式 build 不依赖此目录。`);
}

const backendRoutes = scanBackend(backendRoot);
const frontendCalls = uniqueCalls(scanFrontend(frontendRoot));
const mediaContractIssues = scanNakedMediaResponses(backendRoot);
const unclassified: string[] = [];
const pendingRemoval: string[] = [];
const aliases: string[] = [];
const dynamic: string[] = [];
const contractRows: Array<Record<string, unknown>> = [];
let matched = 0;

for (const call of frontendCalls) {
  const source = `${call.file}:${call.line}`;
  if (call.dynamic) {
    const reason = DYNAMIC_ALLOWLIST.get(call.route);
    if (reason) {
      dynamic.push(`${call.method.toUpperCase()} ${call.route} (${reason})`);
      contractRows.push({ ...call, classification: "dynamic-allowlist", reason });
    } else {
      unclassified.push(`动态路径未分类: ${call.method.toUpperCase()} ${call.route} @ ${source}`);
      contractRows.push({ ...call, classification: "unclassified" });
    }
    continue;
  }

  const backend = findBackendRoute(backendRoutes, call.route);
  if (!backend) {
    const reason = FRONTEND_PENDING_REMOVAL.get(call.route);
    if (reason) {
      pendingRemoval.push(`${call.method.toUpperCase()} ${call.route} (${reason})`);
      contractRows.push({ ...call, classification: "frontend-pending-removal", reason });
    } else {
      unclassified.push(`后端路由缺失: ${call.method.toUpperCase()} ${call.route} @ ${source}`);
      contractRows.push({ ...call, classification: "unclassified" });
    }
    continue;
  }

  if (!backend.methods.has(call.method)) {
    unclassified.push(
      `HTTP 方法不一致: ${call.method.toUpperCase()} ${call.route} @ ${source}; backend=${[...backend.methods].join(",") || "unknown"} ${backend.file}`,
    );
    contractRows.push({ ...call, classification: "method-mismatch", backendFile: backend.file });
    continue;
  }

  matched += 1;
  const canonical = COMPATIBILITY_ALIASES.get(call.route);
  if (canonical) {
    aliases.push(`${call.method.toUpperCase()} ${call.route} -> ${canonical}`);
    contractRows.push({ ...call, classification: "compatibility-alias", canonical, backendFile: backend.file });
  } else {
    contractRows.push({ ...call, classification: "canonical", backendFile: backend.file });
  }
}

console.log(`API contract check: frontend=${frontendCalls.length}, backend=${backendRoutes.size}, matched=${matched}`);
console.log(`Compatibility aliases (${aliases.length}):`);
for (const item of [...new Set(aliases)].sort()) console.log(`  - ${item}`);
console.log(`Dynamic allowlist (${dynamic.length}):`);
for (const item of [...new Set(dynamic)].sort()) console.log(`  - ${item}`);
console.log(`Frontend pending removal (${pendingRemoval.length}):`);
for (const item of [...new Set(pendingRemoval)].sort()) console.log(`  - ${item}`);

if (unclassified.length) {
  console.error(`Unclassified API drift (${unclassified.length}):`);
  for (const item of unclassified.sort()) console.error(`  - ${item}`);
  process.exitCode = 1;
} else {
  console.log("API contract check passed: no unclassified drift.");
}

if (mediaContractIssues.length) {
  console.error(`Media contract violations (${mediaContractIssues.length}):`);
  for (const item of mediaContractIssues.sort()) console.error(`  - ${item}`);
  process.exitCode = 1;
} else {
  console.log("Media contract check passed: no naked media URL responses.");
}

if (process.argv.includes("--write")) {
  const outputPath = path.join(backendRoot, "docs", "api-contract-inventory.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        frontendRoot,
        totals: {
          frontend: frontendCalls.length,
          backend: backendRoutes.size,
          matched,
          compatibilityAliases: new Set(aliases).size,
          dynamicAllowlist: new Set(dynamic).size,
          frontendPendingRemoval: new Set(pendingRemoval).size,
          unclassified: unclassified.length,
        },
        contracts: contractRows.sort((a, b) => String(a.route).localeCompare(String(b.route))),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`API contract inventory written: ${path.relative(backendRoot, outputPath)}`);
}
