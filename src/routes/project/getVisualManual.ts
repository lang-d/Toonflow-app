import express from "express";
import { success } from "@/lib/responseFormat";
import { listProjectManuals, type ManualDataField } from "@/services/projectManuals";

const router = express.Router();

const DATA_MAP: ManualDataField[] = [
  { label: "README", value: "README" },
  { label: "前缀", value: "prefix" },
  { label: "角色", value: "art_character", subDir: "art_prompt" },
  { label: "角色衍生", value: "art_character_derivative", subDir: "art_prompt" },
  { label: "道具", value: "art_prop", subDir: "art_prompt" },
  { label: "道具衍生", value: "art_prop_derivative", subDir: "art_prompt" },
  { label: "场景", value: "art_scene", subDir: "art_prompt" },
  { label: "场景衍生", value: "art_scene_derivative", subDir: "art_prompt" },
  { label: "分镜", value: "director_storyboard", subDir: "driector_skills" },
  { label: "分镜视频", value: "art_storyboard_video", subDir: "art_prompt" },
  { label: "技法-导演规划", value: "director_planning_style", subDir: "driector_skills" },
  { label: "技法-分镜表设计", value: "director_storyboard_table_style", subDir: "driector_skills" },
];

export default router.post("/", async (_req, res) => {
  try {
    res.status(200).send(success(await listProjectManuals("visual", DATA_MAP)));
  } catch (err) {
    res.status(500).send({ error: String(err) });
  }
});
