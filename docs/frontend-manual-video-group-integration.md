# 手动添加视频组前端对接说明

## 背景

生成工作台底部已经有 `+` 入口，但旧版 `/production/workbench/addTrack` 只返回裸 `trackId`，且依赖当前模型时长配置。当前后端已改为创建完整的手动视频组，并返回前端可直接消费的 track 数据。

## 接口

`POST /api/production/workbench/addTrack`

请求体：

```ts
{
  projectId: number;
  scriptId: number;
  duration?: number;
  groupName?: string;
  groupIntent?: string;
  storyboardIds?: number[];
}
```

返回体：

```ts
{
  code: 200,
  data: {
    trackId: number,
    track: {
      id: number,
      duration: number,
      prompt: "",
      state: "未生成",
      reason: "",
      groupKey: "manual-{trackId}",
      groupName: string,
      groupIntent: string,
      musicPlan: null,
      reviewState: "pending",
      reviewIssues: [],
      selectVideoId: null,
      medias: [],
      videoList: []
    }
  }
}
```

## 前端建议流程

- 点击底部 `+` 时，建议打开弹窗填写视频组名称、时长，可选选择当前分镜。
- 如果前端暂时不做弹窗，可以直接创建空视频组：

```ts
const { data } = await axios.post("/production/workbench/addTrack", {
  projectId: project.value?.id,
  scriptId: episodesId.value ?? 0,
  duration,
  groupName: "手动视频组",
});
```

- 创建成功后优先使用 `data.track` 追加到 `trackList` 并选中。
- 如果仍选择刷新 `getGenerateData()`，刷新后应按 `data.trackId` 或 `data.track.id` 查找索引并选中，不要使用刷新前的 `trackList.length - 1`。
- 模型时长配置缺失时不要静默返回。建议 fallback 到默认时长，或让用户在弹窗中手动选择。
- 传入 `storyboardIds` 时，后端会把这些分镜移动到新视频组；不传时创建空视频组，用户可继续手动添加参考和提示词。

## 注意事项

- `groupKey` 由后端生成，前端不要自行拼接。
- 手动视频组的 `groupKey` 以 `manual-` 开头，不会覆盖自动分镜分组。
- 后端 `getGenerateData()` 已按 `id asc` 返回视频组，新建手动组会稳定出现在列表末尾。
