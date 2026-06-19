# 视频提示词 · 视觉风格约束

生成视频提示词时，必须注入以下视觉风格标签：

| 模式 | 风格标签 |
|------|----------|
| **通用多参模式（英文）** | `3D anime render, cel-shaded 3D, cinematic lighting, warm tones, high-detail textures, clear outlines` |
| **通用首尾帧模式（英文）** | `3D anime render, cel-shaded 3D, cinematic lighting, warm tones, high-detail textures, clear outlines, shallow depth of field` |
| **Seedance 2.0（中文）** | `3D动画渲染，赛璐珞质感，电影级光影，温暖色调，高细节材质，清晰轮廓线` |

---

### 使用边界

- 风格标签只提供视觉基准，不覆盖分镜图、场景图、角色图和上游分镜事实。
- 不新增剧情、时间、地点、光影色调、人物关系、站位或朝向。
- 画内音效由视频模板处理；BGM/配乐/非画内音乐只作为后期建议，不写入视频提示词。
