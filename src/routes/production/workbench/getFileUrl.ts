import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { resolveReferenceUrls } from "@/services/workbenchReference";
const router = express.Router();

export default router.post(
    "/",
    validateFields({
        items: z.array(z.object({
            id: z.number(),
            sources: z.enum(["storyboard", "assets", "merged", "directorAsset"])
        }))
    }),
    async (req, res) => {
        const { items } = req.body;
        const result = await resolveReferenceUrls(items);
        res.status(200).send(success({ data: result }));
    },
);
