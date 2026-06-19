import { Output } from "ai";
import { z } from "zod";
import u from "@/utils";

type AiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export function isStructuredOutputUnsupported(error: unknown) {
  const message = [String((error as any)?.message || ""), String((error as any)?.details || ""), String((error as any)?.stack || "")]
    .filter(Boolean)
    .join("\n");
  return /responseFormat|structuredOutputs|JSON response format schema is only supported|Prompt must contain the word 'json'/i.test(message);
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
    if (!isStructuredOutputUnsupported(error)) throw error;
    const result = await u.Ai.Text(input.modelKey).invoke({
      system: `${system}\nReturn only valid JSON. Do not wrap it in Markdown unless unavoidable.`,
      messages: input.messages,
    });
    if (input.fallbackTextParser) return input.fallbackTextParser(result.text);
    return parseAiJsonWithSchema(result.text, input.schema, input.label);
  }
}
