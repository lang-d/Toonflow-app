import u from "@/utils";
import { musicEpisodeIsolationKey, musicProjectIsolationKey } from "@/services/musicScope";

type AgentType = "scriptAgent" | "productionAgent" | "musicProductionAgent";

type FullTextAssetMeta = {
  id: number;
  size: number;
  summary: string | null;
  targetType: string;
};

const FULL_TEXT_ASSET_RE = /\[?\s*full\s+text\s+asset\s*:\s*(\d+)\s*\]?/gi;

export function agentMemoryIsolationKey(input: { projectId: number; agentType: AgentType; episodesId?: number }) {
  if (input.agentType === "musicProductionAgent") {
    return input.episodesId
      ? musicEpisodeIsolationKey(input.projectId, input.episodesId)
      : musicProjectIsolationKey(input.projectId);
  }
  return `${input.projectId}:${input.agentType}${input.episodesId ? `:${input.episodesId}` : ""}`;
}

function normalizeRole(role?: string | null): "user" | "assistant" {
  return role?.startsWith("assistant") ? "assistant" : "user";
}

function fullTextAssetIds(content: string) {
  const ids = new Set<number>();
  for (const match of content.matchAll(FULL_TEXT_ASSET_RE)) {
    const id = Number(match[1]);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

async function loadFullTextAssetMeta(projectId: number, ids: number[], database: any) {
  if (!ids.length) return new Map<number, FullTextAssetMeta>();
  const rows = await database("o_textAsset")
    .where({ projectId })
    .whereIn("id", ids)
    .select("id", "size", "summary", "targetType");
  return new Map<number, FullTextAssetMeta>(
    rows.map((row: any) => [
      Number(row.id),
      {
        id: Number(row.id),
        size: Number(row.size || 0),
        summary: row.summary ?? null,
        targetType: String(row.targetType || ""),
      },
    ]),
  );
}

export async function getAgentMemoryHistory(
  input: { projectId: number; agentType: AgentType; episodesId?: number },
  database: any = u.db,
) {
  const isolationKey = agentMemoryIsolationKey(input);
  const rows = await database("memories")
    .where({ isolationKey, type: "message" })
    .orderBy("createTime", "asc")
    .select("id", "role", "name", "content", "createTime");

  const assetIds: number[] = Array.from(
    new Set<number>(rows.flatMap((row: any) => fullTextAssetIds(String(row.content || "")))),
  );
  const assetMeta = await loadFullTextAssetMeta(input.projectId, assetIds, database);

  return rows.map((row: any) => {
    const content = String(row.content || "");
    const fullTextAssets = fullTextAssetIds(content)
      .map((id) => assetMeta.get(id))
      .filter(Boolean) as FullTextAssetMeta[];
    const ext = fullTextAssets.length
      ? {
          fullTextAsset: fullTextAssets[0],
          fullTextAssets,
        }
      : undefined;
    const markdownContent: any = { type: "markdown", status: "complete", data: row.content };
    if (ext) markdownContent.ext = ext;
    return {
      id: row.id,
      role: normalizeRole(row.role),
      name: row.name ?? undefined,
      status: "complete",
      datetime: new Date(row.createTime).toISOString(),
      content: [markdownContent],
      createTime: row.createTime,
      ...(ext ? { ext } : {}),
    };
  });
}
