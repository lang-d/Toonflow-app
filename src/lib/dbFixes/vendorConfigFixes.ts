import fs from "fs";
import path from "path";
import { transform } from "sucrase";
import { VM } from "vm2";
import type { Knex } from "knex";
import rawVendorData from "@/lib/vendor.json";
import getPath from "@/utils/getPath";

const vendorData = rawVendorData as Record<string, string>;

function getVendorFile(id: string | number) {
  return path.join(getPath("vendor"), `${id}.ts`);
}

function writeVendorCode(id: string | number, tsCode: string) {
  const rootDir = getPath("vendor");
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(getVendorFile(id), tsCode);
}

function getVendorVersion(id: string) {
  const file = getVendorFile(id);
  if (!fs.existsSync(file)) return "0";
  const code = fs.readFileSync(file, "utf8");
  return code.match(/\bversion\s*:\s*["']([^"']+)["']/)?.[1] || "0";
}

function compareVersion(a?: string | number, b?: string | number) {
  const left = String(a ?? "0").split(/[^\d]+/).map((item) => Number(item) || 0);
  const right = String(b ?? "0").split(/[^\d]+/).map((item) => Number(item) || 0);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function readVendorFromCode(tsCode: string) {
  const jsCode = transform(tsCode, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
  const exports: Record<string, any> = {};
  new VM({
    sandbox: {
      exports,
      logger: () => {},
      fetch: async () => {
        throw new Error("fixDB vendor metadata sandbox does not allow fetch");
      },
    },
    timeout: 1000,
    eval: false,
    wasm: false,
  }).run(jsCode);
  return exports.vendor;
}

export async function syncDefaultVendorConfigs(knex: Knex) {
  if (!(await knex.schema.hasTable("o_vendorConfig"))) return;

  for (const [filename, tsCode] of Object.entries(vendorData)) {
    if (!filename.endsWith(".ts") || !tsCode) continue;
    const vendor = readVendorFromCode(tsCode);
    const id = vendor?.id || filename.replace(/\.ts$/, "");
    const currentVersion = getVendorVersion(id);
    const existing = await knex("o_vendorConfig").where("id", id).first();
    const defaultModelList = Array.isArray(vendor?.models) ? vendor.models : [];
    const defaultModels = JSON.stringify(defaultModelList);
    const shouldUpdateCode = compareVersion(vendor?.version, currentVersion) > 0;
    const shouldUpdateModels = defaultModelList.length > 0 && existing?.models !== defaultModels;

    if (!existing) {
      await knex("o_vendorConfig").insert({
        id,
        inputValues: JSON.stringify(vendor?.inputValues ?? {}),
        models: defaultModels,
        enable: id == "toonflow" ? 1 : 0,
      });
      writeVendorCode(id, tsCode);
      continue;
    }

    if (!shouldUpdateCode && !shouldUpdateModels) continue;
    writeVendorCode(id, tsCode);
    if (shouldUpdateModels) {
      await knex("o_vendorConfig").where("id", id).update({ models: defaultModels });
    }
  }
}

export async function materializeVendorCodeFiles(knex: Knex) {
  if (!(await knex.schema.hasTable("o_vendorConfig"))) return;
  const rows = await knex("o_vendorConfig").select("*");
  for (const item of rows) {
    let { id, code } = item;
    const filename = `${id}.ts`;
    const rootDir = getPath("vendor");
    if (!code && fs.existsSync(path.join(rootDir, filename))) continue;
    if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
    if (!fs.existsSync(path.join(rootDir, filename))) {
      code = vendorData[filename] || code;
      code = code ?? "";
      fs.writeFileSync(path.join(rootDir, filename), code);
    }
  }
}

export async function insertDefaultVendorIfMissing(knex: Knex, tsCode: string) {
  if (!(await knex.schema.hasTable("o_vendorConfig"))) return;
  const vendor = readVendorFromCode(tsCode);
  if (!vendor?.id) return;
  const data = await knex("o_vendorConfig").where("id", vendor.id).first();
  if (data) return;
  await knex("o_vendorConfig").insert({
    id: vendor.id,
    inputValues: JSON.stringify(vendor.inputValues ?? {}),
    models: JSON.stringify(vendor.models ?? []),
    enable: vendor.id == "toonflow" ? 1 : 0,
  });
  writeVendorCode(vendor.id, tsCode);
}

export async function fixVendorConfigs(knex: Knex) {
  await materializeVendorCodeFiles(knex);
  await syncDefaultVendorConfigs(knex);
}
