export interface VideoPromptGuardResult {
  text: string;
  issues: Array<{
    issueType: string;
    severity: "info" | "warning" | "blocking";
    message: string;
    reason?: string;
  }>;
}

export function inspectVideoPromptEngineering(text: string): VideoPromptGuardResult {
  const value = String(text || "");
  const issues: VideoPromptGuardResult["issues"] = [];
  if (!value.trim()) {
    issues.push({
      issueType: "empty_prompt",
      severity: "blocking",
      message: "视频提示词为空，请先生成或手动填写提示词。",
    });
  }
  if (Buffer.byteLength(value, "utf8") > 64000) {
    issues.push({
      issueType: "prompt_too_large",
      severity: "warning",
      message: "视频提示词过长，建议通过 AI 审校或人工编辑压缩后再生成。",
      reason: "The prompt is close to the task payload size limit.",
    });
  }
  return { text: value, issues };
}

// Backward-compatible name for existing imports. This function deliberately does
// not rewrite creative semantics. It only reports deterministic engineering
// issues; AI review and user confirmation own prompt revision.
export function guardVideoPrompt(text: string): VideoPromptGuardResult {
  return inspectVideoPromptEngineering(text);
}
