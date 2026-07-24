import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type DirectorSkillKind = "visual" | "narrative" | "storyboard";

interface MarkdownSection {
  title: string;
  body: string;
}

interface TopLevelSection extends MarkdownSection {
  heading: string;
}

const BASELINE_COMMIT = "04fce5b";
const MERGE_MARKER = "Production Agent 执行层（合并升级）";
const REFERENCE_PACKAGES = new Set(["realpeople_urban_modern", "Social_realist_drama"]);

const skillGroups: ReadonlyArray<{ root: string; file: string; kind: DirectorSkillKind }> = [
  { root: "data/skills/art_skills", file: "director_planning_style.md", kind: "visual" },
  { root: "data/skills/story_skills", file: "director_planning_narrative.md", kind: "narrative" },
  { root: "data/skills/story_skills", file: "director_storyboard_table_narrative.md", kind: "storyboard" },
];

function normalize(value: string) {
  return value.replace(/\r\n/g, "\n").trimEnd() + "\n";
}

function extractEnhancements(current: string): MarkdownSection[] {
  const markerMatches = [...current.matchAll(/^#{2,6}\s+Production Agent 执行层（合并升级）\s*$/gm)];
  const marker = markerMatches.at(-1);
  if (!marker || marker.index === undefined) return [];

  const tail = current.slice(marker.index + marker[0].length);
  const headings = [...tail.matchAll(/^#{2,6}\s+(.+?)\s*$/gm)];
  return headings.map((heading, index) => {
    const start = (heading.index || 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? tail.length;
    return { title: heading[1].trim(), body: tail.slice(start, end).trim() };
  }).filter((section) => section.body.length > 0);
}

function splitTopLevelSections(content: string) {
  const headings = [...content.matchAll(/^##\s+(.+?)\s*$/gm)];
  const preamble = content.slice(0, headings[0]?.index ?? content.length).trimEnd();
  const sections: TopLevelSection[] = headings.map((heading, index) => {
    const start = (heading.index || 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? content.length;
    return {
      heading: heading[0],
      title: heading[1].trim(),
      body: content.slice(start, end).trim(),
    };
  });
  return { preamble, sections };
}

function appendSubsection(section: TopLevelSection, enhancement: MarkdownSection) {
  const subsection = `### 类型专属应用：${enhancement.title}\n\n${enhancement.body}`;
  section.body = section.body ? `${section.body}\n\n${subsection}` : subsection;
}

function sectionIndex(sections: TopLevelSection[], ordinal: number) {
  return Math.min(Math.max(ordinal - 1, 0), Math.max(sections.length - 1, 0));
}

function visualTarget(title: string) {
  if (/职责|边界|核心原则|融合逻辑|适用/.test(title)) return "boundary";
  if (/输出/.test(title)) return "output";
  if (/禁止/.test(title)) return "forbidden";
  if (/声音|表演|动画/.test(title)) return 5;
  if (/轴线|机位|调度|站位|动作|空间|礼仪/.test(title)) return 4;
  if (/材质|质感|尺度|赛璐璐|画面结构|信息层级|视觉语法|卡通渲染/.test(title)) return 3;
  if (/色|光/.test(title)) return 2;
  return 4;
}

function narrativeTarget(title: string) {
  if (/诊断|事实|边界|原则/.test(title)) return "boundary";
  if (/输出/.test(title)) return "output";
  if (/禁止/.test(title)) return "forbidden";
  if (/表演|声音/.test(title)) return 4;
  if (/关系|空间|地理|调度|轴线|行动/.test(title)) return 3;
  if (/结构|阶段|推进|遮蔽|揭示|权力|宿命|选择|规则|心理/.test(title)) return 2;
  return 3;
}

function storyboardTarget(title: string, sections: TopLevelSection[]) {
  if (/边界/.test(title)) return "boundary";
  if (/声音|转场|对白|对话/.test(title)) return sections.length;
  if (/时长|节奏/.test(title)) return Math.min(4, sections.length);
  if (/视线|构图|负空间|线索镜头等级/.test(title)) return Math.min(2, sections.length);
  if (/连续|关系|空间|地理|攻防|伙伴|群体|法术|规则|证据|距离|触碰|信息/.test(title)) {
    return Math.min(5, sections.length);
  }
  return 1;
}

function cleanModernCityBaseline(content: string) {
  let cleaned = content
    .replace(
      "description: 真人都市约束 — 定义真人都市风格在色调体系、光影方案、质感方向、场景空间元素、配乐选择与环境音上的全局约束，并针对Seedance 2.0做深度适配。适用于任何叙事类型。",
      "description: 真人现代都市导演规划技法。用于把剧本事实转成真实场地、动机光、都市材质、人物走位、轴线覆盖、表演和声音决策，不规定具体剧情或生成参数。",
    )
    .replace("metaData: director_skills, seedance2.0_adapted", "metaData: director_skills")
    .replace(/\n## 六、Seedance 2\.0 专项适配[\s\S]*?(?=\n## 七、全局叙事约束)/, "")
    .replace("，确保可被 Seedance 2.0 物理模拟", "，并保证来源、方向与光比在真实场景中成立")
    .replace(/- \*\*Seedance 2\.0 光影适配要点\*\*：/, "- **光影表达要点**：")
    .replace(
      /光源名称可被AI理解（"夕照窗光"优于"暖色体积光"）。光比数字帮助模型建立明暗意识。多光源场景须明确主光\+辅光\+环境光的层级/,
      "光源名称必须对应场地中可见或可推断的真实来源；多光源场景须明确主光、辅光和环境光的层级，并使光比服务人物关系与行动",
    )
    .replace(/Seedance 2\.0 提示词用[^\n]+/, "导演规划只描述摄影机可见的真实皮肤证据，不使用渲染参数")
    .replace(/Seedance 2\.0 用[^\n]+/g, "导演规划描述摄影机可见的真实材料行为")
    .replace(/- \*\*Seedance 2\.0 质感适配要点\*\*：/, "- **真实质感边界**：")
    .replace(
      /避免 "PBR材质""物理级渲染""8K贴图" 等CG术语。改用 "real texture, natural material surface, visible wear and use marks, not CGI"。当描述轻微瑕疵时用 "subtle" 而非 "micro-detail" 等建模术语/,
      "导演规划记录摄影机能够观察到的纹理、磨损、反光和褶皱，不使用 PBR、贴图分辨率或渲染引擎参数代替真实材料行为",
    )
    .replace(/当代中国都市特有的场景元素及其在 Seedance 2\.0 视频中的视觉叙事功能：/, "当代中国都市特有的场景元素及其视觉叙事功能：")
    .replace(/。Seedance 2\.0 中重点描述[^\n]+/, "。规划时必须明确窗光入口、人物与玻璃的相对位置及反射方向")
    .replace(/。Seedance 2\.0 中街道场景必须明确[^\n]+/, "。规划时必须明确路面状态、车流方向和真实光源")
    .replace(/。Seedance 2\.0 中空镜需指定光源逻辑，空镜也有情绪/, "。空镜同样必须遵守光源和空间连续性")
    .replace(/——Seedance 2\.0 能理解这种"合理的不完全一致"/, "，变化必须保持时间连续")
    .replace(/Seedance 2\.0/g, "生成模型")
    .replace(/@reference/g, "参考图引用")
    .replace(/## 七、全局叙事约束/, "## 六、全局叙事约束")
    .replace(/## 八、快速决策卡/, "## 七、快速决策卡");
  return normalize(cleaned);
}

function prepareBaseline(relativePath: string, baseline: string) {
  if (relativePath.includes("art_skills/realpeople_modern_city/")) return cleanModernCityBaseline(baseline);
  return normalize(baseline);
}

export function rebuildDirectorSkillContent(
  baseline: string,
  current: string,
  kind: DirectorSkillKind,
  relativePath = "",
) {
  const enhancements = extractEnhancements(normalize(current));
  if (enhancements.length === 0) return normalize(current);

  const prepared = prepareBaseline(relativePath, baseline);
  const { preamble, sections } = splitTopLevelSections(prepared);
  const leading: MarkdownSection[] = [];
  const trailing: MarkdownSection[] = [];

  for (const enhancement of enhancements) {
    const target = kind === "visual"
      ? visualTarget(enhancement.title)
      : kind === "narrative"
        ? narrativeTarget(enhancement.title)
        : storyboardTarget(enhancement.title, sections);

    if (target === "boundary") {
      leading.push(enhancement);
    } else if (target === "output" || target === "forbidden") {
      trailing.push(enhancement);
    } else {
      appendSubsection(sections[sectionIndex(sections, target)], enhancement);
    }
  }

  const blocks = [preamble];
  if (leading.length > 0) {
    blocks.push(`## 应用边界与事实依据\n\n${leading.map((item) => item.body).join("\n\n")}`);
  }
  blocks.push(...sections.map((section) => `${section.heading}\n\n${section.body}`));
  for (const item of trailing) {
    const title = /禁止/.test(item.title)
      ? "禁止项"
      : kind === "storyboard"
        ? "分镜表应用检查"
        : "导演规划应用检查";
    blocks.push(`## ${title}\n\n${item.body}`);
  }

  return normalize(blocks.join("\n\n"));
}

function trackedSkills() {
  const result: Array<{ relativePath: string; kind: DirectorSkillKind }> = [];
  for (const group of skillGroups) {
    const root = path.resolve(group.root);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || REFERENCE_PACKAGES.has(entry.name)) continue;
      const relativePath = path.posix.join(group.root, entry.name, "driector_skills", group.file);
      if (!fs.existsSync(path.resolve(relativePath))) continue;
      try {
        execFileSync("git", ["cat-file", "-e", `${BASELINE_COMMIT}:${relativePath}`], { stdio: "ignore" });
        result.push({ relativePath, kind: group.kind });
      } catch {
        // New packages have no historical merge baseline and are already authored as standalone skills.
      }
    }
  }
  return result;
}

export function rebuildDirectorSkills(options: { write?: boolean } = {}) {
  const changed: string[] = [];
  for (const skill of trackedSkills()) {
    const file = path.resolve(skill.relativePath);
    const current = fs.readFileSync(file, "utf8");
    const baseline = execFileSync("git", ["show", `${BASELINE_COMMIT}:${skill.relativePath}`], { encoding: "utf8" });
    const rebuilt = rebuildDirectorSkillContent(baseline, current, skill.kind, skill.relativePath);
    if (normalize(current) === rebuilt) continue;
    changed.push(skill.relativePath);
    if (options.write) fs.writeFileSync(file, rebuilt, "utf8");
  }
  return changed;
}

if (require.main === module) {
  const write = process.argv.includes("--write");
  const changed = rebuildDirectorSkills({ write });
  if (!write && changed.length > 0) {
    console.error(`Director Skills need rebuilding: ${changed.length}`);
    process.exitCode = 1;
  } else {
    console.log(`${write ? "Rebuilt" : "Verified"} Director Skills: ${changed.length}`);
  }
}
