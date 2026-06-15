import { transform } from "sucrase";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import u from "@/utils";
import { addQueueConfigCompatibility } from "@/lib/videoQueueConfig";

const runtimeCache = new Map<string, { signature: string; exports: Record<string, any> }>();
const modelCache = new Map<string, { expiresAt: number; models: any[] }>();

export function invalidateCache(id?: string | number) {
  if (id == null) {
    runtimeCache.clear();
    modelCache.clear();
    return;
  }
  const prefix = `${id}:`;
  for (const key of runtimeCache.keys()) if (key.startsWith(prefix)) runtimeCache.delete(key);
  modelCache.delete(String(id));
}

export function writeCode(id: string | number, tsCode: string) {
  const rootDir = u.getPath("vendor")
  fs.mkdirSync(rootDir, { recursive: true })
  if (fs.existsSync(path.join(rootDir,  `${id}.ts`))) {
    fs.writeFileSync(path.join(rootDir,  `${id}.ts`), tsCode);
  }
  fs.writeFileSync(path.join(rootDir,  `${id}.ts`), tsCode);
  invalidateCache(id);
}

export function getCode(id: string): string {
  const rootDir = u.getPath("vendor");
  const targetFile = path.join(rootDir, `${id}.ts`);
  if (!fs.existsSync(targetFile)) return "";
  return fs.readFileSync(targetFile, "utf-8");
}

export async function getModelList(id: string): Promise<Array<any>> {
  const cached = modelCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return JSON.parse(JSON.stringify(cached.models));
  const models = await u.db("o_vendorConfig").where("id", id).select("models").first();
  if (!models || !models.models) return [];
  if (id === "dreamina") {
    const result = JSON.parse(models.models ?? "[]").map(addQueueConfigCompatibility);
    modelCache.set(id, { expiresAt: Date.now() + 15_000, models: result });
    return JSON.parse(JSON.stringify(result));
  }
  const vendorData = getRuntime(id);
  if(!vendorData || !vendorData.vendor || !vendorData.vendor.models) return [];
  const combined = [...JSON.parse(JSON.stringify(vendorData.vendor.models)), ...JSON.parse(models?.models ?? "[]")];
  const map = new Map<string, any>();
  for (const m of combined) {
    map.set(m.modelName, m);
  }
  const result = [...map.values()];
  modelCache.set(id, { expiresAt: Date.now() + 15_000, models: result });
  return JSON.parse(JSON.stringify(result));
}

export function getRuntime(id: string, variant = "base") {
  const code = getCode(id);
  const signature = crypto.createHash("sha1").update(code).digest("hex");
  const key = `${id}:${variant}`;
  const cached = runtimeCache.get(key);
  if (cached?.signature === signature) return cached.exports;
  const jsCode = transform(code, { transforms: ["typescript"] }).code;
  const exports = u.vm(jsCode);
  runtimeCache.set(key, { signature, exports });
  return exports;
}

export function getVendor(id: string) {
  return getRuntime(id).vendor;
}
