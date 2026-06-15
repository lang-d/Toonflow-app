import jwt from "jsonwebtoken";
import db from "@/utils/db";

let cachedTokenKey = "";
let expiresAt = 0;

export function invalidateTokenKeyCache() {
  cachedTokenKey = "";
  expiresAt = 0;
}

export async function getTokenKey() {
  if (cachedTokenKey && Date.now() < expiresAt) return cachedTokenKey;
  const setting = await (db as any)("o_setting").where("key", "tokenKey").select("value").first();
  cachedTokenKey = String(setting?.value || "");
  expiresAt = Date.now() + 60_000;
  return cachedTokenKey;
}

export async function verifyAuthToken(rawToken: string) {
  const tokenKey = await getTokenKey();
  if (!tokenKey || !rawToken) return false;
  try {
    jwt.verify(rawToken.replace("Bearer ", ""), tokenKey);
    return true;
  } catch {
    return false;
  }
}
