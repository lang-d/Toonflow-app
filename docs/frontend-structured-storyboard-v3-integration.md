# 结构化分镜 V3 前端对接

## 范围

后端新生成和新修订的正式分镜使用 `StoryboardTableRowV3`。历史 V1/V2 继续按原版本读取，不自动升级、降级或拼接。

前端必须区分“正式分镜事实编辑”和“分镜面板派生字段编辑”，不能再用一次请求同时保存两类数据。

## 正式数据结构

```ts
type StoryboardTableRowV3 = {
  version: 3;
  index: number;
  sceneNo?: string;
  groupKey: string;
  beatId: string;
  durationSec: number;
  location: string;
  timeOfDay: string;
  sceneContinuityId?: string;

  shotDescription: string;

  shotSize: string;
  cameraMove?: string;
  cameraAngle?: string;
  transitionFromPrevious?: string;

  dialogue: Array<{
    speaker: string;
    text: string;
    voiceTone?: string;
  }>;
  soundEffects: string[];
  requiredAssets: Array<{
    assetId: number;
    name: string;
    type: "role" | "scene" | "tool" | "clip";
    order: number;
  }>;
};
```

V3 不包含 `picture`、`action`、`characters`、`visibleEmotion`、行级 `groupName` 或行级 `groupIntent`。

`tableRowJson` 是正式事实唯一来源。接口为了列表和编辑便利返回的顶层 `shotDescription`、`shotSize` 等字段只是当前原生版本的读取投影，不是第二份可独立保存的数据。

## `shotDescription`

它按自然时间顺序描述一个镜头：

```text
最早成立的可见状态 → 触发 → 连续变化 → 结束状态
```

前端应作为一段完整文本显示和编辑，不拆成“起始画面”和“主要动作”两个输入框，也不根据“随后、最终”等文字自行解析。

## 读取与版本

- `storyboardFactWriteVersion` 为后端当前新写入版本；完成 V3 部署后值为 `3`。
- 每行依据 `tableRowJson.version` 使用原生编辑器：V1、V2、V3 不互相拼装。
- V3 Ready 才能进入分镜图和视频阶段。`factStatus !== "ready"` 时，前端应显示为草稿/不完整并禁用生成入口。
- 历史 V1/V2 的 `picture/action` 仍按原字段展示，不能在前端合成为 V3。

## 分镜面板派生字段写入

```http
POST /api/production/storyboard/panel/update
Content-Type: application/json
```

```ts
{
  projectId: number;
  scriptId: number;
  storyboardId: number;
  prompt: string;
  shouldGenerateImage: boolean;
  associateAssetsIds: number[];
  referenceImages: StoryboardReference[];
}
```

该接口只更新图片 Prompt、生成开关、关联资产和参考图：

- 不接收 `tableRowJson`；
- 不修改正式分镜事实；
- 不增加 `factRevision`。

分镜面板关联资产只应包含首帧真实可见的 `requiredAssets` 子集，不应因为某资产在镜头后半段出现就提前绑定。

## 正式分镜事实编辑

```http
POST /api/production/storyboard/facts/update
Content-Type: application/json
```

```ts
{
  projectId: number;
  scriptId: number;
  storyboardId: number;
  tableRowJson: StoryboardTableRowV1 | StoryboardTableRowV2 | StoryboardTableRowV3;
}
```

- 必须提交完整、版本原生的 JSON；
- `tableRowJson.index` 必须与目标分镜一致；
- 成功后 `factRevision` 增加；
- 不修改分镜图片 Prompt、生成开关、关联资产或参考图；
- 后端不会猜测缺失字段，也不会把旧版本请求自动改造成 V3。

## 分镜图与视频阶段

- V3 分镜图由 `shotDescription` 中最早明确、可见、能自然启动后续动作的状态生成。
- 无可信首帧时该镜应保持 `shouldGenerateImage=false`，交回分镜表修订，前端不应提示用户在分镜面板补造正式事实。
- 有正式分镜图时，视频阶段以图片作为唯一开拍视觉依据；不会再传另一套文字构图。
- 无正式分镜图时，视频阶段才使用完整 `shotDescription`、`shotSize` 和必要 `cameraAngle` 建立画面。

## 前端迁移要求

1. 列表和详情根据 `version` 渲染原生字段。
2. V3 将“起始画面 / 主要动作”替换为单一“镜头描述”。
3. 分镜面板保存切换到 `/panel/update`。
4. 正式事实保存切换到 `/facts/update`。
5. 不再向同一保存接口混传 `prompt/referenceImages` 与 `tableRowJson`。
6. 不在前端推断、补齐或升级分镜版本。

