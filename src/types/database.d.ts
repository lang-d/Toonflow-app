// @db-hash 53e7a226b0f9d6674b6d06b06b5a66f0
//该文件由脚本自动生成，请勿手动修改

export interface memories {
  'content': string;
  'createTime': number;
  'embedding'?: string | null;
  'id'?: string;
  'isolationKey': string;
  'name'?: string | null;
  'relatedMessageIds'?: string | null;
  'role'?: string | null;
  'summarized'?: number | null;
  'type': string;
}
export interface o_agentDeploy {
  'desc'?: string | null;
  'disabled'?: boolean | null;
  'id'?: number;
  'key'?: string | null;
  'maxOutputTokens'?: number | null;
  'model'?: string | null;
  'modelName'?: string | null;
  'name'?: string | null;
  'temperature'?: number | null;
  'type'?: string | null;
  'vendorId'?: string | null;
}
export interface o_agentRun {
  'agentKey': string;
  'createdAt': number;
  'currentStage'?: string | null;
  'currentSubAgent'?: string | null;
  'errorJson'?: string | null;
  'finishedAt'?: number | null;
  'heartbeatAt': number;
  'id'?: number | null;
  'isolationKey': string;
  'messageId'?: string | null;
  'projectId': number;
  'reason'?: string | null;
  'resultJson'?: string | null;
  'runId': string;
  'scriptId': number;
  'startedAt': number;
  'status': string;
  'updatedAt': number;
}
export interface o_agentRunEvent {
  'createdAt': number;
  'eventType': string;
  'id'?: number | null;
  'payloadJson'?: string | null;
  'runId': string;
}
export interface o_agentWorkData {
  'createTime'?: number | null;
  'data'?: string | null;
  'episodesId'?: number | null;
  'id'?: number;
  'key'?: string | null;
  'projectId'?: number | null;
  'updateTime'?: number | null;
}
export interface o_artStyle {
  'fileUrl'?: string | null;
  'id'?: number;
  'label'?: string | null;
  'name'?: string | null;
  'prompt'?: string | null;
}
export interface o_assets {
  'assetsId'?: number | null;
  'audioBindState'?: number | null;
  'describe'?: string | null;
  'flowId'?: number | null;
  'foundationErrorReason'?: string | null;
  'foundationStatus'?: string | null;
  'foundationText'?: string | null;
  'id'?: number;
  'imageId'?: number | null;
  'name'?: string | null;
  'projectId'?: number | null;
  'prompt'?: string | null;
  'promptErrorReason'?: string | null;
  'promptState'?: string | null;
  'remark'?: string | null;
  'scriptId'?: number | null;
  'startTime'?: number | null;
  'type'?: string | null;
}
export interface o_assets2Storyboard {
  'assetId'?: number;
  'storyboardId'?: number;
}
export interface o_assetsRole2Audio {
  'assetsAudioId'?: number;
  'assetsRoleId'?: number;
}
export interface o_directorAsset {
  'assetId': number;
  'assetType': string;
  'camera'?: string | null;
  'createTime': number;
  'flowId'?: number | null;
  'id'?: number;
  'imageId': number;
  'name': string;
  'nodeId': string;
  'projectId': number;
  'promptFragment'?: string | null;
  'scriptId'?: number | null;
  'sourceRefs': string;
  'stageDraft'?: string | null;
  'targetId'?: number | null;
  'targetType'?: string | null;
  'updateTime': number;
}
export interface o_directorPlanGeneration {
  'contentHash'?: string | null;
  'createdAt': number;
  'errorJson'?: string | null;
  'expectedSectionCount': number;
  'generationId': string;
  'id'?: number | null;
  'projectId': number;
  'scriptId': number;
  'state': string;
  'textAssetId'?: number | null;
  'updatedAt': number;
  'version'?: number | null;
}
export interface o_directorPlanGenerationChunk {
  'chunkIndex': number;
  'content': string;
  'contentHash': string;
  'createdAt': number;
  'generationId': string;
  'id'?: number | null;
  'sectionKey': string;
  'updatedAt': number;
}
export interface o_editImageTask {
  'createTime'?: number | null;
  'deriveAssetId'?: number | null;
  'flowId'?: number | null;
  'id'?: number;
  'model'?: string | null;
  'nodeId'?: string | null;
  'projectId'?: number | null;
  'prompt'?: string | null;
  'quality'?: string | null;
  'ratio'?: string | null;
  'reason'?: string | null;
  'references'?: string | null;
  'scriptId'?: number | null;
  'state'?: string | null;
  'status'?: string | null;
  'targetId'?: number | null;
  'targetType'?: string | null;
  'taskCenterId'?: number | null;
  'updateTime'?: number | null;
  'url'?: string | null;
}
export interface o_event {
  'createTime'?: number | null;
  'detail'?: string | null;
  'id'?: number;
  'name'?: string | null;
}
export interface o_eventChapter {
  'eventId'?: number | null;
  'id'?: number;
  'novelId'?: number | null;
}
export interface o_image {
  'assetsId'?: number | null;
  'errorReason'?: string | null;
  'filePath'?: string | null;
  'id'?: number;
  'model'?: string | null;
  'resolution'?: string | null;
  'state'?: string | null;
  'type'?: string | null;
}
export interface o_imageFlow {
  'flowData': string;
  'id'?: number;
}
export interface o_modelPrompt {
  'fileName'?: string | null;
  'id'?: number;
  'model'?: string | null;
  'path'?: string | null;
  'vendorId'?: string | null;
}
export interface o_musicBible {
  'content': string;
  'createTime': number;
  'id'?: number;
  'projectId': number;
  'sourceSummaryJson'?: string;
  'state'?: string;
  'styleProfileJson'?: string;
  'title'?: string | null;
  'updateTime': number;
  'version': number;
}
export interface o_musicCue {
  'createTime': number;
  'cueKey': string;
  'cueType': string;
  'durationConfidence'?: string | null;
  'durationMode'?: string | null;
  'durationSec'?: number | null;
  'endRefJson'?: string;
  'estimatedDurationSec'?: number | null;
  'estimatedMaxDurationSec'?: number | null;
  'estimatedMinDurationSec'?: number | null;
  'id'?: number;
  'musicSpecJson'?: string;
  'narrativePurpose'?: string | null;
  'planId': number;
  'planVersion': number;
  'projectId': number;
  'promptBrief'?: string | null;
  'scriptId'?: number | null;
  'startRefJson'?: string;
  'state'?: string;
  'title'?: string | null;
  'updateTime': number;
}
export interface o_musicCueAsset {
  'assetsId'?: number | null;
  'childAssetId'?: number | null;
  'compiledPromptJson'?: string;
  'createTime': number;
  'cueId': number;
  'errorReason'?: string | null;
  'id'?: number;
  'model'?: string | null;
  'projectId': number;
  'prompt'?: string | null;
  'selected'?: number;
  'state'?: string;
  'updateTime': number;
  'version': number;
}
export interface o_musicCueBinding {
  'createTime': number;
  'cueId': number;
  'editionId'?: number | null;
  'id'?: number;
  'libraryVersionId'?: number | null;
  'projectId': number;
  'scriptId'?: number | null;
  'state'?: string;
  'suggestedUseDurationSec'?: number | null;
  'updateTime': number;
  'usageMode': string;
}
export interface o_musicLibraryEdition {
  'createTime': number;
  'editionKey': string;
  'editionType': string;
  'episodeEnd'?: number | null;
  'episodeStart'?: number | null;
  'id'?: number;
  'language'?: string | null;
  'libraryItemId': number;
  'musicSpecJson'?: string;
  'narrativePhase'?: string | null;
  'parentEditionId'?: number | null;
  'projectId': number;
  'selectedVersionId'?: number | null;
  'state'?: string;
  'title'?: string | null;
  'updateTime': number;
  'vocalMode'?: string;
}
export interface o_musicLibraryItem {
  'bibleId'?: number | null;
  'bibleVersion'?: number | null;
  'createTime': number;
  'id'?: number;
  'narrativeRole'?: string | null;
  'projectId': number;
  'relatedItemId'?: number | null;
  'relationType'?: string | null;
  'reuseScope'?: string;
  'state'?: string;
  'title'?: string | null;
  'updateTime': number;
  'workKey': string;
  'workType': string;
}
export interface o_musicLibraryVersion {
  'assetsId'?: number | null;
  'childAssetId'?: number | null;
  'createTime': number;
  'derivationType'?: string;
  'editionId': number;
  'effectiveMusicDurationSec'?: number | null;
  'errorReason'?: string | null;
  'fadeInMs'?: number | null;
  'fadeOutMs'?: number | null;
  'generationConfigHash'?: string | null;
  'generationConfigJson'?: string;
  'generationDurationSec'?: number | null;
  'id'?: number;
  'legacyCueAssetId'?: number | null;
  'lyricsHash'?: string | null;
  'lyricsVersionId'?: number | null;
  'model'?: string | null;
  'projectId': number;
  'promptHash'?: string | null;
  'promptVersionId'?: number | null;
  'sourceVersionId'?: number | null;
  'state'?: string;
  'trimEndMs'?: number | null;
  'trimStartMs'?: number | null;
  'updateTime': number;
  'version': number;
}
export interface o_musicLyricsVersion {
  'basedOnId'?: number | null;
  'content': string;
  'createTime': number;
  'editionId': number;
  'hash': string;
  'id'?: number;
  'language'?: string | null;
  'projectId': number;
  'reviewStatus'?: string;
  'source'?: string;
  'state'?: string;
  'title'?: string | null;
  'updateTime': number;
  'version': number;
}
export interface o_musicPlan {
  'bibleId': number;
  'bibleVersion': number;
  'content': string;
  'createTime': number;
  'cueSheetJson'?: string;
  'id'?: number;
  'libraryPlanJson'?: string | null;
  'mode': string;
  'projectId': number;
  'recommendedProductionJson'?: string | null;
  'scriptId'?: number | null;
  'state'?: string;
  'updateTime': number;
  'version': number;
}
export interface o_musicPromptVersion {
  'basedOnId'?: number | null;
  'createTime': number;
  'cueId'?: number | null;
  'editionId'?: number | null;
  'generationConfigJson'?: string;
  'hash': string;
  'id'?: number;
  'lyricsVersionId'?: number | null;
  'model': string;
  'negativePrompt'?: string | null;
  'profileSource'?: string | null;
  'projectId': number;
  'prompt': string;
  'promptMode'?: string | null;
  'reviewStatus'?: string;
  'scriptId'?: number | null;
  'source'?: string;
  'state'?: string;
  'targetType': string;
  'updateTime': number;
  'version': number;
}
export interface o_novel {
  'chapter'?: string | null;
  'chapterData'?: string | null;
  'chapterIndex'?: number | null;
  'createTime'?: number | null;
  'errorReason'?: string | null;
  'event'?: string | null;
  'eventState'?: number | null;
  'id'?: number;
  'projectId'?: number | null;
  'reel'?: string | null;
}
export interface o_productionReviewFeedback {
  'comment': string;
  'createTime': number;
  'id'?: number;
  'mode': string;
  'projectId': number;
  'scriptId'?: number | null;
  'suggestionId': number;
}
export interface o_productionReviewSuggestion {
  'createTime': number;
  'id'?: number;
  'issueType': string;
  'message': string;
  'parentId'?: number | null;
  'projectId': number;
  'proposedAction'?: string | null;
  'proposedPatch'?: string | null;
  'reason'?: string | null;
  'scriptId'?: number | null;
  'severity': string;
  'status'?: string;
  'targetId': string;
  'targetType': string;
  'updateTime': number;
  'version'?: number;
}
export interface o_project {
  'artStyle'?: string | null;
  'createTime'?: number | null;
  'directorManual'?: string | null;
  'id'?: number | null;
  'imageModel'?: string | null;
  'imageQuality'?: string | null;
  'intro'?: string | null;
  'mode'?: string | null;
  'name'?: string | null;
  'projectType'?: string | null;
  'type'?: string | null;
  'userId'?: number | null;
  'videoModel'?: string | null;
  'videoRatio'?: string | null;
}
export interface o_projectMaterial {
  'category': string;
  'createTime': number;
  'ext'?: string | null;
  'filePath': string;
  'id'?: number;
  'mime'?: string | null;
  'name': string;
  'projectId': number;
  'size'?: number;
  'state'?: string;
  'summary'?: string | null;
  'textPath'?: string | null;
  'textSize'?: number | null;
  'updateTime': number;
}
export interface o_projectStorage {
  'errorReason'?: string | null;
  'lastChangedAt'?: number | null;
  'lastSnapshotAt'?: number | null;
  'projectId'?: number;
  'revision'?: number;
  'snapshotRevision'?: number;
  'snapshotState'?: string;
  'storageKey': string;
}
export interface o_prompt {
  'data'?: string | null;
  'id'?: number;
  'name'?: string | null;
  'type'?: string | null;
  'useData'?: string | null;
}
export interface o_script {
  'content'?: string | null;
  'createTime'?: number | null;
  'errorReason'?: string | null;
  'extractState'?: number | null;
  'id'?: number;
  'name'?: string | null;
  'projectId'?: number | null;
}
export interface o_scriptAssets {
  'assetId'?: number;
  'scriptId'?: number;
}
export interface o_setting {
  'key'?: string | null;
  'value'?: string | null;
}
export interface o_skillAttribution {
  'attribution'?: string;
  'skillId'?: string;
}
export interface o_skillList {
  'createTime': number;
  'description': string;
  'embedding'?: string | null;
  'id'?: string;
  'md5': string;
  'name': string;
  'path': string;
  'state': number;
  'type': string;
  'updateTime': number;
}
export interface o_storyAnnotation {
  'artifactId': number;
  'artifactVersion'?: number;
  'blockId'?: string | null;
  'comment': string;
  'createTime'?: number | null;
  'endOffset'?: number | null;
  'id'?: number;
  'projectId': number;
  'selectedText': string;
  'startOffset'?: number | null;
  'status'?: string;
  'updateTime'?: number | null;
}
export interface o_storyArtifact {
  'content': string;
  'contentJson'?: string | null;
  'createTime'?: number | null;
  'id'?: number;
  'parentId'?: number | null;
  'projectId': number;
  'status'?: string;
  'title': string;
  'type': string;
  'updateTime'?: number | null;
  'version'?: number;
}
export interface o_storyboard {
  'action'?: string | null;
  'beatId'?: string | null;
  'cameraMove'?: string | null;
  'createTime'?: number | null;
  'dialogue'?: string | null;
  'duration'?: string | null;
  'factRevision'?: number | null;
  'factStatus'?: string | null;
  'factVersion'?: number | null;
  'filePath'?: string | null;
  'flowId'?: number | null;
  'groupIntent'?: string | null;
  'groupKey'?: string | null;
  'groupName'?: string | null;
  'id'?: number;
  'index'?: number | null;
  'location'?: string | null;
  'picture'?: string | null;
  'projectId'?: number | null;
  'prompt'?: string | null;
  'reason'?: string | null;
  'referenceImages'?: string | null;
  'scene'?: string | null;
  'sceneContinuityId'?: string | null;
  'scriptId'?: number | null;
  'shotSize'?: string | null;
  'shouldGenerateImage'?: number | null;
  'sound'?: string | null;
  'state'?: string | null;
  'tableRowJson'?: string | null;
  'timeOfDay'?: string | null;
  'track'?: string | null;
  'trackId'?: number | null;
  'videoDesc'?: string | null;
  'visibleEmotion'?: string | null;
}
export interface o_storyboardGeneration {
  'createdAt': number;
  'errorJson'?: string | null;
  'expectedRowCount': number;
  'generationId': string;
  'groupPlanJson': string;
  'id'?: number | null;
  'projectId': number;
  'revision'?: number | null;
  'scriptId': number;
  'state': string;
  'updatedAt': number;
}
export interface o_storyboardGenerationRow {
  'createdAt': number;
  'generationId': string;
  'id'?: number | null;
  'rowHash': string;
  'rowIndex': number;
  'rowJson': string;
  'updatedAt': number;
}
export interface o_storyRevisionMap {
  'annotationIds'?: string | null;
  'changeSummary'?: string | null;
  'createTime'?: number | null;
  'id'?: number;
  'newArtifactId': number;
  'projectId': number;
  'sourceArtifactId': number;
}
export interface o_taskEvent {
  'createdAt': number;
  'id'?: number;
  'legacyTaskId'?: number | null;
  'nodeId'?: string | null;
  'phase'?: string | null;
  'progress'?: number | null;
  'projectId'?: number | null;
  'reason'?: string | null;
  'resultJson'?: string | null;
  'scriptId'?: number | null;
  'status': string;
  'targetId'?: string | null;
  'targetType'?: string | null;
  'taskId': string;
  'taskType': string;
  'version': number;
}
export interface o_tasks {
  'attempt'?: number | null;
  'availableAt'?: number | null;
  'businessId'?: number | null;
  'businessType'?: string | null;
  'createdAt'?: number | null;
  'describe'?: string | null;
  'episode'?: number | null;
  'finishTime'?: number | null;
  'handler'?: string | null;
  'id'?: number;
  'idempotencyKey'?: string | null;
  'leaseExpiresAt'?: number | null;
  'leaseOwner'?: string | null;
  'maxAttempts'?: number | null;
  'model'?: string | null;
  'nodeId'?: string | null;
  'payloadJson'?: string | null;
  'phase'?: string | null;
  'priority'?: number | null;
  'progress'?: number | null;
  'projectId'?: number | null;
  'providerSubmittedAt'?: number | null;
  'providerTaskId'?: string | null;
  'reason'?: string | null;
  'relatedObjects'?: string | null;
  'resultJson'?: string | null;
  'scriptId'?: number | null;
  'startTime'?: number | null;
  'state'?: string | null;
  'status'?: string | null;
  'targetId'?: string | null;
  'targetType'?: string | null;
  'taskClass'?: string | null;
  'taskId'?: string | null;
  'taskType'?: string | null;
  'updateTime'?: number | null;
  'version'?: number | null;
}
export interface o_textAsset {
  'createTime': number;
  'filePath': string;
  'hash': string;
  'id'?: number;
  'projectId': number;
  'scriptId'?: number | null;
  'size'?: number;
  'state'?: string;
  'summary'?: string | null;
  'targetId'?: string | null;
  'targetType': string;
  'updateTime': number;
  'version'?: number;
}
export interface o_user {
  'id'?: number;
  'name'?: string | null;
  'password'?: string | null;
}
export interface o_vendorConfig {
  'enable'?: number | null;
  'id'?: string;
  'inputValues'?: string | null;
  'models'?: string | null;
}
export interface o_video {
  'errorReason'?: string | null;
  'filePath'?: string | null;
  'id'?: number;
  'projectId'?: number | null;
  'scriptId'?: number | null;
  'state'?: string | null;
  'time'?: number | null;
  'videoTrackId'?: number | null;
}
export interface o_videoGenerationTask {
  'capacityWaitStartedAt'?: number | null;
  'confirmDeadline'?: number | null;
  'confirmStartedAt'?: number | null;
  'errorReason'?: string | null;
  'finishTime'?: number | null;
  'historyRecordId'?: string | null;
  'id'?: number;
  'lastProviderCode'?: string | null;
  'lastProviderStatus'?: string | null;
  'model'?: string | null;
  'nextPollTime'?: number | null;
  'nextSubmitTime'?: number | null;
  'officialTaskId'?: string | null;
  'payloadVersion'?: number | null;
  'phase'?: string | null;
  'pollCount'?: number | null;
  'projectId'?: number | null;
  'providerAccountId'?: string | null;
  'providerModelKey'?: string | null;
  'providerQueueIndex'?: number | null;
  'providerQueueLength'?: number | null;
  'providerQueueStatus'?: number | null;
  'providerSubmittedAt'?: number | null;
  'rawOutput'?: string | null;
  'remoteConfirmedAt'?: number | null;
  'requestJson'?: string | null;
  'scriptId'?: number | null;
  'startTime'?: number | null;
  'state'?: string | null;
  'status'?: string | null;
  'submitAttemptCount'?: number | null;
  'submitId'?: string | null;
  'taskCenterId'?: number | null;
  'updateTime'?: number | null;
  'vendorId'?: string | null;
  'videoId'?: number | null;
}
export interface o_videoProviderCapacity {
  'blockedUntil'?: number | null;
  'capacityBlocked'?: number;
  'createTime': number;
  'id'?: number | null;
  'lastProviderCode'?: string | null;
  'providerAccountId'?: string;
  'providerModelKey': string;
  'updateTime': number;
  'vendorId': string;
}
export interface o_videoTrack {
  'archived'?: number | null;
  'duration'?: number | null;
  'groupIntent'?: string | null;
  'groupKey'?: string | null;
  'groupName'?: string | null;
  'groupPlanJson'?: string | null;
  'id'?: number;
  'musicPlanJson'?: string | null;
  'projectId'?: number | null;
  'prompt'?: string | null;
  'reason'?: string | null;
  'reviewIssuesJson'?: string | null;
  'reviewState'?: string | null;
  'scriptId'?: number | null;
  'selectVideoId'?: number | null;
  'state'?: string | null;
  'videoId'?: number | null;
}
export interface o_workbenchMergedReference {
  'createTime': number;
  'filePath': string;
  'fileType': string;
  'id'?: number;
  'mergeType': string;
  'name'?: string | null;
  'position': number;
  'projectId': number;
  'prompt'?: string | null;
  'scriptId': number;
  'sourceRefs': string;
  'state': string;
  'trackId': number;
  'updateTime': number;
}

