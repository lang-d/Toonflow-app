import { jsonSchema, tool } from "ai";
import { z } from "zod";
import {
  createArtifact,
  getArtifact,
  getStoryContext,
  listAnnotations,
  publishArtifactToScript,
  reviseArtifactWithAnnotations,
  STORY_ARTIFACT_TYPES,
} from "@/services/storyArtifacts";

export default function useStoryTools(projectId: number) {
  return {
    get_project_story_context: tool({
      description: "Read project story context including project info, existing scripts, novel events, and story artifacts.",
      inputSchema: jsonSchema(z.object({}).toJSONSchema()),
      execute: async () => getStoryContext(projectId),
    }),
    get_artifact_with_annotations: tool({
      description: "Read a story artifact with its open user annotations.",
      inputSchema: jsonSchema<{ artifactId: number }>(
        z.object({ artifactId: z.number().describe("Story artifact id") }).toJSONSchema(),
      ),
      execute: async ({ artifactId }) => ({
        artifact: await getArtifact(projectId, artifactId),
        annotations: await listAnnotations({ projectId, artifactId, status: "open" }),
      }),
    }),
    create_artifact: tool({
      description: "Persist an official AI story output as an artifact for review and annotation.",
      inputSchema: jsonSchema<{ type: string; title: string; content: string; contentJson?: unknown; parentId?: number | null }>(
        z
          .object({
            type: z.enum(STORY_ARTIFACT_TYPES).describe("Artifact type"),
            title: z.string().describe("Artifact title"),
            content: z.string().describe("Full artifact text"),
            contentJson: z.any().optional().describe("Optional structured artifact data"),
            parentId: z.number().nullable().optional().describe("Parent artifact id when creating a new version"),
          })
          .toJSONSchema(),
      ),
      execute: async (input) => createArtifact({ ...input, projectId, type: input.type as any }),
    }),
    revise_artifact_with_annotations: tool({
      description: "Persist a revised artifact after applying user annotations. The model must generate the revised text before calling this tool.",
      inputSchema: jsonSchema<{
        sourceArtifactId: number;
        title?: string;
        content: string;
        contentJson?: unknown;
        changeSummary?: string;
        annotationIds?: number[];
      }>(
        z
          .object({
            sourceArtifactId: z.number().describe("Source artifact id"),
            title: z.string().optional().describe("Title for the revised artifact"),
            content: z.string().describe("Full revised artifact text"),
            contentJson: z.any().optional(),
            changeSummary: z.string().optional().describe("Short explanation of the revision"),
            annotationIds: z.array(z.number()).optional().describe("Applied annotation ids; defaults to all open annotations"),
          })
          .toJSONSchema(),
      ),
      execute: async (input) => reviseArtifactWithAnnotations({ ...input, projectId }),
    }),
    publish_artifact_to_script: tool({
      description: "Publish a script artifact into the existing o_script production pipeline after the user confirms it.",
      inputSchema: jsonSchema<{ artifactId: number; scriptId?: number | null; name?: string; assets?: number[] }>(
        z
          .object({
            artifactId: z.number(),
            scriptId: z.number().nullable().optional(),
            name: z.string().optional(),
            assets: z.array(z.number()).optional(),
          })
          .toJSONSchema(),
      ),
      execute: async (input) => publishArtifactToScript({ ...input, projectId }),
    }),
  };
}
