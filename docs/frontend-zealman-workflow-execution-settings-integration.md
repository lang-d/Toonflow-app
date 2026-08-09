# Zealman 工作流执行参数：前端对接

本文档定义 `Toonflow-web` 在 Zealman 供应商卡片中展示和保存 H3 工作流质量参数的接口契约。后端本次不包含前端源码修改。

## 范围

- 两个模型各自保存一份工作流配置：
  - `minimax-h3-u06`
  - `minimax-h3-u06-light2v`
- 配置不按云端实例保存；前端不识别 GPU、显存，也不做搭配校验或自动降级。
- 工作台、模型选择和任务中心不需要新增字段。

## 读取

```http
POST /api/setting/zealman/getWorkflowExecutionConfig
Content-Type: application/json

{ "modelName": "minimax-h3-u06" }
```

响应 `data`：

```ts
type ExecutionValue = string | number | boolean;

{
  modelName: string;
  workflowId: string;
  instanceUrl: string;
  parameters: Array<{
    key: "baseModel" | "textEncoder" | "steps" | "superResolution";
    label: "底模" | "文本编码器" | "迭代步数" | "超分倍率";
    currentValue: ExecutionValue;
    ui: "select" | "number" | "toggle";
    options?: Array<string | number>;
    help?: string;
  }>;
  savedValues: Partial<Record<"baseModel" | "textEncoder" | "steps" | "superResolution", ExecutionValue>>;
  staleKeys: string[];
  recommendations: Array<{ hardware: string; unet: string; textEncoder: string }>;
}
```

后端从当前实例的完整工作流图定位主 H3 执行链，并从同一实例的模型扫描结果取得底模和文本编码器候选；不依赖 `api_config.enabledParams`。因此 API 工作流未发布参数时，仍应返回四项。

`superResolution` 对应快捷面板的“超清 2×”开关：`true` 保留完整执行图中的 `RTXVideoSuperResolution` 节点，`false` 按快捷面板同一规则移除该节点，并把下游无损回接到其原始画面输入。它绝不对应 `RIFEInterpolation.scale`；RIFE 是插帧链的一部分，不作为用户超分参数展示或写入。

- 初始值：`savedValues[key] ?? currentValue`。
- `ui: "select"` 使用 `options` 渲染下拉框；`ui: "number"` 使用数值控件。
- `recommendations` 仅作 hover/帮助提示，禁止自动填充。
- `staleKeys` 非空时，显示“云端工作流结构已变化，请重新保存或清空覆盖”。

## 保存与清空

```http
POST /api/setting/zealman/saveWorkflowExecutionConfig
Content-Type: application/json

{
  "modelName": "minimax-h3-u06",
  "values": {
    "baseModel": "minimax/minimax_h3_ref2va_pruned_bf16.safetensors",
    "textEncoder": "qwen3vl_32b_minimax_h3_bf16.safetensors",
    "steps": 12,
    "superResolution": true
  }
}
```

- `{}` 清空该工作流的用户覆盖值。
- 配置按工作流保存，不会被默认供应商同步覆盖。
- 前端不提交旧的 `节点ID:字段名` 形式，也不读写内部存储键。

## 运行语义

每项视频任务在选定实例后重新读取该实例最新模板，以语义键重新定位四项质量控件，再写入用户保存的值、素材、提示词、时长和尺寸。后端会校验返回的临时执行图仍保留这些值。

若云端工作流无法唯一定位主底模、主编码器、步数或最终超分，或者用户选定模型在当前实例没有安装，任务明确失败；不会切换质量档位、改写云端工作流或静默回退。
