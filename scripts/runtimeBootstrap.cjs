require("tsx/cjs");

const entry = process.env.TOONFLOW_RUNTIME_ENTRY;
if (!entry) {
  throw new Error("TOONFLOW_RUNTIME_ENTRY is required");
}

require(entry);
