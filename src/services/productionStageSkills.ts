import fs from "node:fs";
import path from "node:path";
import { createSkillTools, parseFrontmatter } from "@/utils/agent/skillsTools";
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
  | "supervisionStoryboardTable"
  | "supervisionStoryboardPanel";

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
    tools: [
      "get_flowData",
      "resource_access",
      "update_agent_progress",
      "await_user_decision",
      "list_director_plan_generations",
      "read_director_plan_generation",
      "list_production_reviews",
      "read_production_review",
      "read_text_asset",
      "begin_director_plan",
      "append_director_plan_section",
      "commit_director_plan",
    ],
  },
  deriveAssets: {
    workflow: "production_execution_derive_assets.md",
    skills: [],
    tools: ["get_flowData", "resource_access", "update_agent_progress", "await_user_decision", "add_deriveAsset"],
  },
  generateAssets: {
    workflow: "production_execution_generate_assets.md",
    skills: [],
    tools: ["get_flowData", "resource_access", "update_agent_progress", "await_user_decision", "generate_deriveAsset"],
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
      "resource_access",
      "update_agent_progress",
      "await_user_decision",
      "list_storyboard_generations",
      "read_storyboard_generation",
      "inspect_storyboard_table_change",
      "list_production_reviews",
      "read_production_review",
      "read_text_asset",
      "get_storyboard_generation_draft",
      "prepare_storyboard_table",
      "begin_storyboard_table",
      "append_storyboard_rows",
      "commit_storyboard_table",
    ],
  },
  storyboardPanel: {
    workflow: "production_execution_storyboard_panel.md",
    skills: [
      { source: "configured", file: "production_skills/storyboard_prompt_techniques.md", name: "storyboard_prompt_techniques" },
    ],
    tools: [
      "get_flowData",
      "resource_access",
      "read_storyboard_panel_targets",
      "read_storyboard_panel_sources",
      "update_agent_progress",
      "await_user_decision",
      "list_production_reviews",
      "read_production_review",
      "read_text_asset",
      "update_storyboard_panel",
    ],
  },
  storyboardGenerate: {
    workflow: "production_execution_storyboard_gen.md",
    skills: [],
    tools: ["get_flowData", "resource_access", "update_agent_progress", "await_user_decision", "generate_storyboard"],
  },
  supervisionDirectorPlan: {
    workflow: "production_supervision_director_plan.md",
    skills: [
      { source: "manual", kind: "visual", file: "driector_skills/director_planning_style.md", name: "director_planning_style" },
      { source: "manual", kind: "director", file: "driector_skills/director_planning_narrative.md", name: "director_planning_narrative" },
    ],
    tools: [
      "get_flowData",
      "resource_access",
      "update_agent_progress",
      "await_user_decision",
      "list_director_plan_generations",
      "read_director_plan_generation",
      "get_director_plan_asset",
      "list_production_reviews",
      "read_production_review",
      "read_text_asset",
    ],
  },
  supervisionStoryboardTable: {
    workflow: "production_supervision_storyboard_table.md",
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
      "resource_access",
      "update_agent_progress",
      "await_user_decision",
      "list_storyboard_generations",
      "read_storyboard_generation",
      "list_production_reviews",
      "read_production_review",
      "read_text_asset",
      "record_storyboard_table_review",
    ],
  },
  supervisionStoryboardPanel: {
    workflow: "production_supervision_storyboard_panel.md",
    skills: [
      { source: "configured", file: "production_skills/storyboard_prompt_techniques.md", name: "storyboard_prompt_techniques" },
    ],
    tools: [
      "read_storyboard_panel_targets",
      "read_storyboard_panel_sources",
      "update_agent_progress",
      "await_user_decision",
      "list_production_reviews",
      "read_production_review",
      "read_text_asset",
    ],
  },
};

function resolveStageSkill(spec: SkillSpec, artStyle: string, directorManual: string) {
  if (spec.source === "configured") return resolveSkillFile(spec.file);
  const manualKey = spec.kind === "visual" ? artStyle : directorManual;
  return resolveManualFile(spec.kind, manualKey, spec.file);
}

function productionSkillBody(content: string) {
  return content.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trim();
}

function buildPreloadedProductionSkillPrompt(
  skills: Array<{ path: string; name: string; description: string; body: string }>,
) {
  if (!skills.length) return "";
  const content = skills
    .map(
      (skill) => `<skill_content name="${skill.name}" source="${skill.path}">
${skill.body}
</skill_content>`,
    )
    .join("\n\n");
  return `## Required Production Skills
The following stage Skills are already loaded and remain stable across every continuation Turn. Follow their full instructions. Do not call activate_skill for them. Use read_skill_file only when a loaded Skill explicitly requires an additional resource file.

${content}`;
}

export async function loadProductionStage(input: {
  stage: ProductionStage;
  artStyle: string;
  directorManual: string;
}) {
  const definition = PRODUCTION_STAGE_DEFINITIONS[input.stage];
  const workflow = await readConfiguredSkill(definition.workflow);
  const skills: Array<{ path: string; name: string; description: string; body: string }> = [];

  for (const spec of definition.skills) {
    const file = resolveStageSkill(spec, input.artStyle, input.directorManual);
    if (!file) {
      throw new Error(`Required skill missing for ${input.stage}: ${spec.name} (${spec.file})`);
    }
    const raw = await fs.promises.readFile(file, "utf8");
    const parsed = parseFrontmatter(raw);
    if (parsed.name !== spec.name) {
      throw new Error(`Skill contract mismatch: ${file}; expected name=${spec.name}, actual name=${parsed.name}`);
    }
    skills.push({ path: file, ...parsed, body: productionSkillBody(raw) });
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

  const skillTools = skills.length
    ? createSkillTools(
        skills,
        { mainSkill: skills, secondarySkills: [], tertiarySkills: [] },
        skillRootCandidates()[0] || path.dirname(skills[0].path),
      )
    : null;

  return {
    workflow: workflow.content,
    definition,
    prompt: buildPreloadedProductionSkillPrompt(skills),
    tools: skillTools ? { read_skill_file: skillTools.read_skill_file } : {},
  };
}

export function productionSupervisionStage(prompt: string): ProductionStage {
  if (/(分镜面板|图片提示词|分镜图提示词|storyboard\s*panel|panel\s*prompt)/i.test(prompt)) {
    return "supervisionStoryboardPanel";
  }
  return /(分镜表|审核分镜|review storyboard)/i.test(prompt)
    ? "supervisionStoryboardTable"
    : "supervisionDirectorPlan";
}
