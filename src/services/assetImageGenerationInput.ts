export type AssetImageReference = {
  type: "image";
  base64: string;
};

export type AssetImageSize = "1K" | "2K" | "4K";

/**
 * The image model executes the asset prompt produced by the visual-manual
 * compiler (or the user's own edit) verbatim. This boundary only validates
 * presence and shapes the provider input; it intentionally adds no style or
 * semantic instructions.
 */
export function buildAssetImageGenerationInput(
  savedPrompt: unknown,
  referenceList: AssetImageReference[],
  size: AssetImageSize,
) {
  const prompt = typeof savedPrompt === "string" ? savedPrompt : String(savedPrompt ?? "");
  if (!prompt.trim()) throw new Error("资产图片提示词不能为空");

  return {
    prompt,
    referenceList,
    size,
    aspectRatio: "16:9" as const,
  };
}
