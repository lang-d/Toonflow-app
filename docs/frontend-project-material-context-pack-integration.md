# 前端项目资料与项目制作参考包对接

## 背景
- 剧本上传继续只用于单集/分集剧本，写入现有 `o_script`。
- 大纲、人物设定、世界观、场景设定、配乐参考等资料走新的项目资料接口。
- 后端只保存资料文件和短元数据，原始正文不入库。

## 项目资料分类
`category` 只能取以下值：

```ts
type ProjectMaterialCategory =
  | "outline"
  | "character"
  | "world"
  | "scene"
  | "prop"
  | "visual"
  | "director"
  | "music"
  | "notes";
```

建议前端显示为：
- 大纲：`outline`
- 人物设定：`character`
- 世界观：`world`
- 场景设定：`scene`
- 道具设定：`prop`
- 视觉参考：`visual`
- 导演参考：`director`
- 配乐参考：`music`
- 补充说明：`notes`

## 上传资料
`POST /api/project/material/upload`

```ts
{
  projectId: number,
  category: ProjectMaterialCategory,
  name: string,
  base64Data?: string,
  textContent?: string,
  mime?: string
}
```

说明：
- `txt/md/json/csv` 可以直接作为 `base64Data` 或 `textContent` 上传。
- `pdf/docx` 等文件第一版后端不解析；前端如果能提取文本，请同时传 `textContent`。
- 后端会保存原文件；如果有 `textContent`，会额外保存模型可读 `.txt`。
- 返回只包含元数据，不返回全文。

## 列表
`GET /api/project/material/list?projectId=123&category=outline`

返回：

```ts
{
  materials: Array<{
    id: number,
    projectId: number,
    category: ProjectMaterialCategory,
    name: string,
    filePath: string,
    mime: string,
    ext: string,
    size: number,
    textPath?: string | null,
    textSize?: number | null,
    summary?: string,
    state: "ready" | "unsupported" | "failed" | "archived",
    createTime: number,
    updateTime: number
  }>
}
```

默认不返回 `archived`。

## 分页读取文本
`GET /api/project/material/read?id=1&projectId=123&offset=0&limit=65536`

只读取模型可读文本：
- 文本类文件直接读原文件。
- 非文本文件只有上传时提供了 `textContent` 才能读取。
- 大文件用 `offset/limit` 分页。

## 删除资料
`POST /api/project/material/delete`

```ts
{
  projectId: number,
  id: number
}
```

当前后端执行软归档，列表默认不再显示，不物理删除原文件。

## 项目制作参考包
生成：

`POST /api/project/contextPack/generate`

```ts
{
  projectId: number,
  // 可选：用户在生成对话框里输入的调整要求
  instruction?: string,
  // 可选：上一版参考包正文。传入后表示“按用户指令调整上一版”
  previousContent?: string
}
```

返回：

```ts
{
  contextPack: {
    id: number,
    projectId: number,
    targetType: "projectContextPack",
    targetId: "project",
    version: number,
    state: "complete",
    filePath: string,
    createTime: number,
    updateTime: number
  },
  content: string,
  review: {
    status: "passed",
    issues: Array<{
      severity: "info" | "warning",
      message: string,
      reason?: string
    }>
  }
}
```

读取：

`GET /api/project/contextPack/get?projectId=123`

说明：
- 参考包生成成功即保存为项目级 `textAsset(targetType="projectContextPack", state="complete")`。
- 生成失败、XML 不完整或内部审核阻断时，不覆盖上一版。
- 后端会完整处理全部 `ready` 项目资料；长资料在服务端分段压缩后再汇总，避免只读取开头而遗漏后置的人物、声音或资产设定。因此生成耗时会随资料长度增加，前端应继续以任务状态展示进度，不应自行截断资料后再提交。
- 它不保存原始资料正文。
- 生成失败不影响剧本上传、资产提取、单集创作。
- 前端建议做成“生成对话框”：用户可输入生成/调整指令，展示生成过程和最终内容；继续调整时复用同一个 generate 接口，把当前内容作为 `previousContent` 传回。
- 后端要求模型输出完整 `<projectContextPack>...</projectContextPack>`，接口只返回标签内 Markdown 正文。
- “资产复用参考”除复用关系外，还包含项目资料明确的角色稳定外形、角色声音/台词表现、场景固定空间和道具稳定结构。角色声音是制作参考，不代表 TTS 音色 ID、真人模仿或自动配音绑定。

## 页面建议
- 剧本上传页保持现状，只处理 `o_script`。
- 在项目详情或项目设置中增加“项目资料”入口。
- 按分类展示资料卡片，支持上传、粘贴文本、查看摘要、删除。
- 另设“项目制作参考包”区域，支持打开生成对话框、查看最新版本、基于当前内容继续调整。
- 生成对话框建议抽象成公共组件，后续可复用于导演规划、提示词润色等“用户指令 -> 模型生成完整产物”的场景。
