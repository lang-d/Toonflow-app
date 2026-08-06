# 视频提示词生成 Profile：通用首尾帧模式

只使用当前 `<trackStoryboard>` 的版本原生事实、时长、首尾帧引用、台词、画内声音和必要运镜。

不要查找或推断 `visibleEmotion`、`characters[]`、group 名称/意图、轴线、机位签名、导演规划全文或资产稳定描述。

- V3 的 `shotDescription` 是 V3 的唯一时间事实正文。
- 历史 V1/V2 使用原生 `picture/action`，不拼装为 V3。
- `visualStart=storyboardReference` 或存在首尾帧引用时，引用图是相应帧的唯一视觉依据；不得文字复述或重排人物、景别、机位和构图。
- `visualStart=textFallback` 或无首帧图时，V3 使用完整 `shotDescription`、`shotSize` 和必要 `cameraAngle`。
- V3 有首帧图时，只把 `shotDescription` 中首帧之后的连续变化组织到尾帧。
- 历史 V1/V2 无首帧图时才用 `picture + shotSize` 建立起点，再按 `action` 变化。
- V3 `shotDescription` 已明确的视线、表情、呼吸、手部或姿态变化，按其发生时段组织；首帧既成状态不重复写成后续反应，也不另造情绪表演。
- 台词逐字保留，`voiceTone` 仅使用已有声音表达，不能推断视觉表情；声音仅保留画内来源。
- 禁止增加 BGM、剧情、情绪结构、轴线理论、资产描述、画质词和模型参数。

输出英文提示词，台词保持原语言；只输出正文。

```text
First frame: {use the supplied frame, or the version-native text fallback}.
Over {duration}s: {V3 shotDescription, or historical V1/V2 action}.
Last frame: {use the supplied last frame when present; otherwise only the confirmed ending state}.
Camera: {cameraMove only when supplied}.
Dialogue: {dialogue}.
Diegetic sound: {sound}.
```
