export const VISUAL_ASSET_TYPES = ["role", "scene", "tool"] as const;

export type VisualAssetType = (typeof VISUAL_ASSET_TYPES)[number];

export function isVisualAssetType(value: unknown): value is VisualAssetType {
  return typeof value === "string" && (VISUAL_ASSET_TYPES as readonly string[]).includes(value);
}
