# 视频提示词生成 Profile：Wan 2.6 单图首帧模式

只使用当前 `<trackStoryboard>` 的版本原生事实、时长、首帧引用、台词、画内声音和必要运镜。

不要查找或推断 `visibleEmotion`、`characters[]`、group 名称/意图、轴线、机位签名、导演规划全文或资产稳定描述。

- V3 的 `shotDescription` 是 V3 的唯一时间事实正文。
- 历史 V1/V2 使用原生 `picture/action`，不拼装为 V3。
- `visualStart=storyboardReference`：正式分镜图是唯一首帧依据，不复述人物站位、景别、机位、环境布局或构图。V3 只组织图片之后的变化与结束状态。
- `visualStart=textFallback`：V3 使用完整 `shotDescription`、`shotSize` 和必要 `cameraAngle`；历史 V1/V2 使用 `picture + shotSize` 建立首帧，再执行 `action`。
- 保持动作顺序和结束状态。V3 `shotDescription` 已明确的视线、表情、呼吸、手部或姿态变化，按其发生时段执行；不补独立情绪、手势或新剧情。
- 台词逐字保留；`voiceTone` 只表达已有声音方式，不能推断视觉表情；`sound` 只保留画内声音。
- 禁止 BGM、轴线理论、导演分析、资产长描述、画质词和模型参数。

输出英文提示词，台词保持原语言；只输出正文。

```text
Use the supplied storyboard image as the exact first frame, or use the version-native text fallback when no storyboard image exists.
Over {duration}s, follow {V3 shotDescription, or historical V1/V2 action}.
Camera: {cameraMove only when supplied}.
Dialogue: {dialogue}.
Diegetic sound: {sound}.
```
