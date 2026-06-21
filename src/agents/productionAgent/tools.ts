import { tool, jsonSchema, Tool } from "ai";
import { z } from "zod";
import _ from "lodash";
import ResTool from "@/socket/resTool";
import u from "@/utils";
import {
  storyboardGroupPlanV2Schema,
  storyboardTableRowV2Schema,
} from "@/services/storyboardTableContract";
import {
  appendStoryboardRows,
  beginStoryboardGeneration,
  commitStoryboardGeneration,
} from "@/services/storyboardGeneration";
import { emitWithAckTimeout } from "@/agents/shared/socketAck";

const deriveAssetSchema = z.object({
  id: z.number().describe("衍生资产ID,如果新增则为空"),
  assetsId: z.number().describe("关联的资产ID"),
  prompt: z.string().describe("生成提示词"),
  name: z.string().describe("衍生资产名称"),
  desc: z.string().describe("衍生资产描述"),
  src: z.string().nullable().describe("衍生资产资源路径"),
  state: z.enum(["未生成", "生成中", "已完成", "生成失败"]).describe("衍生资产生成状态"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("衍生资产类型"),
});
export const assetItemSchema = z.object({
  id: z.number().describe("资产唯一标识"),
  name: z.string().describe("资产名称"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("资产类型"),
  prompt: z.string().describe("生成提示词"),
  desc: z.string().describe("资产描述"),
  derive: z.array(deriveAssetSchema).describe("衍生资产列表"),
});
const storyboardSchema = z.object({
  id: z.number().describe("分镜ID，必须为真实id"),
  duration: z.number().describe("持续时长(秒)"),
  prompt: z.string().describe("生成提示词"),
  associateAssetsIds: z.array(z.number()).describe("关联资产ID列表"),
  src: z.string().nullable().describe("分镜资源路径"),
  index: z.number().nullable().optional().describe("分镜排序字段"),
  groupKey: z.string().optional().describe("Storyboard group key"),
  groupName: z.string().optional().describe("Storyboard group name"),
  groupIntent: z.string().optional().describe("Storyboard group dramatic intent"),
  beatId: z.string().optional().describe("Beat id inside the storyboard group"),
  tableRowJson: z.string().nullable().optional().describe("唯一结构化分镜事实 JSON"),
  factStatus: z.enum(["draft", "ready", "legacy"]).optional().describe("分镜事实状态"),
  location: z.string().optional(),
  timeOfDay: z.string().optional(),
  picture: z.string().optional(),
  action: z.string().optional(),
  shotSize: z.string().optional(),
  cameraMove: z.string().optional(),
  dialogue: z.string().optional(),
  sound: z.string().optional(),
  visibleEmotion: z.string().optional(),
});
const workbenchDataSchema = z.object({
  name: z.string().describe("项目名称"),
  duration: z.string().describe("视频时长"),
  resolution: z.string().describe("分辨率"),
  fps: z.string().describe("帧率"),
  cover: z.string().optional().describe("封面图片路径"),
  gradient: z.string().optional().describe("渐变色配置"),
});
const beginStoryboardTableInputSchema = z.object({
  projectId: z.number().optional(),
  scriptId: z.number().optional(),
  expectedRowCount: z.number().int().positive(),
  groups: z.array(storyboardGroupPlanV2Schema).min(1),
});

const appendStoryboardRowsInputSchema = z.object({
  generationId: z.string().uuid(),
  startIndex: z.number().int().nonnegative(),
  rows: z.array(storyboardTableRowV2Schema).min(1).max(10),
});

const commitStoryboardTableInputSchema = z.object({
  generationId: z.string().uuid(),
});
const updateStoryboardPanelV2InputSchema = z.object({
  projectId: z.number().optional(),
  scriptId: z.number().optional(),
  items: z.array(
    z.object({
      storyboardId: z.number().optional(),
      index: z.number().optional(),
      prompt: z.string(),
      shouldGenerateImage: z.boolean(),
      associateAssetsIds: z.array(z.number()).optional().default([]),
    }),
  ),
});
const posterItemSchema = z.object({
  id: z.number().describe("海报ID"),
  image: z.string().describe("海报图片路径"),
});
export const flowDataSchema = z.object({
  script: z.string().describe("剧本内容"),
  scriptPlan: z.string().describe("拍摄计划"),
  assets: z.array(assetItemSchema).describe("衍生资产"),
  storyboardTable: z.string().describe("分镜表"),
  storyboard: z.array(storyboardSchema).describe("分镜面板"),
});

export type FlowData = z.infer<typeof flowDataSchema>;

const flowDataKeys = Object.keys(flowDataSchema.shape) as [keyof FlowData, ...Array<keyof FlowData>];
const keySchema = z.enum(flowDataKeys);
const flowDataKeyList = flowDataKeys.join(", ");
const flowDataKeyLabels = Object.fromEntries(
  Object.entries(flowDataSchema.shape).map(([key, schema]) => [key, (schema as z.ZodTypeAny).description ?? key]),
) as Record<keyof FlowData, string>;

interface ToolConfig {
  resTool: ResTool;
  toolsNames?: string[];
  msg: ReturnType<ResTool["newMessage"]>;
}

function scopedNumber(value: unknown, field: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`missing production agent ${field}`);
  return number;
}

function assertOptionalScopeMatches(input: { projectId?: number; scriptId?: number }, projectId: number, scriptId: number) {
  if (input.projectId != null && Number(input.projectId) !== projectId) {
    throw new Error(`projectId ${input.projectId} does not match current production agent projectId ${projectId}`);
  }
  if (input.scriptId != null && Number(input.scriptId) !== scriptId) {
    throw new Error(`scriptId ${input.scriptId} does not match current production agent scriptId ${scriptId}`);
  }
}

export default (toolCpnfig: ToolConfig) => {
  const { resTool, toolsNames, msg } = toolCpnfig;
  const { socket } = resTool;
  const tools: Record<string, Tool> = {
    get_flowData: tool({
      description: "获取工作区数据",
      inputSchema: jsonSchema<{ key: keyof FlowData }>(
        z
          .object({
            key: keySchema.describe("数据key"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ key }) => {
        const parsedKey = keySchema.safeParse(key);
        if (!parsedKey.success) {
          const message =
            `Unsupported flowData key: ${String(key)}. Available keys: ${flowDataKeyList}. ` +
            "director_planning_style is a skill; load it with activate_skill.";
          console.warn("[tools] get_flowData invalid key", key);
          return { error: message };
        }
        const flowKey = parsedKey.data;
        const thinking = msg.thinking(`正在获取${flowDataKeyLabels[flowKey]}工作区数据...`);
        console.log("[tools] get_flowData", flowKey);
        try {
        const flowData = await emitWithAckTimeout<FlowData>(socket, "getFlowData", { key: flowKey }, undefined, {
          agentName: "productionAgent",
          toolName: "get_flowData",
          projectId: resTool.data.projectId,
          scriptId: resTool.data.scriptId,
        });
        thinking.appendText(`获取到${flowDataKeyLabels[flowKey]}:\n` + JSON.stringify(flowData[flowKey], null, 2));
        thinking.updateTitle(`获取${flowDataKeyLabels[flowKey]}完成`);
        thinking.complete();
        return flowData[flowKey];
        } catch (error: any) {
          thinking.appendText(u.error(error).message);
          thinking.updateTitle?.("get_flowData failed");
          thinking.complete();
          throw error;
        }
      },
    }),
    begin_storyboard_table: tool({
      description: "Start an atomic storyboard-table generation and submit the complete group plan before writing rows.",
      inputSchema: jsonSchema<z.infer<typeof beginStoryboardTableInputSchema>>(beginStoryboardTableInputSchema.toJSONSchema()),
      execute: async (raw) => {
        const input = beginStoryboardTableInputSchema.parse(raw);
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        assertOptionalScopeMatches(input, projectId, scriptId);
        const thinking = msg.thinking("正在创建分镜表写入批次...");
        try {
          const result = await beginStoryboardGeneration({
            projectId,
            scriptId,
            expectedRowCount: input.expectedRowCount,
            groups: input.groups,
          });
          thinking.appendText(`generationId=${result.generationId}, expectedRows=${input.expectedRowCount}`);
          return result;
        } catch (error: any) {
          thinking.appendText(error?.message || String(error));
          thinking.updateTitle?.("storyboard table begin failed");
          throw error;
        } finally {
          thinking.complete();
        }
      },
    }),
    append_storyboard_rows: tool({
      description: "Append 1-10 authoritative structured storyboard rows. Retry identical rows safely after interruption.",
      inputSchema: jsonSchema<z.infer<typeof appendStoryboardRowsInputSchema>>(appendStoryboardRowsInputSchema.toJSONSchema()),
      execute: async (raw) => {
        const input = appendStoryboardRowsInputSchema.parse(raw);
        const thinking = msg.thinking(`正在写入分镜 ${input.startIndex + 1}-${input.startIndex + input.rows.length}...`);
        try {
          const result = await appendStoryboardRows(input);
          thinking.appendText(`accepted=${result.accepted}, nextIndex=${result.nextIndex}, issues=${result.issues.length}`);
          return result;
        } catch (error: any) {
          thinking.appendText(error?.message || String(error));
          thinking.updateTitle?.("storyboard rows append failed");
          throw error;
        } finally {
          thinking.complete();
        }
      },
    }),
    commit_storyboard_table: tool({
      description: "Validate all submitted rows and atomically replace the formal storyboard table.",
      inputSchema: jsonSchema<z.infer<typeof commitStoryboardTableInputSchema>>(commitStoryboardTableInputSchema.toJSONSchema()),
      execute: async (raw) => {
        const input = commitStoryboardTableInputSchema.parse(raw);
        const thinking = msg.thinking("正在校验并提交完整分镜表...");
        try {
          const result = await commitStoryboardGeneration(input.generationId);
          if (result.status === "committed") {
            thinking.appendText(`rows=${result.rowCount}, groups=${result.groupCount}, revision=${result.revision}`);
            thinking.updateTitle?.("storyboard table committed");
          } else if (result.status === "invalid") {
            thinking.appendText(JSON.stringify(result.issues));
            thinking.updateTitle?.("storyboard table validation failed");
          } else {
            const message =
              result.error.code === "COMMIT_IN_PROGRESS"
                ? "提交仍被后端任务占用，请稍后重试或重新开始分镜表生成。"
                : JSON.stringify(result.error);
            thinking.appendText(message);
            thinking.updateTitle?.("storyboard table commit failed");
          }
          return result;
        } catch (error: any) {
          thinking.appendText(error?.message || String(error));
          thinking.updateTitle?.("storyboard table commit failed");
          throw error;
        } finally {
          thinking.complete();
        }
      },
    }),
    update_storyboard_panel_v2: tool({
      description:
        "Update visual-generation fields for existing storyboard rows. It never creates storyboard rows and never rewrites storyboard-table narrative facts.",
      inputSchema: jsonSchema<z.infer<typeof updateStoryboardPanelV2InputSchema>>(
        updateStoryboardPanelV2InputSchema.toJSONSchema(),
      ),
      execute: async (raw) => {
        const input = updateStoryboardPanelV2InputSchema.parse(raw);
        const projectId = scopedNumber(resTool.data.projectId, "projectId");
        const scriptId = scopedNumber(resTool.data.scriptId, "scriptId");
        assertOptionalScopeMatches(input, projectId, scriptId);
        const updatedIds: number[] = [];
        const issues: Array<{ item: number; message: string }> = [];
        await u.db.transaction(async (trx) => {
          for (const [itemIndex, item] of input.items.entries()) {
            const query = trx("o_storyboard").where({ projectId, scriptId });
            if (item.storyboardId != null) query.andWhere("id", item.storyboardId);
            else if (item.index != null) query.andWhere("index", item.index);
            else {
              issues.push({ item: itemIndex, message: "storyboardId or index is required" });
              continue;
            }
            const storyboard = await query.first("id");
            if (!storyboard) {
              issues.push({ item: itemIndex, message: "storyboard not found" });
              continue;
            }
            const storyboardId = Number(storyboard.id);
            await trx("o_storyboard").where("id", storyboardId).update({
              prompt: item.prompt,
              shouldGenerateImage: item.shouldGenerateImage ? 1 : 0,
            });
            await trx("o_assets2Storyboard").where("storyboardId", storyboardId).del();
            const assetIds = [...new Set(item.associateAssetsIds || [])];
            if (assetIds.length) {
              await trx("o_assets2Storyboard").insert(assetIds.map((assetId) => ({ storyboardId, assetId })));
            }
            updatedIds.push(storyboardId);
          }
        });
        return { ok: issues.length === 0, updatedIds, issues };
      },
    }),
    add_deriveAsset: tool({
      description: "新增或更新衍生资产",
      inputSchema: jsonSchema<{ assetsId: number; id: number | null; name: string; desc: string }>(
        z
          .object({
            assetsId: z.number().describe("关联的资产ID"),
            id: z.number().nullable().describe("衍生资产ID,如果新增则为空"),
            name: z.string().describe("衍生资产名称"),
            desc: z.string().describe("衍生资产描述"),
          })
          .toJSONSchema(),
      ),
      execute: async (raw) => {
        // 容错：LLM 偶尔传 "null" 字符串或空串，统一规范为 null
        const idRaw = raw.id as unknown;
        const normalizedId = idRaw === "null" || idRaw === "" || idRaw === undefined ? null : (idRaw as number | null);
        const deriveAsset = { ...raw, id: normalizedId };

        const thinking = msg.thinking("正在操作资产...");
        const { projectId, scriptId } = resTool.data;
        const startTime = Date.now();
        const parentAssets = await u.db("o_assets").where("id", deriveAsset.assetsId).select("id", "type").first();
        if (!parentAssets) return "关联的资产不存在";

        const data = {
          id: deriveAsset.id ?? undefined,
          assetsId: deriveAsset.assetsId,
          projectId,
          name: deriveAsset.name,
          type: parentAssets.type,
          describe: deriveAsset.desc,
          startTime,
        };
        if (deriveAsset.id) {
          await u.db("o_assets").where("id", deriveAsset.id).update(data);
          thinking.appendText(`已更新衍生资产，ID: ${deriveAsset.id}\n`);
        } else {
          const [insertedId] = await u.db("o_assets").insert(data);
          data.id = insertedId;
          await u.db("o_scriptAssets").insert({ scriptId, assetId: insertedId });
          thinking.appendText(`已新增衍生资产，ID: ${insertedId}\n`);
        }
        const res = await emitWithAckTimeout(socket, "addDeriveAsset", data, undefined, {
          agentName: "productionAgent",
          toolName: "add_deriveAsset",
          projectId: resTool.data.projectId,
          scriptId: resTool.data.scriptId,
        }).catch((error: any) => {
          thinking.appendText(u.error(error).message);
          thinking.updateTitle?.("add_deriveAsset failed");
          thinking.complete();
          throw error;
        });
        thinking.updateTitle("资产操作完成");
        thinking.complete();
        return res ?? "操作成功";
      },
    }),
    del_deriveAsset: tool({
      description: "删除衍生资产",
      inputSchema: jsonSchema<{ assetsId: number; id: number }>(
        z
          .object({
            assetsId: z.number().describe("关联的资产ID"),
            id: z.number().describe("衍生资产ID"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ assetsId, id }) => {
        const thinking = msg.thinking("正在操作资产...");
        const { scriptId } = resTool.data;
        await u.db("o_assets").where("id", id).del();
        await u.db("o_scriptAssets").where({ scriptId, assetId: id }).del();
        thinking.appendText(`已删除衍生资产，ID: ${id}\n`);
        const res = await emitWithAckTimeout(socket, "delDeriveAsset", { assetsId, id }, undefined, {
          agentName: "productionAgent",
          toolName: "del_deriveAsset",
          projectId: resTool.data.projectId,
          scriptId: resTool.data.scriptId,
        }).catch((error: any) => {
          thinking.appendText(u.error(error).message);
          thinking.updateTitle?.("del_deriveAsset failed");
          thinking.complete();
          throw error;
        });
        thinking.updateTitle("资产操作完成");
        thinking.complete();
        return res ?? "删除成功";
      },
    }),
    generate_deriveAsset: tool({
      description: "生成衍生资产图片",
      inputSchema: jsonSchema<{ ids: number[] }>(
        z
          .object({
            ids: z.array(z.number()).describe("需要生成的 衍生资产ID"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在生成衍生资产...");
        new Promise((resolve) => socket.emit("generateDeriveAsset", { ids }, (res: any) => resolve(res)))
          .then((res) => {
            thinking.appendText(`已生成衍生资产，ID: ${JSON.stringify(res, null, 2)}\n`);
            thinking.updateTitle("衍生资产开始完成");
            thinking.complete();
          })
          .catch((e) => {
            thinking.appendText("衍生资产生成失败:\n" + u.error(e).message);
            thinking.updateTitle("衍生资产生成失败");
            thinking.complete();
          });

        return "开始生成衍生资产";
      },
    }),
    generate_storyboard: tool({
      description: "生成分镜图片",
      inputSchema: jsonSchema<{ ids: number[] }>(
        z
          .object({
            ids: z.array(z.number()).describe("必须获取真实的分镜ID，支持批量生成"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在生成分镜...");
        new Promise((resolve) => socket.emit("generateStoryboard", { ids }, (res: any) => resolve(res)))
          .then((res) => {
            thinking.appendText("生成的分镜数据:\n" + JSON.stringify(res, null, 2));
            thinking.updateTitle("分镜生成完成");
            thinking.complete();
          })
          .catch((e) => {
            thinking.appendText("分镜生成失败:\n" + u.error(e).message);
            thinking.updateTitle("分镜生成失败");
            thinking.complete();
          });

        return "开始生成分镜";
      },
    }),
  };

  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([n]) => toolsNames.includes(n))) : tools;
};
