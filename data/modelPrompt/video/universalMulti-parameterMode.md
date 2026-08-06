# 视频提示词生成 Profile：通用多参数模式

后端已经完成分镜选择和事实裁剪。不要重新读取导演规划、分镜面板 Prompt 或资产正文。

## 版本原生输入

- V3：`factVersion=3`，`shotDescription` 是 V3 的唯一时间事实正文；无正式分镜图时另有 `shotSize` 和必要 `cameraAngle`。
- 历史 V1/V2：`picture` 只在无正式分镜图时建立起点，`action` 描述时间变化。
- 所有版本还可包含 `duration`、`visualStart`、`cameraMove`、`dialogue` 和 `sound`。

不要查找或推断 `visibleEmotion`、`characters[]`、group 名称/意图、轴线、机位签名、导演规划全文或资产稳定描述。

## 初始视觉

- `visualStart=storyboardReference`：正式分镜图是唯一初始视觉依据，不复述或重排人物、景别、机位和构图。V3 只从 `shotDescription` 组织图片之后的变化和结尾。
- `visualStart=textFallback`：V3 使用完整 `shotDescription + shotSize + cameraAngle（如有）`；历史 V1/V2 使用 `picture + shotSize` 建立起点，再执行 `action`。
- 普通角色、场景和道具参考只维持外观，不能替代分镜图或改写媒介类型。

保持时间事实原顺序。V3 `shotDescription` 已明确的视线、表情、呼吸、手部或姿态变化，按其发生时段执行；不另造情绪表演或镜头剧情。逐字保留台词和已有音色说明；`voiceTone` 只表达声音，不能推断视觉表情；`sound` 只作画内声音；`cameraMove` 非空才写。不得加入 BGM、心理解释、画质堆叠词或模型参数。

## 输出

输出英文通用多参数视频提示词，台词正文保持原语言。只输出最终正文，不输出分析、JSON、Markdown、XML 或审核说明。

```text
[References]
@ImageN: [only the supplied reference binding]

[Instruction]
Segment 1 ({duration}s):
Initial source: {the storyboard image, or the version-native text fallback}.
Temporal change: {V3 shotDescription, or historical V1/V2 action}.
Camera: {cameraMove only when supplied}.
Dialogue: {dialogue}.
Diegetic sound: {sound}.
```
