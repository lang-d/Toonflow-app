import { Output } from "ai";
import { z } from "zod";
import u from "@/utils";
import { readConfiguredSkill } from "@/services/skillResolver";
import { readStoryboardPanelReviewBundle } from "@/services/storyboardPanelReviewScope";

const reviewItemSchema = z.object({
  scope: z.enum(["global", "storyboard"]),
  storyboardIndex: z.number().int().nonnegative().nullable(),
  field: z.string().trim().min(1).max(120),
  severity: z.enum(["info", "warning", "blocking"]),
  currentEvidence: z.string().trim().min(1).max(1500),
  upstreamEvidence: z.string().trim().min(1).max(1500),
  owner: z.enum(["storyboardPanel", "storyboardTable", "deriveAssets"]),
  recommendation: z.string().trim().min(1).max(1500),
});

export const storyboardPanelSingleReviewResultSchema = z.object({
  summary: z.string().trim().min(1).max(3000),
  items: z.array(reviewItemSchema).max(100),
});

export type StoryboardPanelSingleReviewResult = z.infer<typeof storyboardPanelSingleReviewResultSchema>;

export type RunStoryboardPanelSingleReviewInput = {
  projectId: number;
  scriptId: number;
  modelKey?: Parameters<typeof u.Ai.Text>[0];
  think?: boolean;
  thinkLevel?: 0 | 1 | 2 | 3;
};

function reviewSystemPrompt(workflow: string, promptTechnique: string) {
  const outputSchema = JSON.stringify(storyboardPanelSingleReviewResultSchema.toJSONSchema());
  return `${workflow}\n\n${promptTechnique}\n\nReturn only one JSON object matching this output schema: ${outputSchema}\nDo not include process narration or any text outside the JSON object.`;
}

export function storyboardPanelSingleReviewFailureDetails(error: unknown) {
  const value = error as {
    name?: unknown;
    message?: unknown;
    text?: unknown;
    finishReason?: unknown;
    usage?: unknown;
    cause?: { name?: unknown; message?: unknown; issues?: unknown };
  };
  return {
    name: typeof value?.name === "string" ? value.name : "Error",
    message: u.error(error).message.slice(0, 1000),
    finishReason: typeof value?.finishReason === "string" ? value.finishReason : undefined,
    usage: value?.usage,
    text: typeof value?.text === "string" ? value.text.slice(0, 4000) : undefined,
    cause: value?.cause
      ? {
          name: typeof value.cause.name === "string" ? value.cause.name : undefined,
          message: typeof value.cause.message === "string" ? value.cause.message.slice(0, 1000) : undefined,
          issues: value.cause.issues,
        }
      : undefined,
  };
}

/**
 * Executes exactly one non-streaming, tool-free model call against a frozen
 * panel snapshot. It intentionally has no text/JSON repair retry: an invalid
 * structured response is a failed comparison, not a hidden second audit.
 */
export async function runStoryboardPanelSingleReview(input: RunStoryboardPanelSingleReviewInput) {
  const bundle = await readStoryboardPanelReviewBundle({ projectId: input.projectId, scriptId: input.scriptId });
  const [workflow, promptTechnique] = await Promise.all([
    readConfiguredSkill("production_supervision_storyboard_panel.md"),
    readConfiguredSkill("production_skills/storyboard_prompt_techniques.md"),
  ]);
  const modelKey = input.modelKey ?? "productionAgent:supervisionAgent";
  const result = await u.Ai.Text(modelKey, input.think ?? false, input.thinkLevel ?? 0).invoke({
    system: reviewSystemPrompt(workflow.content, promptTechnique.content),
    messages: [
      {
        role: "user",
        content: `Review this complete frozen storyboard-panel fact package.\n\n${JSON.stringify(bundle)}`,
      },
    ],
    output: Output.object({ schema: storyboardPanelSingleReviewResultSchema }),
  });
  const parsed = storyboardPanelSingleReviewResultSchema.safeParse(result.output);
  if (!parsed.success) {
    throw new Error(`Single storyboard-panel review returned an invalid structured result: ${parsed.error.message}`);
  }
  return {
    bundle,
    result: parsed.data,
    model: {
      finishReason: (result as { finishReason?: unknown }).finishReason,
      usage: (result as { usage?: unknown }).usage,
    },
  };
}
