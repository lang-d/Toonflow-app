import { readFile, writeFile } from "fs/promises";
import getPath from "@/utils/getPath";
import fs from "fs";
import path from "path";
import knex from "knex";
import initDB from "@/lib/initDB";
// import fixDB from "@/lib/fixDB";
import type { DB } from "@/types/database";
import crypto from "crypto";
import fixDB from "@/lib/fixDB";
import {
  PROFILE_TABLES,
  profileDatabasePath,
  storageMode,
  workspaceDatabasePath,
} from "@/services/storagePaths";
import { createLogger } from "@/logger";

type TableName = keyof DB & string;
type RowType<TName extends TableName> = DB[TName];
type SlowQuery = {
  sql: string;
  durationMs: number;
  role: string;
  at: number;
};

const queryStartedAt = new Map<string, number>();
const dbDiagnostics = {
  queryCount: 0,
  queryTotalMs: 0,
  slowQueryCount: 0,
  busyCount: 0,
  transactionCount: 0,
  transactionTotalMs: 0,
  slowTransactions: 0,
  recentSlowQueries: [] as SlowQuery[],
};
const dbLog = createLogger("db");

function runtimeRole() {
  return process.env.TOONFLOW_RUNTIME_ROLE || "main";
}

function busyTimeoutMs() {
  if (runtimeRole() === "api") return 5000;
  if (runtimeRole() === "worker") return 5000;
  return 2000;
}

function queryKey(query: any) {
  return String(query?.__knexQueryUid || query?.queryContext?.__knexQueryUid || "");
}

function summarizeSql(sql: unknown) {
  return String(sql || "")
    .replace(/\s+/g, " ")
    .slice(0, 2000);
}

export function getDbDiagnostics() {
  return {
    ...dbDiagnostics,
    role: runtimeRole(),
    averageQueryMs:
      dbDiagnostics.queryCount === 0
        ? 0
        : Number((dbDiagnostics.queryTotalMs / dbDiagnostics.queryCount).toFixed(2)),
    averageTransactionMs:
      dbDiagnostics.transactionCount === 0
        ? 0
        : Number((dbDiagnostics.transactionTotalMs / dbDiagnostics.transactionCount).toFixed(2)),
    recentSlowQueries: [...dbDiagnostics.recentSlowQueries],
  };
}

const dbPath = workspaceDatabasePath();
dbLog.info("Database path resolved", { event: "db.path", path: dbPath });
const dbDir = path.dirname(dbPath);
const splitStorage = storageMode() === "workspace";
const profilePath = profileDatabasePath();

// 确保数据库目录存在
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// 创建空数据库文件
if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, "");
}
if (splitStorage) {
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  if (!fs.existsSync(profilePath)) fs.writeFileSync(profilePath, "");
}

