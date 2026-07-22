import { z } from "zod";
import { invokeAiObjectWithFallback, parseAiJsonWithSchema } from "@/services/aiJsonObject";
import { getMusicLibraryEdition, saveMusicLyricsVersion } from "@/services/musicLibrary";
import { readMusicSkill } from "@/services/musicDirector";
import u from "@/utils";

const lyricsSchema = z.object({
  title: z.string(),
  language: z.string().default("Chinese"),
  content: z.string(),
  notes: z.string().optional().default(""),
});

export async function generateMusicLyricsDraft(input: {
  projectId: number;
  editionId: number;
  instruction?: string;
  basedOnId?: number | null;
}) {
  const edition = await getMusicLibraryEdition(input.projectId, input.editionId);
  const item = await (u.db as any)("o_musicLibraryItem").where({ projectId: input.projectId, id: edition.libraryItemId }).first();
  if (!item) throw new Error("Music library item does not exist");
  const bible = await u.db("o_musicBible").where({ projectId: input.projectId, state: "complete" }).orderBy("version", "desc").first();
  const base = input.basedOnId == null ? null : await (u.db as any)("o_musicLyricsVersion").where({ projectId: input.projectId, editionId: input.editionId, id: input.basedOnId }).first();
  if (input.basedOnId != null && !base) throw new Error("Base lyrics version does not exist");
  const skill = await readMusicSkill("music_lyrics_technique.md", "Write singable lyrics from the confirmed music work brief. Keep a clear point of view and structure.");
  const result = await invokeAiObjectWithFallback({
    modelKey: "productionAgent",
    label: "Music lyrics",
    schema: lyricsSchema,
    system: [
      "You write a lyrics draft for user review. Never mark it confirmed.",
      "Use the work's narrative role and edition phase, not a full plot recap.",
      skill.content,
    ].join("\n\n"),
    messages: [{ role: "user", content: JSON.stringify({ instruction: input.instruction || "", musicBible: bible?.content || "", work: item, edition, previousLyrics: base?.content || "" }, null, 2) }],
    fallbackTextParser: (text) => parseAiJsonWithSchema(text, lyricsSchema, "Music lyrics"),
  });
  const lyrics = await saveMusicLyricsVersion({
    projectId: input.projectId,
    editionId: input.editionId,
    title: result.title,
    language: result.language,
    content: result.content,
    source: "ai",
    basedOnId: input.basedOnId ?? null,
  });
  return { lyrics, notes: result.notes };
}
