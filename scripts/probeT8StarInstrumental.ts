import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import axios from "axios";
import sqlite3 from "sqlite3";
import { transform } from "sucrase";
import { VM } from "vm2";
import { probeAudioDurationMs } from "../src/services/musicAudioMetadata";

function readVendorConfig(dbPath: string) {
  return new Promise<any>((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openError) => {
      if (openError) {
        reject(openError);
        return;
      }
      db.get("select inputValues from o_vendorConfig where id = ? and enable = 1", ["t8star"], (error, row: any) => {
        db.close();
        if (error) reject(error);
        else if (!row) reject(new Error("Enabled T8Star configuration was not found"));
        else resolve(JSON.parse(row.inputValues || "{}"));
      });
    });
  });
}

async function pollTask(fn: () => Promise<any>, interval = 5000, timeout = 50 * 60 * 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result?.completed || result?.error) return result;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return { completed: true, error: "Controlled T8Star probe timed out" };
}

async function main() {
  const dbPath = process.env.TOONFLOW_T8STAR_DB?.trim();
  if (!dbPath) throw new Error("TOONFLOW_T8STAR_DB is required");
  const inputValues = await readVendorConfig(path.resolve(dbPath));
  const source = fs.readFileSync(path.resolve("data", "vendor", "t8star.ts"), "utf8");
  const jsCode = transform(source, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
  const exports: Record<string, any> = {};
  new VM({
    sandbox: {
      exports,
      axios,
      logger: (message: unknown) => console.log(String(message)),
      pollTask,
      urlToBase64: async (url: string) => url,
      createOpenAI: () => ({ chat: () => ({}) }),
    },
  }).run(jsCode);
  Object.assign(exports.vendor.inputValues, inputValues);
  const model = exports.vendor.models.find((item: any) => item.type === "music" && item.modelName === "chirp-fenix");
  if (!model) throw new Error("T8Star chirp-fenix model is not available in the runtime adapter");

  const audioUrl = await exports.musicRequest(
    {
      prompt: "",
      title: "Toonflow Instrumental Protocol Probe",
      tags: "instrumental, minimal piano, restrained, no vocals",
      vocalMode: "instrumental",
    },
    model,
  );
  const response = await axios.get(audioUrl, { responseType: "arraybuffer", timeout: 120000 });
  const outputPath = path.join(os.tmpdir(), `toonflow-t8star-instrumental-${Date.now()}.mp3`);
  fs.writeFileSync(outputPath, Buffer.from(response.data));
  const durationMs = await probeAudioDurationMs(outputPath);
  console.log(JSON.stringify({ outputPath, durationMs, durationSec: Math.round(durationMs / 1000), withinDeclaredMaximum: durationMs <= 481000 }));
  if (durationMs > 481000) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
