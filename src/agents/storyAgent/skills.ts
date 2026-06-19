import fs from "fs";
import path from "path";
import getPath from "@/utils/getPath";
import { buildSkillPrompt, createSkillTools, parseFrontmatter } from "@/utils/agent/skillsTools";

const STORY_SKILLS = [
  "story_concept_brainstorm.md",
  "story_bible_generation.md",
  "story_outline_generation.md",
  "story_script_writing.md",
  "story_revision_from_annotations.md",
  "story_script_review.md",
];

function resolveStorySkill(rootDir: string, fileName: string) {
  const runtimePath = path.join(rootDir, fileName);
  if (fs.existsSync(runtimePath)) return runtimePath;
  const bundledPath = path.resolve("data", "skills", fileName);
  if (fs.existsSync(bundledPath)) return bundledPath;
  return null;
}

export async function useStorySkills() {
  const rootDir = getPath("skills");
  const mainSkill = [];
  for (const fileName of STORY_SKILLS) {
    const filePath = resolveStorySkill(rootDir, fileName);
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
