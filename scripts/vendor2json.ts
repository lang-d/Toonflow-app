import fs from "fs";
import path from "path";

const vendorDir = path.join("data", "vendor");
const runtimeVendorJson = path.join("src", "lib", "vendor.json");
const files = fs.readdirSync(vendorDir).filter((f) => f.endsWith(".ts"));
const result: Record<string, string> = {};
for (const file of files) {
  result[file] = fs.readFileSync(path.join(vendorDir, file), "utf-8");
}
const serialized = JSON.stringify(result, null, 2);
fs.writeFileSync(runtimeVendorJson, serialized, "utf-8");
console.log("Done, saved vendor.json");
