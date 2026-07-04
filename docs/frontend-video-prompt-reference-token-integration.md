# 视频工作台引用 Token 对接说明

## 背景

视频模型使用的图片引用编号是后端按最终提交给模型的图片顺序生成的 `@ImageN`。前端原来的“参考1/参考2”只是列表展示编号，和模型提示词里的 `@ImageN` 不一定一致，尤其存在合并分镜图、音频、视频引用时容易误判。

## 接口变化

`/api/production/workbench/getGenerateData` 的 `trackList[].medias[]` 兼容原字段，并新增：

- `inputOrder`: 当前工作台引用列表顺序，从 1 开始。
- `referenceToken`: 推荐展示 token。图片为 `@ImageN`，音频为 `参考音频N`，视频为 `参考视频N`。
- `visualToken` / `visualImageIndex`: 图片引用专用。
- `audioToken` / `audioReferenceIndex`: 音频引用专用。
- `videoToken` / `videoReferenceIndex`: 视频引用专用。

## 前端展示建议

- 引用列表优先展示 `referenceToken`，例如 `@Image2 清晨版`、`参考音频1 环境声`。
- 不再只展示“参考1/参考2”，避免和模型 prompt 中的 `@ImageN` 混淆。
- 合并分镜图如果存在，也正常显示为一个图片 token，例如 `@Image7 合并分镜图`。
- 生成提示词里的“参考定义”会固定列出所有可用 `@ImageN`，前端无需自行重排。

## 注意

如果前端允许用户临时取消部分引用，最终提交给 `/generateVideoPrompt` 的 `info` 顺序仍决定真实模型 token。取消引用后，前端应按提交列表重新计算或以接口刷新后的 token 为准。
