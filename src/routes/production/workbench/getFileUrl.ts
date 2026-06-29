import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { resolveReferenceUrls } from "@/services/workbenchReference";
const router = express.Router();
const referenceSchema = z.object({
  id: z.union([z.number(), z.string()]),
  sources: z.enum(["storyboard", "assets", "merged", "directorAsset", "local"]),
});

export default router.post(
    "/",
    validateFields({
        projectId: z.number().optional(),
        scriptId: z.number().optional(),
        items: z.array(referenceSchema)
    }),
    async (req, res) => {
        const { items, projectId, scriptId } = req.body;
        const result = await resolveReferenceUrls(items, { projectId, scriptId });
        res.status(200).send(success({ data: result }));
    },
);
