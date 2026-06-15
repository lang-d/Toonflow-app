import type { Request, Response, NextFunction } from "express";
import { addStatusCompatibility } from "@/lib/taskStatus";
import { normalizeMediaResponse } from "@/services/mediaRef";

interface ApiEnvelope {
  code: number;
  data: unknown;
  message: string;
}

function isEnvelope(value: unknown): value is ApiEnvelope {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ApiEnvelope>;
  return typeof item.code === "number" && "data" in item && typeof item.message === "string";
}

function defaultMessage(statusCode: number): string {
  if (statusCode >= 500) return "服务器内部错误";
  if (statusCode >= 400) return "请求失败";
  return "成功";
}

export async function normalizePayload(body: unknown, statusCode: number): Promise<ApiEnvelope> {
  if (isEnvelope(body)) {
    return {
      code: statusCode >= 400 ? statusCode : body.code,
      data: addStatusCompatibility(await normalizeMediaResponse(body.data)),
      message: body.message || defaultMessage(statusCode),
    };
  }

  if (statusCode >= 400) {
    const objectBody = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    return {
      code: statusCode,
      data: addStatusCompatibility(await normalizeMediaResponse(objectBody?.data ?? null)),
      message: String(objectBody?.message ?? body ?? defaultMessage(statusCode)),
    };
  }

  return {
    code: statusCode,
    data: addStatusCompatibility(await normalizeMediaResponse(body ?? null)),
    message: defaultMessage(statusCode),
  };
}

export function apiContract(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith("/api/")) return next();

  const originalSend = res.send.bind(res);
  res.send = (async (body?: unknown) => {
    if (res.statusCode === 204 || Buffer.isBuffer(body) || body instanceof Uint8Array) {
      return originalSend(body as any);
    }
    const payload = await normalizePayload(body, res.statusCode);
    res.status(payload.code);
    res.type("application/json");
    return originalSend(JSON.stringify(payload));
  }) as unknown as Response["send"];

  next();
}
