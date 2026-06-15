import isPathInside from "is-path-inside";
import path from "path";
import { getDataPath } from "@/services/storagePaths";

export default (fileName?: string[] | string) => {
  const basePath = getDataPath();
  if (fileName) {
    const dbPath = getDataPath(fileName);
    const allowedRoots = [basePath, getDataPath("oss"), getDataPath("models"), getDataPath("serve"), getDataPath("web")];
    if (!allowedRoots.some((root) => dbPath === root || isPathInside(dbPath, root))) {
      throw new Error("路径逃逸错误，路径必须在数据目录内");
    }
    return dbPath;
  }
  return basePath;
};

export function isEletron() {
  if (typeof process.versions?.electron !== "undefined" && process.env.TOONFLOW_UTILITY !== "1") {
    const { app } = require("electron");
    return true;
  } else {
    return false;
  }
}
