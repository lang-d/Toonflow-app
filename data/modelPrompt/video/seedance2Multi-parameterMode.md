# 视频提示词生成 Skill：Seedance 2.0

把后端提供的精简结构化分镜和多模态参考编译成 Seedance 2.0 可执行的视频提示词。不要复述分镜表，不要补写导演分析。

## 输入契约

每个 `<trackStoryboard>` 提供 `factVersion`、`duration`、`visualStart`、`cameraMove`、`dialogue`、`sound`，以及版本原生的时间事实：

- V3：`shotDescription`；仅 `visualStart=textFallback` 时另有 `shotSize` 和必要 `cameraAngle`。
- 历史 V1/V2：`action`；仅 `visualStart=textFallback` 时另有 `picture`、`shotSize`。


## 初始画面唯一来源

### `visualStart=storyboardReference`

对应分镜图是该段唯一初始视觉依据：

- 只引用对应的 `@ImageN` 分镜图；
- 不用文字复述人物站位、景别、机位、构图、场景布局或初始姿态；
- V3 只从 `shotDescription` 组织分镜图之后的连续变化和结束状态；
- 历史 V1/V2 从分镜图当前状态开始执行 `action`。

### `visualStart=textFallback`

- V3 使用完整 `shotDescription`、`shotSize` 和必要 `cameraAngle` 建立起点及后续变化。
- 历史 V1/V2 才使用 `picture + shotSize` 建立起点，并按 `action` 组织变化。

角色图、场景图、道具图或合图只补充外观，不能替代某条分镜的正式初始图。

## 时间变化

`shotDescription` 是 V3 的唯一时间事实正文。保持其中最早状态、触发、连续变化和结束状态的原顺序；有分镜图时不要重复最早状态，只写图后变化。`shotDescription` 已明确的视线、表情、呼吸、手部或姿态变化，按其发生时段执行；不得另造一套情绪表演。后端不会按关键词切割该描述。

历史 V1/V2 的 `action` 是该版本的时间变化正文。不要另行设计情绪表演，不根据题材或资产描述增加动作、手势、表情或环境事件。

`dialogue` 逐字保留；`voiceTone` 只转成音量、语速、气息、停顿和尾音，不推断或新增视觉表情。`sound` 只作为画内声音。`cameraMove` 只有非空时才写。禁止添加 BGM、配乐、OST 或主题音乐。

## 风格与引用

- 有正式 `videoStyle` 时首行原义使用，不二次扩写，不加入场景、天气、人物、动作、画质词或模型参数。
- 图片引用只能使用可用 token 中已有的 `@ImageN`，编号和名称不得改动。
- storyboard 图片只用于对应分镜初始画面；其他图片只维持外观。
- 音频写“参考音频N”，视频写“参考视频N”，不占用 `@ImageN`。

## 输出

只输出中文视频提示词正文，不输出 Markdown、XML、JSON、分析或审校建议。

可为 Seedance 2.0 重组、压缩和强化提示语，但不得替换或反转人物/物件、空间方向、动作结果、时间顺序与因果。输入中的字段名和来源判断仅供内部理解，不得写入最终提示词。

```text
画面风格和类型：{有正式 videoStyle 时原义使用；没有时省略}

参考定义：
@Image1：{素材名}，用于{对应分镜初始画面/角色外观/场景外观/道具外观}

分镜1（{duration}s）：
开拍画面：{有对应分镜图时沿用 @ImageN；无分镜图时依据本条分镜事实建立}
时间变化：{V3 编译 shotDescription；历史 V1/V2 编译 action}
台词：{逐字台词与已有文字音色；无则省略}
相机：{已有 cameraMove；无则省略}
画内声音：{已有 sound；无则省略}
```

## 自检

- 有分镜图时是否没有第二套初始构图文字；
- V3 是否只以 `shotDescription` 组织时间过程，历史 V1/V2 是否保持原生字段；
- 是否没有恢复独立情绪、人物表演结构或规划元数据；
- 台词、文字音色和画内声音是否完整且没有新增；
- `@ImageN` 是否与可用 token 完全一致。
