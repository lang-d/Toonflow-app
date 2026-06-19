# 视频提示词 · 视觉风格约束

生成视频提示词时，必须注入以下视觉风格标签：

| 模式 | 风格标签 |
|------|----------|
| **通用多参模式（英文）** | `mature urban romance anime, cel-shaded, cinematic lighting, cool tones, dramatic low-key shadows, clean line art` |
| **通用首尾帧模式（英文）** | `mature urban romance anime, cel-shaded, cinematic lighting, cool tones, dramatic low-key shadows, clean line art, shallow depth of field` |
| **Seedance 2.0（中文）** | `2D成熟都市言情动画，2D赛璐璐上色，电影级光影，冷色调，戏剧化低调光影，清晰线条` |

---

### 使用边界

- 风格标签只提供视觉基准，不覆盖分镜图、场景图、角色图和上游分镜事实。
- 不新增剧情、时间、地点、光影色调、人物关系、站位或朝向。
- 画内音效由视频模板处理；BGM/配乐/非画内音乐只作为后期建议，不写入视频提示词。
