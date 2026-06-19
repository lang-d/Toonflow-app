# 视频提示词 · 视觉风格约束

生成视频提示词时，必须注入以下视觉风格标签：

| 模式 | 风格标签 |
|------|----------|
| **通用多参模式（英文）** | `live-action urban cinema, real human actors photography, contemporary Chinese urban setting, cinematic color science, natural light and practical lighting, shallow depth of field, handheld camera breathing, smooth Steadicam movement, film grain texture, motion blur for video, cinematic frame rate, non-CGI non-rendered` |
| **通用首尾帧模式（英文）** | `live-action urban cinema, real human actors photography, contemporary Chinese urban setting, cinematic color science, natural light and practical lighting, rack focus, focal plane locking, shallow depth of field, cinematic bokeh, film grain texture, non-CGI non-rendered` |
| **Seedance 2.0（中文）** | `真人都市电影摄影，真人实拍质感，当代中国都市，电影级色彩科学，自然光与实用光源调度，浅景深，手持呼吸感或稳定器流动，电影颗粒质感，视频动态优化，非CG非渲染` |

---

### 使用边界

- 风格标签只提供视觉基准，不覆盖分镜图、场景图、角色图和上游分镜事实。
- 不新增剧情、时间、地点、光影色调、人物关系、站位或朝向。
- 画内音效由视频模板处理；BGM/配乐/非画内音乐只作为后期建议，不写入视频提示词。
