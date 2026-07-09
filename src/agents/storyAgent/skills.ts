import { buildSkillPrompt, createSkillTools, parseFrontmatter } from "@/utils/agent/skillsTools";
import { resolveSkillFile, skillRootCandidates } from "@/services/skillResolver";
import fs from "node:fs";

const STORY_SKILLS = [
  "story_concept_brainstorm.md",
  "story_bible_generation.md",
  "story_outline_generation.md",
  "story_script_writing.md",
  "story_revision_from_annotations.md",
  "story_script_review.md",
];

export async function useStorySkills() {
  const rootDir = skillRootCandidates()[0];
  const mainSkill = [];
  for (const fileName of STORY_SKILLS) {
    const filePath = resolveSkillFile(fileName);
    if (!filePath) continue;
    const raw = await fs.promises.readFile(filePath, "utf8");
    mainSkill.push({ path: filePath, ...parseFrontmatter(raw) });
  }
  return {
    prompt: mainSkill.length ? buildSkillPrompt(mainSkill) : "",
    tools: mainSkill.length
      ? createSkillTools(
          mainSkill,
          {
            mainSkill,
            secondarySkills: [],
            tertiarySkills: [],
          },
          rootDir,
        )
      : {},
  };
}
