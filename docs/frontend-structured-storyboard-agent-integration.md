# 前端对接：StoryboardTableRow V2 与分镜图/视频职责（历史）

> 新写入契约已经切换为 Storyboard V3。新前端请使用
> `docs/frontend-structured-storyboard-v3-integration.md`。本文只保留历史 V1/V2 数据说明，不能作为新写入契约。

## 核心变化

本文记录 V2 时期的历史契约；当前 Production Agent 新生成和新修订写 V3。历史 V1/V2 均保持原生可读，不迁移、不自动改写。

前端仍在 Agent 完成后刷新 `/production/getFlowData`，不解析 Agent XML，不从 `videoDesc`、分镜图片 Prompt 或聊天内容反向构造分镜事实。

## V2 类型

```ts
type StoryboardTableRowV2 = {
  version: 2;
  index: number;
  sceneNo?: string;
  groupKey: string;
  beatId: string;
  durationSec: number;
  location: string;
  timeOfDay: string;
  sceneContinuityId?: string;
  picture: string;
  action: string;
  shotSize: string;
  cameraMove?: string;
  cameraAngle?: string;
  transitionFromPrevious?: string;
  dialogue: Array<{ speaker: string; text: string; voiceTone?: string }>;
  soundEffects: string[];
  requiredAssets: Array<{
    assetId: number;
    name: string;
    type: "role" | "scene" | "tool" | "clip";
    order: number;
  }>;
};
```

V2 不包含：

- `visibleEmotion`；
- `characters[]` 及其 position/posture/expression/gaze/handAction/movement；
- 行级 `groupName/groupIntent`。

`groupName/groupIntent` 继续由正式 group plan/视频轨投影，兼容 API 可以返回；它们不在每一行 JSON 中重复保存。

## 字段职责

### `picture`

只描述镜头开始时的静态画面，是分镜图生成的唯一画面事实：人物、初始站位/朝向、关键物件位置、初始姿态、景别和构图重点。

### `action`

只描述视频时间变化：触发、动作过程、可见表演/物件变化和镜头结束状态。前端不要把它拆回独立情绪或人物表演表单。

### 兼容展示

- 历史 V1：继续解析旧字段并展示。
- V2：旧兼容字段 `visibleEmotion/characters` 可能为空，不能据此判定数据丢失。
- 分镜表 Markdown 已按 V2 输出“起始画面 / 主要动作”等列。

## 分镜面板输入

分镜面板 Agent只消费：

- `picture`
- `shotSize`
- 可选 `cameraAngle`
- `requiredAssets`
- 短视觉原则

完整 `action` 不进入分镜图 Prompt 编译，避免模型自行选择动作中途或结束帧。前端仍只展示/编辑后端保存的 `prompt`、`associateAssetsIds` 与 `shouldGenerateImage`。

## 视频 Prompt 输入

当前视频生成请求实际提交的引用决定是否有正式分镜图：

- 有直接 storyboard 图片引用：该图是对应分镜唯一初始视觉依据，后端不再向编译模型传该镜 `picture/shotSize/cameraAngle/站位构图`；
- 没有直接 storyboard 图片引用：后端才传 `picture + shotSize` 作为文字兜底；
- 合图、角色图、场景图和道具图不自动冒充某一镜的正式分镜图。

两种情况都只用 `action` 表达时间变化，并保留时长、台词/文字音色、画内声音和必要 `cameraMove`。

前端不需要自行裁剪 Prompt 上下文，但必须保持引用的真实 `sources` 和 ID，不能把普通合图标成 storyboard。

## 前端后续调整

- 仅查看或原生编辑历史 V2 时按本页字段解释；新建与新修订必须按 V3 对接文档提交。
- 旧 V1/V2 页面仍可读取原生字段，但不能把旧字段拼装成 V3。
- 不根据 `picture` 和分镜图做前端语义一致性检测；偏移由分镜面板审核或用户重新选择/生成图片处理。
- 不修改视频 Prompt 内的风格来源；后端使用当前正式导演规划 `videoStyle`。
