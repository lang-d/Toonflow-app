import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toonflow-music-workflow-"));
process.env.TOONFLOW_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.TOONFLOW_SKIP_DB_INIT = "1";

let vendorModelSchema: any;
let readMusicSkill: any;
let formatUnifiedTaskEnvelope: typeof import("../src/services/taskCoordinator").formatUnifiedTaskEnvelope;
let isAiObjectContractError: typeof import("../src/services/aiJsonObject").isAiObjectContractError;
let musicProjectIsolationKey: typeof import("../src/services/musicScope").musicProjectIsolationKey;
let musicEpisodeIsolationKey: typeof import("../src/services/musicScope").musicEpisodeIsolationKey;
let resolveMusicIsolationKey: typeof import("../src/services/musicScope").resolveMusicIsolationKey;
let musicProductionToolNames: typeof import("../src/agents/musicProductionAgent/tools").musicProductionToolNames;
let musicAiContractFailureMessage: typeof import("../src/services/musicTaskHandlers").musicAiContractFailureMessage;
let resolveMusicGenerationDuration: typeof import("../src/services/musicModelCapability").resolveMusicGenerationDuration;
let buildMusicProviderRequest: typeof import("../src/services/musicModelCapability").buildMusicProviderRequest;
let assertMusicPromptGenerationAllowed: typeof import("../src/services/musicAsset").assertMusicPromptGenerationAllowed;
let parseMusicModelProfile: typeof import("../src/services/musicPromptProfile").parseMusicModelProfile;
let assertMusicProfileGenerationConfig: typeof import("../src/services/musicPromptProfile").assertMusicProfileGenerationConfig;
let missingMusicProfileGenerationConfig: typeof import("../src/services/musicPromptProfile").missingMusicProfileGenerationConfig;
let MusicPromptConfigValidationError: typeof import("../src/services/musicPromptProfile").MusicPromptConfigValidationError;
let mergeMusicPromptGenerationConfig: typeof import("../src/services/musicLibrary").mergeMusicPromptGenerationConfig;
let musicReviewIssueSchema: typeof import("../src/services/musicReviewer").musicReviewIssueSchema;
let splitMusicPromptTimingConfig: typeof import("../src/services/musicReviewer").splitMusicPromptTimingConfig;
let parseMusicModelKey: typeof import("../src/services/musicModelCapability").parseMusicModelKey;

before(async () => {
  const [vendorModel, musicDirector, taskCoordinator, aiJsonObject, musicScope, musicTools, musicTaskHandlers, musicCapabilities, musicAsset, musicPromptProfile, musicLibrary, musicReviewer] = await Promise.all([
    import("../src/lib/vendorModelSchema"),
    import("../src/services/musicDirector"),
    import("../src/services/taskCoordinator"),
    import("../src/services/aiJsonObject"),
    import("../src/services/musicScope"),
    import("../src/agents/musicProductionAgent/tools"),
    import("../src/services/musicTaskHandlers"),
    import("../src/services/musicModelCapability"),
    import("../src/services/musicAsset"),
    import("../src/services/musicPromptProfile"),
    import("../src/services/musicLibrary"),
    import("../src/services/musicReviewer"),
  ]);
  vendorModelSchema = vendorModel.vendorModelSchema;
  readMusicSkill = musicDirector.readMusicSkill;
  formatUnifiedTaskEnvelope = taskCoordinator.formatUnifiedTaskEnvelope;
  isAiObjectContractError = aiJsonObject.isAiObjectContractError;
  musicProjectIsolationKey = musicScope.musicProjectIsolationKey;
  musicEpisodeIsolationKey = musicScope.musicEpisodeIsolationKey;
  resolveMusicIsolationKey = musicScope.resolveMusicIsolationKey;
  musicProductionToolNames = musicTools.musicProductionToolNames;
  musicAiContractFailureMessage = musicTaskHandlers.musicAiContractFailureMessage;
  resolveMusicGenerationDuration = musicCapabilities.resolveMusicGenerationDuration;
  buildMusicProviderRequest = musicCapabilities.buildMusicProviderRequest;
  parseMusicModelKey = musicCapabilities.parseMusicModelKey;
  assertMusicPromptGenerationAllowed = musicAsset.assertMusicPromptGenerationAllowed;
  parseMusicModelProfile = musicPromptProfile.parseMusicModelProfile;
  assertMusicProfileGenerationConfig = musicPromptProfile.assertMusicProfileGenerationConfig;
  missingMusicProfileGenerationConfig = musicPromptProfile.missingMusicProfileGenerationConfig;
  MusicPromptConfigValidationError = musicPromptProfile.MusicPromptConfigValidationError;
  mergeMusicPromptGenerationConfig = musicLibrary.mergeMusicPromptGenerationConfig;
  musicReviewIssueSchema = musicReviewer.musicReviewIssueSchema;
  splitMusicPromptTimingConfig = musicReviewer.splitMusicPromptTimingConfig;
});

