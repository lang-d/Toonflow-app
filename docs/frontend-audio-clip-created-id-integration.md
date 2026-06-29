# Frontend Audio Clip Created ID Integration

## Background

In the cornerScape audio clipping flow, the frontend creates a new audio asset and then binds it to the current visual asset. The old `/assets/addAudioAssets` response only returned a message, so the frontend had to search by name to recover the newly created audio ID. That fallback can fail when the parent audio asset name differs from the child audio file name, for example `clip` versus `clip.wav`.

## Backend Response

`POST /assets/addAudioAssets` keeps the existing request body and database model. On success, `response.data` now includes the created parent audio asset and its child audio file assets:

```ts
{
  message: string;
  audioAsset: {
    id: number;
    name: string;
    describe: string;
    type: "audio";
    projectId: number;
    sonAssets: Array<{
      id: number;
      assetsId: number;
      name: string;
      describe: string;
      prompt: string;
      type: "audio";
      imageId: number;
      projectId: number;
      filePath: string;
      src: string;
    }>;
  } | null;
}
```

`POST /assets/updateAudioAssets` returns the same `audioAsset` shape after updating.

## CornerScape Clip Flow

For "clip audio and bind":

1. Call `/assets/addAudioAssets` as before.
2. Read the new bindable audio ID from `response.data.audioAsset.sonAssets[0].id`.
3. Call `/cornerScape/updateAssetsAudio` with:

```ts
{
  assetsId: currentVisualAssetId,
  audioIds: [response.data.audioAsset.sonAssets[0].id]
}
```

The ID used for binding is the child audio file asset ID, not the parent audio asset ID.

## Compatibility

Keep the existing name-query fallback only for old backend builds. New frontend code should prefer the returned `sonAssets[0].id` and should not depend on searching by the generated file name.

No frontend route or payload change is required for existing asset-center audio creation. Existing callers that ignore the response body remain compatible.
