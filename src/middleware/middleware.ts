import { Request, Response, NextFunction } from "express";
import { z, ZodTypeAny } from "zod";
import { error } from "@/lib/responseFormat";

import { zhCN } from "zod/locales";

z.config(zhCN());

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
      console.error(issues);
      return res.status(400).send(error("参数错误", { issues }));
    }
    (req as any)[source] = parseResult.data;
    next();
  };
}