after(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("vendor model schema accepts music models without provider-specific hardcoding", () => {
  const result = vendorModelSchema.parse({
    name: "Music Studio",
    modelName: "music-studio-v1",
    type: "music",
    durationRange: { min: 5, max: 180 },
    outputFormats: ["mp3", "wav"],
    promptDialect: "sectioned",
  });

  assert.equal(result.type, "music");
  assert.equal(result.promptDialect, "sectioned");
});

test("music model display names are rejected before model-specific work is queued", () => {
  assert.deepEqual(parseMusicModelKey("t8star:chirp-fenix"), { vendorId: "t8star", modelName: "chirp-fenix" });
  assert.throws(() => parseMusicModelKey("Suno V5.5"), /display names are not executable/);
});

test("music skill loader reads bundled defaults and falls back when missing", async () => {
  const skill = await readMusicSkill("music_review.md", "fallback");
  assert.match(skill.content, /Music Review Rules/);

  const fallback = await readMusicSkill("missing_music_skill.md", "fallback skill");
  assert.equal(fallback.content, "fallback skill");
  assert.equal(fallback.source, "fallback:missing_music_skill.md");
});

test("unified task envelope does not expose unifiedTaskId for new async music APIs", () => {
  const envelope = formatUnifiedTaskEnvelope({ taskId: "task-uuid", legacyTaskId: 123, status: "queued" }, "musicBible");
  assert.deepEqual(envelope, {
    taskId: "task-uuid",
    legacyTaskId: 123,
    status: "queued",
    targetType: "musicBible",
    targetId: null,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(envelope, "unifiedTaskId"), false);
});

test("music AI object contract errors are detected for user-friendly task failures", () => {
  assert.equal(isAiObjectContractError(new Error("No object generated: response did not match schema.")), true);
  assert.equal(isAiObjectContractError(new Error("Music bible does not match schema: missing content")), true);
  assert.equal(isAiObjectContractError(new Error("network timeout")), false);
  const message = musicAiContractFailureMessage("Music Bible");
  assert.match(message, /AI/);
  assert.match(message, /\u7ed3\u6784\u8981\u6c42/);
  assert.doesNotMatch(message, /No object generated|response did not match schema/);
});

test("task polling contracts accept only string task ids", () => {
  const snapshotRoute = fs.readFileSync(path.join(process.cwd(), "src", "routes", "task", "status", "snapshot.ts"), "utf8");
  const detailsRoute = fs.readFileSync(path.join(process.cwd(), "src", "routes", "task", "taskDetails.ts"), "utf8");
  assert.match(snapshotRoute, /taskIds:\s*z\.array\(z\.string\(\)\.min\(1\)\)/);
  assert.doesNotMatch(snapshotRoute, /z\.union\(\[z\.string\(\),\s*z\.number\(\)\]\)/);
  assert.match(detailsRoute, /taskId:\s*z\.string\(\)\.min\(1\)/);
  assert.doesNotMatch(detailsRoute, /orWhere\("id"/);
  assert.match(snapshotRoute, /targetTypes:\s*z\.array/);
  assert.match(snapshotRoute, /includeTerminal:\s*z\.boolean/);
});

test("music production agent uses project and episode isolation keys", () => {
  assert.equal(musicProjectIsolationKey(11), "musicProductionAgent:11:project");
  assert.equal(musicEpisodeIsolationKey(11, 22), "musicProductionAgent:11:episode:22");
  assert.equal(resolveMusicIsolationKey({ projectId: 11, mode: "project" }), "musicProductionAgent:11:project");
  assert.equal(resolveMusicIsolationKey({ projectId: 11, scriptId: 22, mode: "episode" }), "musicProductionAgent:11:episode:22");
  assert.throws(() => resolveMusicIsolationKey({ projectId: 11, mode: "episode" }), /scriptId is required/);
});

test("music production agent is registered as an isolated socket and runtime kind", () => {
  const socketIndex = fs.readFileSync(path.join(process.cwd(), "src", "socket", "index.ts"), "utf8");
  const runtimeBridge = fs.readFileSync(path.join(process.cwd(), "src", "runtime", "agentSocketBridge.ts"), "utf8");
  const proxy = fs.readFileSync(path.join(process.cwd(), "src", "socket", "routes", "agentProxy.ts"), "utf8");

  assert.match(socketIndex, /musicProductionAgent/);
  assert.match(runtimeBridge, /musicProductionAgent/);
  assert.match(proxy, /"musicProductionAgent"/);
});

test("music production agent exposes only music tools", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "agents", "musicProductionAgent", "tools.ts"), "utf8");
  assert.doesNotMatch(source, /productionAgent\/tools/);
  assert.deepEqual(
    [...musicProductionToolNames].filter((name) => name.includes("storyboard") || name.includes("video")),
    [],
  );
  assert.ok(musicProductionToolNames.includes("generate_music_bible"));
  assert.ok(musicProductionToolNames.includes("generate_music_cue_audio"));
  assert.ok(musicProductionToolNames.includes("list_music_library"));
  assert.ok(musicProductionToolNames.includes("generate_music_lyrics_draft"));
  assert.ok(musicProductionToolNames.includes("trim_music_library_audio"));
  assert.ok(musicProductionToolNames.includes("list_available_music_models"));
  assert.ok(musicProductionToolNames.includes("compile_generic_music_prompt"));
  assert.ok(musicProductionToolNames.includes("compile_model_music_prompt"));
  assert.ok(musicProductionToolNames.includes("update_agent_progress"));
  assert.equal((musicProductionToolNames as readonly string[]).includes("get_music_stage_state"), false);
});

