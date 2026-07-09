import fs from "node:fs";
import path from "node:path";
import { buildSkillPrompt, createSkillTools, parseFrontmatter } from "@/utils/agent/skillsTools";
import {
  readConfiguredSkill,
  resolveManualFile,
  resolveSkillFile,
  skillSourceKind,
  skillRootCandidates,
  type ManualKind,
} from "@/services/skillResolver";

export type ProductionStage =
  | "directorPlan"
  | "deriveAssets"
  | "generateAssets"
  | "storyboardTable"
  | "storyboardPanel"
  | "storyboardGenerate"
  | "supervisionDirectorPlan"
  | "supervisionStoryboardTable";

type SkillSpec =
  | { source: "manual"; kind: ManualKind; file: string; name: string }
  | { source: "configured"; file: string; name: string };

export interface ProductionStageDefinition {
  workflow: string;
  skills: SkillSpec[];
  tools: string[];
}

export const PRODUCTION_STAGE_DEFINITIONS: Record<ProductionStage, ProductionStageDefinition> = {
  directorPlan: {
    workflow: "production_execution_director_plan.md",
    skills: [
      { source: "manual", kind: "visual", file: "driector_skills/director_planning_style.md", name: "director_planning_style" },
      { source: "manual", kind: "director", file: "driector_skills/director_planning_narrative.md", name: "director_planning_narrative" },
    ],
    tools: ["get_flowData", "begin_director_plan", "append_director_plan_section", "commit_director_plan"],
  },
  deriveAssets: {
    workflow: "production_execution_derive_assets.md",
    skills: [],
    tools: ["get_flowData", "add_deriveAsset"],
  },
  generateAssets: {
    workflow: "production_execution_generate_assets.md",
    skills: [],
    tools: ["get_flowData", "generate_deriveAsset"],
  },
  storyboardTable: {
    workflow: "production_execution_storyboard_table.md",
    skills: [
      { source: "configured", file: "production_skills/storyboard_table_techniques.md", name: "storyboard_table_techniques" },
      {
        source: "manual",
        kind: "director",
        file: "driector_skills/director_storyboard_table_narrative.md",
        name: "director_storyboard_table_narrative",
      },
    ],
    tools: [
      "get_flowData",
      "get_storyboard_generation_draft",
      "begin_storyboard_table",
      "append_storyboard_rows",
      "commit_storyboard_table",
      "await_user_decision",
    ],
  },
  storyboardPanel: {
    workflow: "production_execution_storyboard_panel.md",
    skills: [
      { source: "configured", file: "production_skills/storyboard_prompt_techniques.md", name: "storyboard_prompt_techniques" },
    ],
    tools: ["get_flowData", "update_storyboard_panel_v2"],
  },
  storyboardGenerate: {
    workflow: "production_execution_storyboard_gen.md",
    skills: [],
    tools: ["get_flowData", "generate_storyboard"],
  },
  supervisionDirectorPlan: {
    workflow: "production_agent_supervision.md",
    skills: [
      { source: "manual", kind: "visual", file: "driector_skills/director_planning_style.md", name: "director_planning_style" },
      { source: "manual", kind: "director", file: "driector_skills/director_planning_narrative.md", name: "director_planning_narrative" },
    ],
    tools: ["get_flowData", "get_director_plan_asset"],
  },
  supervisionStoryboardTable: {
    workflow: "production_agent_supervision.md",
    skills: [
      { source: "configured", file: "production_skills/storyboard_table_techniques.md", name: "storyboard_table_techniques" },
      {
        source: "manual",
        kind: "director",
        file: "driector_skills/director_storyboard_table_narrative.md",
        name: "director_storyboard_table_narrative",
      },
    ],
    tools: ["get_flowData"],
  },
};

function resolveStageSkill(spec: SkillSpec, artStyle: string, directorManual: string) {
  if (spec.source === "configured") return resolveSkillFile(spec.file);
  const manualKey = spec.kind === "visual" ? artStyle : directorManual;
  return resolveManualFile(spec.kind, manualKey, spec.file);
}

export async function loadProductionStage(input: {
  stage: ProductionStage;
  artStyle: string;
  directorManual: string;
}) {
  const definition = PRODUCTION_STAGE_DEFINITIONS[input.stage];
  const workflow = await readConfiguredSkill(definition.workflow);
  const skills: Array<{ path: string; name: string; description: string }> = [];

  for (const spec of definition.skills) {
    const file = resolveStageSkill(spec, input.artStyle, input.directorManual);
    if (!file) {
      throw new Error(`Required skill missing for ${input.stage}: ${spec.name} (${spec.file})`);
    }
    const parsed = parseFrontmatter(await fs.promises.readFile(file, "utf8"));
    if (parsed.name !== spec.name) {
      throw new Error(`Skill contract mismatch: ${file}; expected name=${spec.name}, actual name=${parsed.name}`);
    }
    skills.push({ path: file, ...parsed });
  }

  const resolvedSources = [
    { name: "workflow", path: workflow.source, source: skillSourceKind(workflow.source) },
    ...skills.map((skill) => ({ name: skill.name, path: skill.path, source: skillSourceKind(skill.path) })),
  ];
  const legacySources = resolvedSources.filter((item) => item.source === "legacyUser");
  if (legacySources.length) {
    console.warn("[production-skills] legacy user skill source used", {
      stage: input.stage,
      sources: legacySources,
    });
  }

  console.info("[production-skills] stage resolved", {
    stage: input.stage,
    workflow: workflow.source,
    skills: skills.map((skill) => ({ name: skill.name, path: skill.path, source: skillSourceKind(skill.path) })),
    tools: definition.tools,
  });

  return {
    workflow: workflow.content,
    definition,
    prompt: skills.length ? buildSkillPrompt(skills) : "",
    tools: skills.length
      ? createSkillTools(
          skills,
          { mainSkill: skills, secondarySkills: [], tertiarySkills: [] },
          skillRootCandidates()[0] || path.dirname(skills[0].path),
        )
      : {},
  };
}

export function productionSupervisionStage(prompt: string): ProductionStage {
  return /(分镜表|审核分镜|review storyboard)/i.test(prompt)
    ? "supervisionStoryboardTable"
    : "supervisionDirectorPlan";
}