export interface DB {
  "memories": memories;
  "o_agentDeploy": o_agentDeploy;
  "o_agentRun": o_agentRun;
  "o_agentRunEvent": o_agentRunEvent;
  "o_agentWorkData": o_agentWorkData;
  "o_artStyle": o_artStyle;
  "o_assets": o_assets;
  "o_assets2Storyboard": o_assets2Storyboard;
  "o_assetsRole2Audio": o_assetsRole2Audio;
  "o_directorAsset": o_directorAsset;
  "o_directorPlanGeneration": o_directorPlanGeneration;
  "o_directorPlanGenerationChunk": o_directorPlanGenerationChunk;
  "o_editImageTask": o_editImageTask;
  "o_event": o_event;
  "o_eventChapter": o_eventChapter;
  "o_image": o_image;
  "o_imageFlow": o_imageFlow;
  "o_modelPrompt": o_modelPrompt;
  "o_musicBible": o_musicBible;
  "o_musicCue": o_musicCue;
  "o_musicCueAsset": o_musicCueAsset;
  "o_musicCueBinding": o_musicCueBinding;
  "o_musicLibraryEdition": o_musicLibraryEdition;
  "o_musicLibraryItem": o_musicLibraryItem;
  "o_musicLibraryVersion": o_musicLibraryVersion;
  "o_musicLyricsVersion": o_musicLyricsVersion;
  "o_musicPlan": o_musicPlan;
  "o_musicPromptVersion": o_musicPromptVersion;
  "o_novel": o_novel;
  "o_productionReviewFeedback": o_productionReviewFeedback;
  "o_productionReviewSuggestion": o_productionReviewSuggestion;
  "o_project": o_project;
  "o_projectMaterial": o_projectMaterial;
  "o_projectStorage": o_projectStorage;
  "o_prompt": o_prompt;
  "o_script": o_script;
  "o_scriptAssets": o_scriptAssets;
  "o_setting": o_setting;
  "o_skillAttribution": o_skillAttribution;
  "o_skillList": o_skillList;
  "o_storyAnnotation": o_storyAnnotation;
  "o_storyArtifact": o_storyArtifact;
  "o_storyboard": o_storyboard;
  "o_storyboardGeneration": o_storyboardGeneration;
  "o_storyboardGenerationRow": o_storyboardGenerationRow;
  "o_storyRevisionMap": o_storyRevisionMap;
  "o_taskEvent": o_taskEvent;
  "o_tasks": o_tasks;
  "o_textAsset": o_textAsset;
  "o_user": o_user;
  "o_vendorConfig": o_vendorConfig;
  "o_video": o_video;
  "o_videoGenerationTask": o_videoGenerationTask;
  "o_videoProviderCapacity": o_videoProviderCapacity;
  "o_videoTrack": o_videoTrack;
  "o_workbenchMergedReference": o_workbenchMergedReference;
}