test("music duration is an optional provider parameter only when the model declares it", () => {
  assert.deepEqual(resolveMusicGenerationDuration({ effectiveMusicDurationSec: 22, capabilities: { durationRange: { min: 30, max: 360 }, durationParameter: true } }), {
    effectiveMusicDurationSec: 22,
    generationDurationSec: 30,
    hasSilentTail: true,
    durationControl: "exact",
    durationParameter: true,
    durationRange: { min: 30, max: 360 },
  });
  assert.throws(
    () => resolveMusicGenerationDuration({ effectiveMusicDurationSec: 400, capabilities: { durationRange: { min: 30, max: 360 }, durationParameter: true } }),
    /360/,
  );
});

test("music without a duration parameter retains only the soft suggested duration", () => {
  assert.deepEqual(resolveMusicGenerationDuration({
    effectiveMusicDurationSec: 22,
    capabilities: { durationRange: { max: 480 }, durationControl: "targetOnly", durationParameter: false },
  }), {
    effectiveMusicDurationSec: 22,
    generationDurationSec: undefined,
    hasSilentTail: false,
    durationControl: "targetOnly",
    durationParameter: false,
    durationRange: { min: undefined, max: 480 },
  });
  const compiler = fs.readFileSync(path.join(process.cwd(), "src", "services", "musicCueCompiler.ts"), "utf8");
  assert.match(compiler, /musicTimingContext/);
  assert.match(compiler, /editionMusicSpec/);
  assert.doesNotMatch(compiler, /durationInstruction/);
});

