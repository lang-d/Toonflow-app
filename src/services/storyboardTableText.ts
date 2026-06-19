import crypto from "node:crypto";
import u from "@/utils";
import {
  parseStoryboardJsonObject,
  stringifyDialogue,
  stringifySoundEffects,
  storyboardTableRowV2Schema,
} from "@/services/storyboardTableContract";

export interface StoryboardTableMeta {
  source: "structured" | "draft" | "legacy" | "empty";
  rowCount: number;
  complete: boolean;
  hash: string;
}

export interface RenderedStoryboardTable {
  content: string;
  meta: StoryboardTableMeta;
}

const COLUMNS = [
  "序号",
  "分镜组",
  "组意图",
  "节拍",
  "时长",
  "地点",
  "时间",
  "画面",
  "动作",
  "景别",
  "运镜",
  "台词",
  "音效",
  "可见表演",
  "关联资产",
];

function hashText(value: string) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function cell(value: unknown) {
  return String(value ?? "")
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();
}

function countStoryboardRows(markdown: string) {
  if (!markdown) return 0;
  return markdown
    .split(/\r?\n/)
    .filter((line) => /^\|\s*\d+\s*\|/.test(line.trim())).length;
}

export function storyboardTableRowCount(markdown: string) {
  return countStoryboardRows(markdown);
}

export async function renderStoryboardTableFromRows(projectId: number, scriptId: number): Promise<RenderedStoryboardTable> {
  const rows = await u
    .db("o_storyboard")
    .where({ projectId, scriptId })
    .orderBy("index", "asc")
    .orderBy("id", "asc")
    .select("id", "index", "tableRowJson", "factStatus");

  if (!rows.length) {
    return {
      content: "",
      meta: { source: "empty", rowCount: 0, complete: false, hash: hashText("") },
    };
  }

  let readyCount = 0;
  let draftCount = 0;
  let legacyCount = 0;
  const lines = [
    `| ${COLUMNS.join(" | ")} |`,
    `| ${COLUMNS.map(() => "---").join(" | ")} |`,
    ...rows.map((dbRow, rowIndex) => {
      const object = parseStoryboardJsonObject(dbRow.tableRowJson);
      const parsed = storyboardTableRowV2Schema.safeParse(object);
      if (parsed.success && dbRow.factStatus !== "draft") readyCount += 1;
      else if (object) draftCount += 1;
      else legacyCount += 1;
      const row = parsed.success ? parsed.data : object || {};
      const dialogue = parsed.success
        ? stringifyDialogue(parsed.data.dialogue)
        : Array.isArray(row.dialogue)
          ? row.dialogue.map((item: any) => [item?.speaker, item?.text].filter(Boolean).join("：")).join("；")
          : "";
      const sound = parsed.success
        ? stringifySoundEffects(parsed.data.soundEffects)
        : Array.isArray(row.soundEffects)
          ? row.soundEffects.join("、")
          : "";
      const assets = Array.isArray(row.requiredAssets)
        ? [...row.requiredAssets]
            .sort((a: any, b: any) => Number(a?.order || 0) - Number(b?.order || 0))
            .map((item: any) => `${item?.name || "资产"}#${item?.assetId || ""}`)
            .join(", ")
        : "";
      return [
        Number(row.index ?? dbRow.index ?? rowIndex) + 1,
        row.groupName || row.groupKey || "",
        row.groupIntent || "",
        row.beatId || "",
        row.durationSec || "",
        row.location || "",
        row.timeOfDay || "",
        row.picture || "",
        row.action || "",
        row.shotSize || "",
        row.cameraMove || "",
        dialogue,
        sound,
        row.visibleEmotion || "",
        assets,
      ]
        .map(cell)
        .join(" | ");
    }).map((line) => `| ${line} |`),
  ];
  const content = lines.join("\n");
  const source = legacyCount ? "legacy" : draftCount ? "draft" : "structured";
  return {
    content,
    meta: {
      source,
      rowCount: rows.length,
      complete: readyCount === rows.length,
      hash: hashText(content),
    },
  };
}

export function storyboardTableDraftMeta(content: string): StoryboardTableMeta {
  return {
    source: content ? "draft" : "empty",
    rowCount: countStoryboardRows(content),
    complete: false,
    hash: hashText(content || ""),
  };
}
