import express from "express";
import { success } from "@/lib/responseFormat";
import { listProjectManuals, type ManualDataField } from "@/services/projectManuals";

const router = express.Router();

const DATA_MAP: ManualDataField[] = [
  { label: "README", value: "README" },
  { label: "导演规划", value: "director_planning_narrative", subDir: "driector_skills" },
  { label: "分镜表", value: "director_storyboard_table_narrative", subDir: "driector_skills" },
];

export default router.post("/", async (_req, res) => {
  try {
    res.status(200).send(success(await listProjectManuals("director", DATA_MAP)));
  } catch (err) {
    res.status(500).send({ error: String(err) });
  }
});