test("music generation enforces exact prompt review status", () => {
  assert.doesNotThrow(() => assertMusicPromptGenerationAllowed("passed"));
  assert.throws(() => assertMusicPromptGenerationAllowed("warning"), /acknowledgeWarnings/);
  assert.doesNotThrow(() => assertMusicPromptGenerationAllowed("warning", true));
  assert.throws(() => assertMusicPromptGenerationAllowed("blocked"), /must pass review/);
  assert.throws(() => assertMusicPromptGenerationAllowed("unreviewed"), /must pass review/);
});

test("music without a duration parameter accepts a soft target and strips legacy duration fields from the provider request", () => {
  const capabilities = {
    model: "test:no-duration",
    name: "No duration",
    durationRange: { max: 480 },
    durationParameter: false,
    outputFormats: ["mp3"],
  };
  const request = buildMusicProviderRequest({
    config: { durationSec: 75, effectiveMusicDurationSec: 75, title: "Take" },
    prompt: "A compact instrumental of roughly seventy-five seconds, naturally resolving.",
    durationParameter: false,
  });
  assert.equal(request.durationSec, undefined);
  assert.equal(request.effectiveMusicDurationSec, undefined);
  assert.equal(request.prompt, "A compact instrumental of roughly seventy-five seconds, naturally resolving.");
});

test("music review receives provider config separately from timing metadata", () => {
  assert.deepEqual(
    splitMusicPromptTimingConfig({ title: "Take", tags: "piano", durationSec: 75, effectiveMusicDurationSec: 75 }, false),
    {
      modelGenerationConfig: { title: "Take", tags: "piano" },
      timing: { suggestedDurationSec: 75, providerDurationSec: null, providerAcceptsDurationParameter: false },
    },
  );
});

test("music Prompt Profile owns required generationConfig fields without vendor hardcoding", () => {
  const profile = parseMusicModelProfile([
    "---",
    "requiredGenerationConfig: [title, tags]",
    "---",
    "# Test Profile",
  ].join("\n"), "test:profile");
  assert.deepEqual(profile.requiredGenerationConfig, ["title", "tags"]);
  assert.deepEqual(missingMusicProfileGenerationConfig(profile, { title: "Take" }), ["tags"]);
  assert.throws(
    () => assertMusicProfileGenerationConfig(profile, { title: "Take" }),
    (error: unknown) => error instanceof MusicPromptConfigValidationError
      && error.code === "MUSIC_PROMPT_CONFIG_INVALID"
      && error.missingRequiredConfigKeys.join(",") === "tags",
  );
  assert.doesNotThrow(() => assertMusicProfileGenerationConfig(profile, { title: "Take", tags: "piano, minimal" }));
  assert.deepEqual(parseMusicModelProfile("# Plain Profile", "test:plain").requiredGenerationConfig, []);
});

test("same-model Prompt revisions retain profile configuration while model changes do not", () => {
  const base = {
    promptMode: "modelSpecific",
    model: "vendor:model-a",
    profileSource: "builtin:music/model-a.md",
    generationConfigJson: JSON.stringify({ title: "Original take", tags: "piano, minimal", durationSec: 60 }),
  };
  assert.deepEqual(
    mergeMusicPromptGenerationConfig({
      base,
      promptMode: "modelSpecific",
      model: "vendor:model-a",
      profileSource: "builtin:music/model-a.md",
      submittedConfig: { durationSec: 90 },
    }),
    { title: "Original take", tags: "piano, minimal", durationSec: 90 },
  );
  assert.deepEqual(
    mergeMusicPromptGenerationConfig({
      base,
      promptMode: "modelSpecific",
      model: "vendor:model-b",
      profileSource: "builtin:music/model-b.md",
      submittedConfig: { durationSec: 90 },
    }),
    { durationSec: 90 },
  );
});

test("blocking music review output requires model-supplied reason and proposed action", () => {
  assert.equal(musicReviewIssueSchema.safeParse({
    issueType: "missing_config",
    severity: "blocking",
    message: "Missing required config",
    reason: "",
    proposedAction: "",
  }).success, false);
  assert.equal(musicReviewIssueSchema.safeParse({
    issueType: "missing_config",
    severity: "blocking",
    message: "Missing required config",
    reason: "The selected Profile requires this field.",
    proposedAction: "Recompile the exact model Prompt.",
  }).success, true);
});

