import crypto from "node:crypto";
import u from "@/utils";
import {
  legacyStoryboardGroupName,
  parseStoryboardJsonObject,
  parseStoryboardTableRow,
  stringifyDialogue,
  stringifySoundEffects,
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
  "节拍",
  "时长",
  "地点",
  "时间",
  "起始画面",
  "主要动作",
  "景别",
  "运镜",
  "轴线 / 机位",
  "台词 / 音色",
  "画内声音",
  "关联资产",
];

// V3 keeps one chronological fact field. Historical V1/V2 columns remain
// visible beside it instead of being synthesized into a V3 description.
COLUMNS.splice(6, 0, "镜头描述");

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
    .select("id", "index", "tableRowJson", "factStatus", "groupName");

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
    ...rows
      .map((dbRow, rowIndex) => {
        const object = parseStoryboardJsonObject(dbRow.tableRowJson);
        const parsed = parseStoryboardTableRow(object);
        if (parsed && dbRow.factStatus !== "draft") readyCount += 1;
        else if (object) draftCount += 1;
        else legacyCount += 1;
        const row: any = parsed || object || {};
        const dialogue = parsed
          ? stringifyDialogue(parsed.dialogue)
          : Array.isArray(row.dialogue)
            ? row.dialogue.map((item: any) => [item?.speaker, item?.text, item?.voiceTone].filter(Boolean).join("：")).join("；")
            : "";
        const sound = parsed
          ? stringifySoundEffects(parsed.soundEffects)
          : Array.isArray(row.soundEffects)
            ? row.soundEffects.join("；")
            : "";
        const assets = Array.isArray(row.requiredAssets)
          ? [...row.requiredAssets]
              .sort((a: any, b: any) => Number(a?.order || 0) - Number(b?.order || 0))
              .map((item: any) => `${item?.name || "资产"}#${item?.assetId || ""}`)
              .join(", ")
          : "";
        const groupName = parsed ? legacyStoryboardGroupName(parsed) || dbRow.groupName || row.groupKey : dbRow.groupName;
        return [
          Number(row.index ?? dbRow.index ?? rowIndex) + 1,
          groupName || row.groupKey || "",
          row.beatId || "",
          row.durationSec || "",
          row.location || "",
          row.timeOfDay || "",
          row.shotDescription || "",
          row.picture || "",
          row.action || "",
          row.shotSize || "",
          row.cameraMove || "",
          row.cameraAngle || "",
          dialogue,
          sound,
          assets,
        ]
          .map(cell)
          .join(" | ");
      })
      .map((line) => `| ${line} |`),
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