function escapeSqlitePath(value: string) {
  return value.replace(/'/g, "''");
}

const profileDb = splitStorage
  ? knex({
      client: "better-sqlite3",
      connection: { filename: profilePath },
      pool: {
        afterCreate(connection: any, done: (error: Error | null, connection: any) => void) {
          try {
            connection.pragma("journal_mode = WAL");
            connection.pragma("synchronous = NORMAL");
            connection.pragma("busy_timeout = 2000");
            done(null, connection);
          } catch (error) {
            done(error as Error, connection);
          }
        },
      },
      useNullAsDefault: true,
    })
  : null;

const db = knex({
  client: "better-sqlite3",
  connection: {
    filename: dbPath,
  },
  pool: {
    afterCreate(connection: any, done: (error: Error | null, connection: any) => void) {
      try {
        connection.pragma("journal_mode = WAL");
        connection.pragma("synchronous = NORMAL");
        connection.pragma(`busy_timeout = ${busyTimeoutMs()}`);
        if (splitStorage) connection.exec(`ATTACH DATABASE '${escapeSqlitePath(profilePath)}' AS profile`);
        done(null, connection);
      } catch (error) {
        done(error as Error, connection);
      }
    },
  },
  useNullAsDefault: true,
});

db.on("query", (query: any) => {
  const key = queryKey(query);
  if (key) queryStartedAt.set(key, performance.now());
});
db.on("query-response", (_response: unknown, query: any) => {
  const key = queryKey(query);
  const startedAt = key ? queryStartedAt.get(key) : undefined;
  if (key) queryStartedAt.delete(key);
  const durationMs = startedAt == null ? 0 : performance.now() - startedAt;
  dbDiagnostics.queryCount += 1;
  dbDiagnostics.queryTotalMs += durationMs;
  if (durationMs >= 50) {
    dbDiagnostics.slowQueryCount += 1;
    dbDiagnostics.recentSlowQueries.push({
      sql: summarizeSql(query?.sql),
      durationMs: Number(durationMs.toFixed(2)),
      role: runtimeRole(),
      at: Date.now(),
    });
    dbDiagnostics.recentSlowQueries.splice(0, Math.max(0, dbDiagnostics.recentSlowQueries.length - 50));
    dbLog.warn("Slow database query", {
      event: "db.slow-query",
      durationMs: Number(durationMs.toFixed(2)),
      sql: summarizeSql(query?.sql),
      role: runtimeRole(),
    });
  }
});
db.on("query-error", (error: any, query: any) => {
  const key = queryKey(query);
  if (key) queryStartedAt.delete(key);
  if (String(error?.code || error?.message).includes("SQLITE_BUSY")) {
    dbDiagnostics.busyCount += 1;
    dbLog.warn("SQLite busy", {
      event: "db.sqlite-busy",
      sql: summarizeSql(query?.sql),
      role: runtimeRole(),
      error,
    });
  }
});

export const dbReady =
  process.env.TOONFLOW_SKIP_DB_INIT === "1"
    ? Promise.resolve()
    : (async () => {
        if (profileDb) await initDB(profileDb, false, { includeTables: PROFILE_TABLES });
        await initDB(db, false, splitStorage ? { excludeTables: PROFILE_TABLES } : {});
        await fixDB(db);
        if (process.env.NODE_ENV == "dev" && !splitStorage) await initKnexType(db);
      })();

const dbClient = Object.assign(<TName extends TableName>(table: TName) => db<RowType<TName>, RowType<TName>[]>(table), db);
dbClient.schema = db.schema;
const rawTransaction = db.transaction.bind(db);
(dbClient as any).transaction = async (...args: any[]) => {
  const startedAt = performance.now();
  try {
    return await rawTransaction(...args);
  } finally {
    const durationMs = performance.now() - startedAt;
    dbDiagnostics.transactionCount += 1;
    dbDiagnostics.transactionTotalMs += durationMs;
    if (durationMs >= 100) {
      dbDiagnostics.slowTransactions += 1;
      dbLog.warn("Slow database transaction", {
        event: "db.slow-transaction",
        durationMs: Number(durationMs.toFixed(2)),
        role: runtimeRole(),
      });
    }
  }
};
(dbClient as any).destroy = async () => {
  await db.destroy();
  await profileDb?.destroy();
};
export default dbClient;

export { db };

async function initKnexType(knexDb: any) {
  const { Client } = await import("@rmp135/sql-ts");
  const outFile = "src/types/database.d.ts";
  const dbClient = Client.fromConfig({
    interfaceNameFormat: "${table}",
    typeMap: {
      number: ["bigint"],
      string: ["text", "varchar", "char"],
    },
  }).fetchDatabase(knexDb);
  const declarations = await dbClient.toTypescript();
  const dbObject = await dbClient.toObject();
  const customHeader = `//该文件由脚本自动生成，请勿手动修改`;
  // 清除上次的注释头
  let declBody = declarations.replace(/^\/\*[\s\S]*?\*\/\s*/, "");
  declBody = declBody.replace(/(\n\s*)\/\*([^*][\s\S]*?)\*\//g, "$1/**$2*/");
  const tableInterfaces = dbObject.schemas.flatMap((schema) => schema.tables.map((table) => table.interfaceName));
  const aggregateTypes = `
export interface DB {
${tableInterfaces.map((name) => `  ${JSON.stringify(name)}: ${name};`).join("\n")}
}
`;
  // 哈希仅基于结构化信息，header和空格不算
  const hashSource = JSON.stringify({
    tableInterfaces,
    declBody,
  });
  const hash = crypto.createHash("md5").update(hashSource).digest("hex");
  // 文件内容
  const content = `// @db-hash ${hash}\n${customHeader}\n\n` + declBody + aggregateTypes;
  let needWrite = true;
  try {
    const current = await readFile(outFile, "utf8");
    // 文件头已存在相同 hash，不需要写
    const match = current.match(/^\/\/\s*@db-hash\s*([a-zA-Z0-9]+)\n/);
    const currentHash = match ? match[1] : null;
    if (currentHash === hash) {
      needWrite = false;
    }
  } catch (err) {
    needWrite = true;
  }
  if (needWrite) await writeFile(outFile, content, "utf8");
}