test("music skills separate project works, episode usage segments and exact prompt versions", () => {
  const skillsRoot = path.join(process.cwd(), "data", "skills");
  const plan = fs.readFileSync(path.join(skillsRoot, "music_plan_technique.md"), "utf8");
  const agent = fs.readFileSync(path.join(skillsRoot, "music_production_agent.md"), "utf8");
  const prompt = fs.readFileSync(path.join(skillsRoot, "music_prompt_compiler_technique.md"), "utf8");
  assert.match(plan, /Concept mode:[\s\S]*libraryItems must be empty and cues must be empty/);
  assert.match(plan, /Project mode:[\s\S]*cues must be empty/);
  assert.match(plan, /Episode mode:[\s\S]*reuse, new, or silence/);
  assert.match(plan, /Do not split by shot|number of shots/);
  assert.match(agent, /Jianying/);
  assert.match(agent, /Theme, opening, ending, and insert songs are opt-in/);
  assert.match(prompt, /immutable prompt version/);
  assert.ok(fs.existsSync(path.join(skillsRoot, "music_song_creation_technique.md")));
  assert.ok(fs.existsSync(path.join(skillsRoot, "music_lyrics_technique.md")));
});

test("music schema, portable project and packaged trim dependencies cover the library hierarchy", () => {
  const initSource = fs.readFileSync(path.join(process.cwd(), "src", "lib", "initDB.ts"), "utf8");
  const portableSource = fs.readFileSync(path.join(process.cwd(), "src", "services", "projectPortable.ts"), "utf8");
  const builder = fs.readFileSync(path.join(process.cwd(), "electron-builder.yml"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  for (const table of ["o_musicLibraryItem", "o_musicLibraryEdition", "o_musicLibraryVersion", "o_musicLyricsVersion", "o_musicPromptVersion", "o_musicCueBinding"]) {
    assert.match(initSource, new RegExp(table));
    assert.match(portableSource, new RegExp(table));
  }
  assert.match(initSource, /promptMode/);
  assert.match(initSource, /profileSource/);
  assert.match(initSource, /table\.string\("musicModel"\)/);
  assert.equal(pkg.dependencies["ffmpeg-static"], "5.3.0");
  assert.equal(pkg.dependencies["ffprobe-static"], "3.1.0");
  assert.match(builder, /ffmpeg-static/);
  assert.match(builder, /ffprobe-static/);
});

test("music generation freezes the execution model instead of reusing prompt provenance", () => {
  const queueSource = fs.readFileSync(path.join(process.cwd(), "src", "services", "musicTaskQueue.ts"), "utf8");
  const assetSource = fs.readFileSync(path.join(process.cwd(), "src", "services", "musicAsset.ts"), "utf8");
  const selectionSource = fs.readFileSync(path.join(process.cwd(), "src", "services", "musicModelSelection.ts"), "utf8");
  assert.match(queueSource, /resolveMusicExecutionModel\(input\)/);
  assert.match(queueSource, /payload:\s*\{ \.\.\.input, model \}/);
  assert.match(queueSource, /model,\s*\n\s*describe: "Generate project music work audio"/);
  assert.match(assetSource, /u\.Ai\.Music\(input\.model/);
  assert.match(assetSource, /musicRequestCheck\(input\.model/);
  assert.match(assetSource, /model:\s*input\.model/);
  assert.doesNotMatch(assetSource, /u\.Ai\.Music\(promptVersion\.model/);
  assert.match(selectionSource, /explicit \|\| projectDefault/);
  assert.match(selectionSource, /MUSIC_MODEL_REQUIRED/);
  assert.match(selectionSource, /MUSIC_MODEL_UNAVAILABLE/);
});

test("Suno profile and technique are model-specific while the default binding preserves user overrides", () => {
  const profile = path.join(process.cwd(), "data", "modelPrompt", "music", "suno-v55.md");
  const technique = path.join(process.cwd(), "data", "skills", "music_suno_v55_prompt_technique.md");
  const bindingSource = fs.readFileSync(path.join(process.cwd(), "src", "lib", "dbFixes", "vendorConfigFixes.ts"), "utf8");
  const profileSource = fs.readFileSync(path.join(process.cwd(), "src", "services", "musicPromptProfile.ts"), "utf8");
  const compilerSource = fs.readFileSync(path.join(process.cwd(), "src", "services", "musicCueCompiler.ts"), "utf8");
  const reviewerSource = fs.readFileSync(path.join(process.cwd(), "src", "services", "musicReviewer.ts"), "utf8");
  assert.equal(fs.existsSync(profile), true);
  assert.equal(fs.existsSync(technique), true);
  assert.match(bindingSource, /vendorId:\s*"t8star"/);
  assert.match(bindingSource, /model:\s*"chirp-fenix"/);
  assert.match(bindingSource, /fileName:\s*"suno-v55\.md"/);
  assert.match(bindingSource, /existing\.fileName === "t8star-suno-v55\.md"/);
  assert.match(profileSource, /readBuiltinDataFile\("modelPrompt"/);
  assert.match(profileSource, /modelTechnique/);
  assert.match(profileSource, /requiredGenerationConfig/);
  assert.match(profileSource, /readConfiguredSkill\(profile\.modelTechnique\)/);
  assert.match(compilerSource, /readMusicModelTechnique\(profile\)/);
  assert.match(reviewerSource, /readMusicModelTechnique\(profile\)/);
  assert.match(fs.readFileSync(profile, "utf8"), /modelTechnique:\s*music_suno_v55_prompt_technique\.md/);
  assert.match(fs.readFileSync(profile, "utf8"), /requiredGenerationConfig:\s*\[title, tags\]/);
  assert.doesNotMatch(fs.readFileSync(profile, "utf8"), /120 Unicode characters|200 Unicode characters|3000 Unicode characters/);
  assert.doesNotMatch(fs.readFileSync(profile, "utf8"), /T8Star|https?:\/\/|Bearer|\/suno\//i);
  assert.doesNotMatch(fs.readFileSync(technique, "utf8"), /T8Star|https?:\/\/|Bearer|\/suno\//i);
  assert.match(fs.readFileSync(profile, "utf8"), /do not write lyrics or imply a human utterance/i);
  assert.match(fs.readFileSync(technique, "utf8"), /without a human utterance/i);
  assert.match(fs.readFileSync(technique, "utf8"), /blocked speech -> broken rhythm, short motifs, rests/i);
  assert.match(fs.readFileSync(technique, "utf8"), /Inputs And Priority/);
  assert.match(fs.readFileSync(technique, "utf8"), /Output Contract/);
  assert.match(fs.readFileSync(technique, "utf8"), /Instrumental Path/);
  assert.match(fs.readFileSync(technique, "utf8"), /Vocal Path/);
  assert.match(fs.readFileSync(technique, "utf8"), /Instrumental self-check/);
  assert.match(fs.readFileSync(technique, "utf8"), /Vocal self-check/);
  assert.match(fs.readFileSync(technique, "utf8"), /Core motif/);
  assert.match(fs.readFileSync(technique, "utf8"), /Role map/);
  assert.match(fs.readFileSync(technique, "utf8"), /Listening arc/);
  assert.match(fs.readFileSync(technique, "utf8"), /never note names, a chord chart, bar counts, or MIDI data/i);
  assert.match(fs.readFileSync(technique, "utf8"), /Do not claim timestamps, exact section lengths, tempo maps, beat counts/i);
  assert.match(fs.readFileSync(technique, "utf8"), /every instrument role are musical functions/i);
  assert.match(fs.readFileSync(profile, "utf8"), /motif gesture,[\s\S]*main instrument-role/i);
  const review = fs.readFileSync(path.join(process.cwd(), "data", "skills", "music_review.md"), "utf8");
  assert.match(review, /instrumental work[\s\S]*blocking mode conflict/i);
  assert.match(review, /decorative instrument pile/i);
  assert.match(review, /conflicting role assignments/i);
  assert.match(review, /abstract emotion pile/i);
  assert.match(review, /lacks an audible entry and close relationship/i);
  assert.match(review, /A motif need not be written as notes, tempo, or fixed sections/i);
  assert.match(review, /Review output contains only actual issues/);
  assert.match(review, /Every blocking issue must include a non-empty reason/);
  assert.match(reviewerSource, /musicReviewIssueSchema/);
  assert.match(reviewerSource, /musicRequestCheck/);
  assert.match(reviewerSource, /musicRequestCheck/);
  assert.match(reviewerSource, /Blocking review issues require a reason/);
  const genericTechnique = fs.readFileSync(path.join(process.cwd(), "data", "skills", "music_prompt_compiler_technique.md"), "utf8");
  assert.match(genericTechnique, /selected model Profile and Technique own field names/);
  assert.doesNotMatch(genericTechnique, /Instrumental self-check/);
});

test("music model Profile exposes model technique metadata without sending it to the compiler", () => {
  const rawProfile = fs.readFileSync(path.join(process.cwd(), "data", "modelPrompt", "music", "suno-v55.md"), "utf8");
  const profile = parseMusicModelProfile(rawProfile, "test:suno-v55");
  assert.equal(profile.modelTechnique, "music_suno_v55_prompt_technique.md");
  assert.deepEqual(profile.requiredGenerationConfig, ["title", "tags"]);
  assert.doesNotMatch(profile.content, /^---/);
  assert.doesNotMatch(profile.content, /modelTechnique:/);
  assert.match(profile.content, /Suno V5\.5 Prompt Profile/);
  assert.equal(parseMusicModelProfile("# Plain Profile", "test:plain").modelTechnique, null);
});

test("music Prompt save routes expose only structural missing-key errors", () => {
  for (const route of [
    path.join(process.cwd(), "src", "routes", "production", "music", "cue", "prompt", "save.ts"),
    path.join(process.cwd(), "src", "routes", "production", "music", "library", "prompt", "save.ts"),
  ]) {
    const source = fs.readFileSync(route, "utf8");
    assert.match(source, /MusicPromptConfigValidationError/);
    assert.match(source, /missingRequiredConfigKeys/);
    assert.doesNotMatch(source, /proposedAction|reason:/);
  }
});

test("music production agent has its own model deployment key", () => {
  const aiSource = fs.readFileSync(path.join(process.cwd(), "src", "utils", "ai.ts"), "utf8");
  const initSource = fs.readFileSync(path.join(process.cwd(), "src", "lib", "initDB.ts"), "utf8");
  const fixSource = fs.readFileSync(path.join(process.cwd(), "src", "lib", "fixDB.ts"), "utf8");

  assert.match(aiSource, /"musicProductionAgent"/);
  assert.match(aiSource, /"musicProductionAgent:decisionAgent"/);
  assert.match(initSource, /key: "musicProductionAgent"/);
  assert.match(fixSource, /key: "musicProductionAgent:decisionAgent"/);
  assert.match(fixSource, /copyAgentDeployModelIfEmpty\("musicProductionAgent", "productionAgent"\)/);
  assert.match(fixSource, /copyAgentDeployModelIfEmpty\("musicProductionAgent:decisionAgent", "productionAgent:decisionAgent"\)/);
});

test("unified task worker renews leases and wraps long music tasks with timeout", () => {
  const workerSource = fs.readFileSync(path.join(process.cwd(), "src", "services", "unifiedTaskWorker.ts"), "utf8");
  const coordinatorSource = fs.readFileSync(path.join(process.cwd(), "src", "services", "taskCoordinator.ts"), "utf8");

  assert.match(coordinatorSource, /export async function renewUnifiedTaskLease/);
  assert.match(workerSource, /TASK_LEASE_RENEW_MS/);
  assert.match(workerSource, /renewUnifiedTaskLease\(Number\(task\.id\), TASK_LEASE_MS\)/);
  assert.match(workerSource, /runTaskHandlerWithTimeout\(task, handler\(payload, task\)\)/);
  assert.match(workerSource, /handler\.startsWith\("music-"\)/);
  assert.match(workerSource, /"music-library-generate"/);
  assert.match(workerSource, /"music-audio-trim"/);
});
