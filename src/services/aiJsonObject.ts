import { Output } from "ai";
import { z } from "zod";
import u from "@/utils";
import { createLogger, writeDiagnosticFile } from "@/logger";

type AiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const aiJsonLog = createLogger("ai-json-object");

export function isStructuredOutputUnsupported(error: unknown) {
  const message = [String((error as any)?.message || ""), String((error as any)?.details || ""), String((error as any)?.stack || "")]
    .filter(Boolean)
    .join("\n");
  return /responseFormat|structuredOutputs|JSON response format schema is only supported|Prompt must contain the word 'json'/i.test(message);
}

export function isAiObjectContractError(error: unknown) {
  const message = [String((error as any)?.message || ""), String((error as any)?.details || ""), String((error as any)?.stack || "")]
    .filter(Boolean)
    .join("\n");
  return /No object generated|response did not match schema|does not match schema|is not valid JSON/i.test(message);
}

function stripJsonFence(text: string) {
  const value = text.trim();
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();
  const firstChar = value[0];
  if (firstChar === "[") {
    const lastArray = value.lastIndexOf("]");
    if (lastArray > 0) return value.slice(0, lastArray + 1).trim();
  }
  if (firstChar === "{") {
    const lastObject = value.lastIndexOf("}");
    if (lastObject > 0) return value.slice(0, lastObject + 1).trim();
  }
  const firstObject = value.indexOf("{");
  const lastObject = value.lastIndexOf("}");
  const firstArray = value.indexOf("[");
  const lastArray = value.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray && (firstObject < 0 || firstArray < firstObject)) return value.slice(firstArray, lastArray + 1).trim();
  if (firstObject >= 0 && lastObject > firstObject) return value.slice(firstObject, lastObject + 1).trim();
  if (firstArray >= 0 && lastArray > firstArray) return value.slice(firstArray, lastArray + 1).trim();
  return value;
}

export function parseAiJsonValue(text: string, label = "AI JSON output"): unknown {
  const raw = String(text || "");
  const jsonText = stripJsonFence(raw);
  try {
    return JSON.parse(jsonText);
  } catch (error: any) {
    throw new Error(`${label} is not valid JSON: ${error?.message || error}. Output: ${raw.slice(0, 500)}`);
  }
}

export function parseAiJsonWithSchema<T>(text: string, schema: z.ZodType<T>, label = "AI JSON output"): T {
  const raw = String(text || "");
  const parsed = parseAiJsonValue(raw, label);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${label} does not match schema: ${result.error.message}. Output: ${raw.slice(0, 500)}`);
  }
  return result.data;
}

function truncate(value: unknown, max = 4000) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function schemaHint(schema: z.ZodType<unknown>) {
  try {
    const jsonSchema = (schema as any).toJSONSchema?.();
    if (jsonSchema) return JSON.stringify(jsonSchema, null, 2).slice(0, 4000);
  } catch {}
  return "Return JSON matching the requested schema and required fields.";
}

function fallbackSystem(baseSystem: string) {
  return [
    baseSystem,
    "Return only valid JSON.",
    "Do not wrap the JSON in Markdown.",
    "Do not include explanation, comments, XML, or extra prose.",
  ].join("\n");
}

function repairPrompt(input: { label: string; schema: z.ZodType<unknown>; previousText: string; error: unknown }) {
  return [
    `Repair the previous ${input.label} JSON output so it matches the required schema.`,
    "Keep the creative intent and content, but fix JSON syntax, missing required fields, and wrong field types.",
    "Return only the repaired JSON object. Do not include Markdown or explanation.",
    "",
    "Schema hint:",
    schemaHint(input.schema),
    "",
    "Validation error:",
    u.error(input.error).message,
    "",
    "Previous output:",
    truncate(input.previousText, 8000),
  ].join("\n");
}

function parseFallbackText<T>(input: {
  text: string;
  schema: z.ZodType<T>;
  label: string;
  fallbackTextParser?: (text: string) => T;
}) {
  if (input.fallbackTextParser) return input.fallbackTextParser(input.text);
  return parseAiJsonWithSchema(input.text, input.schema, input.label);
}

function writeAiJsonDiagnostic(input: {
  label: string;
  modelKey: unknown;
  system: string;
  messages: AiMessage[];
  structuredError?: unknown;
  fallbackText?: string;
  fallbackError?: unknown;
  repairText?: string;
  repairError?: unknown;
}) {
  const diagnosticFile = writeDiagnosticFile(
    `ai-json-${String(input.label || "object").toLowerCase().replace(/[^a-z0-9_-]+/gi, "-")}`,
    JSON.stringify(
      {
        label: input.label,
        modelKey: input.modelKey,
        system: truncate(input.system),
        messages: input.messages.map((message) => ({ ...message, content: truncate(message.content) })),
        structuredError: input.structuredError ? u.error(input.structuredError).message : undefined,
        fallbackText: input.fallbackText ? truncate(input.fallbackText) : undefined,
        fallbackError: input.fallbackError ? u.error(input.fallbackError).message : undefined,
        repairText: input.repairText ? truncate(input.repairText) : undefined,
        repairError: input.repairError ? u.error(input.repairError).message : undefined,
      },
      null,
      2,
    ),
    { provider: "prompt", model: String(input.modelKey || "") },
  );
  aiJsonLog.warn("AI JSON object diagnostic captured", {
    event: "ai-json.diagnostic",
    label: input.label,
    model: String(input.modelKey || ""),
    diagnosticFile,
  });
  return diagnosticFile;
}

export async function invokeAiObjectWithFallback<T>(input: {
  modelKey: Parameters<typeof u.Ai.Text>[0];
  system: string;
  messages: AiMessage[];
  schema: z.ZodType<T>;
  label: string;
  fallbackTextParser?: (text: string) => T;
}): Promise<T> {
  const system = `${input.system}\nReturn valid JSON that matches the schema.`;
  try {
    const result = await u.Ai.Text(input.modelKey).invoke({
      system,
      output: Output.object({ schema: input.schema }),
      messages: input.messages,
    });
    return result.output as T;
  } catch (error) {
    if (!isStructuredOutputUnsupported(error) && !isAiObjectContractError(error)) throw error;
    const fallbackResult = await u.Ai.Text(input.modelKey).invoke({
      system: fallbackSystem(system),
      messages: input.messages,
    });
    const fallbackText = String(fallbackResult.text || "");
    try {
      return parseFallbackText({
        text: fallbackText,
        schema: input.schema,
        label: input.label,
        fallbackTextParser: input.fallbackTextParser,
      });
    } catch (fallbackError) {
      if (!isAiObjectContractError(fallbackError)) throw fallbackError;
      const repairResult = await u.Ai.Text(input.modelKey).invoke({
        system: fallbackSystem(system),
        messages: [
          ...input.messages,
          { role: "assistant", content: fallbackText },
          {
            role: "user",
            content: repairPrompt({
              label: input.label,
              schema: input.schema,
              previousText: fallbackText,
              error: fallbackError,
            }),
          },
        ],
      });
      const repairText = String(repairResult.text || "");
      try {
        return parseFallbackText({
          text: repairText,
          schema: input.schema,
          label: input.label,
          fallbackTextParser: input.fallbackTextParser,
        });
      } catch (repairError) {
        writeAiJsonDiagnostic({
          label: input.label,
          modelKey: input.modelKey,
          system,
          messages: input.messages,
          structuredError: error,
          fallbackText,
          fallbackError,
          repairText,
          repairError,
        });
        throw repairError;
      }
    }
  }
}
