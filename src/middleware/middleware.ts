import { Request, Response, NextFunction } from "express";
import { z, ZodTypeAny } from "zod";
import { error } from "@/lib/responseFormat";
import { createLogger } from "@/logger";

import { zhCN } from "zod/locales";

z.config(zhCN());

const validationLog = createLogger("validation");

export function validateFields(
  shape: Record<string, ZodTypeAny>,
  source: "body" | "query" | "params" = "body", // 默认校验 body
) {
  const schema = z.object(shape);

  return (req: Request, res: Response, next: NextFunction) => {
    const data = req[source];
    const parseResult = schema.safeParse(data);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      }));
      validationLog.warn("Request validation failed", {
        event: "request.validation.failed",
        requestId: (req as any).requestId,
        path: req.path,
        source,
        issues,
      });
      return res.status(400).send(error("参数错误", { issues }));
    }
    if (source === "query") {
      (req as any).validatedQuery = parseResult.data;
    } else {
      (req as any)[source] = parseResult.data;
    }
    next();
  };
}
