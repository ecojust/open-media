import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateBuild, validateScheduledBuild, workflowExecution, verifyWorkflowArtifact, verifyDigest, verifyMetadata, digest, verifyMediaMetadata, mediaRuntimeSourceFiles, verifySpeechMetadata, verifySpeechSynthesis, installedSpeechVoiceIds, sourceChecksums, speechSourceRequirements } from '../scripts/release-validation.mjs';
import { verifySourceContents } from '../scripts/release-source.mjs';

const commit = 'a'.repeat(40);
const disabledSpeechPolicy = { installedSpeechVerification: { enabled: false, reason: '按维护者要求，暂时停用逐音色模型验证以缩短发布时间。' } };
const enabledSpeechPolicy = { installedSpeechVerification: { enabled: true } };
function fixture() {
  return {
    run: { id: 7, head_sha: commit, status: 'completed', conclusion: 'success', path: '.github/workflows/desktop-build.yml' },
    jobs: ['Application checks', 'Corresponding media source', 'windows-x64', 'macos-arm64', 'macos-x64'].map(name => ({ name, status: 'completed', conclusion: 'success', steps: [{ name: 'Verify every installed speech voice', status: 'completed', conclusion: 'success' }] })),
    artifacts: ['windows-x64', 'macos-arm64', 'macos-x64', 'runtime-source'].map(platform => ({ name: `open-media-${platform}-7`, expired: false, size_in_bytes: 1, digest: `sha256:${'a'.repeat(64)}` })),
  };
}
function schedulingFixture() {
  const repository = 'ecojust/open-media';
  const env = {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository, GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_WORKFLOW: 'Build Open Media desktop', GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/desktop-build.yml@refs/heads/master`,
    GITHUB_WORKFLOW_SHA: commit, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/master',
    GITHUB_SHA: commit, GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'publish',
  };
  return { environment: env, context: workflowExecution(env), event: { inputs: { publish: 'true' }, repository: { full_name: repository }, ref: 'master' },
    needs: { checks: { result: 'success' }, 'runtime-source': { result: 'success' }, desktop: { result: 'success' } },
    artifacts: fixture().artifacts, repository, runId: '7', expectedCommit: commit, checkoutCommit: commit,
    publishRequested: 'true', releasePolicy: disabledSpeechPolicy };
}
test('same-workflow publication uses actual scheduler dependency evidence without synthesizing API jobs', () => {
  const input = schedulingFixture();
  const { selected, proof } = validateScheduledBuild(input);
  assert.equal(selected.length, 4);
  assert.equal(proof.kind, 'same-workflow-scheduling');
  assert.deepEqual(proof.dependencies, { checks: 'success', desktop: 'success', 'runtime-source': 'success' });
  assert.equal(proof.context.runAttempt, 1);
  assert.equal(proof.context.headSha, commit);
  assert.equal(proof.jobs, undefined);
  assert.equal(proof.conclusion, undefined);
  assert.equal(workflowExecution({ GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret' }).GH_TOKEN, undefined);
});
test('scheduled publication rejects failures, skipped dependencies, cancelled work and missing gates', () => {
  for (const id of ['checks', 'desktop', 'runtime-source']) {
    for (const result of ['failure', 'skipped', 'cancelled', '', null, undefined, 'in_progress']) {
      const input = schedulingFixture();
      input.needs[id].result = result;
      assert.throws(() => validateScheduledBuild(input), /dependency must actually succeed/);
    }
    const input = schedulingFixture();
    delete input.needs[id];
    assert.throws(() => validateScheduledBuild(input), /dependency must actually succeed/);
  }
  for (const needs of [null, [], {}, { ...schedulingFixture().needs, unknown: { result: 'success' } }]) {
    assert.throws(() => validateScheduledBuild({ ...schedulingFixture(), needs }), /dependency must actually succeed/);
  }
});
test('scheduled publication rejects a foreign workflow, run, attempt, event, checkout or undispatched request', () => {
  const changes = {
    schema: 2, actions: false, repository: 'someone/other', serverUrl: 'https://example.com', workflow: 'Other workflow',
    workflowRef: `ecojust/open-media/.github/workflows/publish-release.yml@refs/heads/master`, workflowSha: 'b'.repeat(40),
    headSha: 'b'.repeat(40), eventName: 'pull_request', job: 'checks', ref: 'refs/tags/v0.3.0', runId: '8',
  };
  for (const [field, value] of Object.entries(changes)) {
    const input = schedulingFixture(); input.context[field] = value;
    assert.throws(() => validateScheduledBuild(input), /exact desktop workflow Actions context/);
  }
  for (const runAttempt of [0, -1, 1.5, '1', undefined, Number.MAX_SAFE_INTEGER + 1]) {
    const input = schedulingFixture(); input.context.runAttempt = runAttempt;
    assert.throws(() => validateScheduledBuild(input), /exact desktop workflow Actions context/);
  }
  for (const changes of [{ checkoutCommit: 'b'.repeat(40) }, { expectedCommit: 'b'.repeat(40) }, { runId: '8' }]) {
    assert.throws(() => validateScheduledBuild({ ...schedulingFixture(), ...changes }), /exact desktop workflow Actions context/);
  }
  for (const publishRequested of [undefined, false, true, 'false', '']) {
    assert.throws(() => validateScheduledBuild({ ...schedulingFixture(), publishRequested }), /explicitly requested/);
  }
  for (const event of [{}, { inputs: { publish: false } }, { ...schedulingFixture().event, ref: 'another-branch' },
    { ...schedulingFixture().event, repository: { full_name: 'other/repository' } }]) {
    assert.throws(() => validateScheduledBuild({ ...schedulingFixture(), event }), /explicitly requested/);
  }
});
test('missing Actions fields and local or standalone contexts cannot enter scheduled publication', () => {
  for (const context of [undefined, null, {}, workflowExecution({}), workflowExecution({ GITHUB_ACTIONS: 'true' })]) {
    assert.throws(() => validateScheduledBuild({ ...schedulingFixture(), context }), /exact desktop workflow Actions context/);
  }
  for (const field of Object.keys(schedulingFixture().context)) {
    const input = schedulingFixture(); delete input.context[field];
    assert.throws(() => validateScheduledBuild(input), /exact desktop workflow Actions context/);
  }
  const local = schedulingFixture();
  local.context = workflowExecution({ ...local.environment, GITHUB_ACTIONS: 'false' });
  assert.throws(() => validateScheduledBuild(local), /exact desktop workflow Actions context/);
  const standalone = schedulingFixture();
  standalone.context.workflowRef = 'ecojust/open-media/.github/workflows/publish-release.yml@refs/heads/master';
  assert.throws(() => validateScheduledBuild(standalone), /exact desktop workflow Actions context/);
});
test('scheduler success cannot replace required artifacts, digests or the corresponding source', () => {
  const input = schedulingFixture();
  for (const artifact of input.artifacts) {
    assert.throws(() => validateScheduledBuild({ ...input, artifacts: input.artifacts.filter(item => item !== artifact) }), /Missing or invalid artifact/);
    for (const change of [{ expired: true }, { size_in_bytes: 0 }, { digest: undefined }, { digest: 'wrong' }]) {
      assert.throws(() => validateScheduledBuild({ ...input, artifacts: input.artifacts.map(item => item === artifact ? { ...item, ...change } : item) }), /Missing or invalid artifact/);
    }
  }
  assert.throws(() => validateScheduledBuild({ ...input, artifacts: [...input.artifacts, input.artifacts[0]] }), /Missing or invalid artifact/);
  assert.throws(() => validateScheduledBuild({ ...input, releasePolicy: { installedSpeechVerification: { enabled: false } } }), /requires a nonempty reason/);
});
test('artifact workflow evidence binds platform receipts to the exact scheduled source and voice policy', () => {
  const input = schedulingFixture(), { proof } = validateScheduledBuild(input);
  for (const platform of ['windows-x64', 'macos-arm64', 'macos-x64', 'runtime-source']) {
    const execution = { ...input.context, job: platform === 'runtime-source' ? 'runtime-source' : 'desktop', installedSpeechOutcome: 'omitted' };
    verifyWorkflowArtifact(execution, platform, proof, disabledSpeechPolicy);
    for (const changes of [{ headSha: 'b'.repeat(40) }, { workflowSha: 'b'.repeat(40) }, { runId: '8' }, { runAttempt: 0 },
      { runAttempt: 2 }, { runAttempt: '1' }, { actions: false }, { schema: 2 }, { eventName: 'push' }, { job: 'publish' },
      { workflowRef: 'other/workflow' }, { repository: 'someone/other' }, { serverUrl: 'https://example.com' }]) {
      assert.throws(() => verifyWorkflowArtifact({ ...execution, ...changes }, platform, proof, disabledSpeechPolicy), /Artifact workflow execution differs/);
    }
    assert.throws(() => verifyWorkflowArtifact(undefined, platform, proof, disabledSpeechPolicy), /Artifact workflow execution differs/);
    if (platform !== 'runtime-source') {
      verifyWorkflowArtifact({ ...execution, installedSpeechOutcome: 'success' }, platform, proof, enabledSpeechPolicy);
      for (const outcome of [undefined, 'failure', 'cancelled', 'in_progress', 'omitted', 'skipped']) {
        assert.throws(() => verifyWorkflowArtifact({ ...execution, installedSpeechOutcome: outcome }, platform, proof, enabledSpeechPolicy), /step outcome contradicts/);
      }
      for (const outcome of [undefined, 'success', 'failure', 'cancelled', 'in_progress']) {
        assert.throws(() => verifyWorkflowArtifact({ ...execution, installedSpeechOutcome: outcome }, platform, proof, disabledSpeechPolicy), /step outcome contradicts/);
      }
    }
    // A publisher-only retry may reuse successful dependencies from an earlier
    // attempt of this exact run; future attempts and other runs remain invalid.
    verifyWorkflowArtifact(execution, platform, { ...proof, context: { ...proof.context, runAttempt: 2 } }, disabledSpeechPolicy);
  }
});
test('the source job writes executable Node metadata bound to its actual workflow context', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-media-source-receipt-'));
  try {
    mkdirSync(join(directory, 'scripts')); mkdirSync(join(directory, 'source-artifacts'));
    copyFileSync(new URL('../scripts/release-validation.mjs', import.meta.url), join(directory, 'scripts/release-validation.mjs'));
    const workflow = readFileSync(new URL('../.github/workflows/desktop-build.yml', import.meta.url), 'utf8');
    const sourceJob = workflow.split('\n  runtime-source:\n')[1].split('\n  desktop:\n')[0];
    const script = /node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/.exec(sourceJob)?.[1];
    assert.ok(script, 'The source job must write its workflow receipt.');
    const input = schedulingFixture();
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: directory, env: { ...input.environment, GITHUB_JOB: 'runtime-source' },
    });
    const meta = JSON.parse(readFileSync(join(directory, 'source-artifacts/build.json')));
    assert.equal(meta.commit, commit); assert.equal(meta.kind, 'corresponding-source');
    verifyWorkflowArtifact(meta.workflowExecution, 'runtime-source', validateScheduledBuild(input).proof, disabledSpeechPolicy);
    const receipt = { ...input.context, job: 'runtime-source' };
    for (const field of Object.keys(receipt)) {
      const missing = { ...receipt }; delete missing[field];
      assert.throws(() => verifyWorkflowArtifact(missing, 'runtime-source', validateScheduledBuild(input).proof, disabledSpeechPolicy), /Artifact workflow execution differs/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('release requires the same successful source commit and all platform checks', () => {
  const { run, jobs, artifacts } = fixture();
  assert.equal(validateBuild(run, jobs, artifacts, commit).length, 4);
  assert.throws(() => validateBuild({ ...run, head_sha: 'b'.repeat(40) }, jobs, artifacts, commit));
  assert.throws(() => validateBuild({ ...run, path: '.github/workflows/optional-speech-runtime.yml' }, jobs, artifacts, commit));
  assert.throws(() => validateBuild(run, jobs.filter(job => job.name !== 'Application checks'), artifacts, commit));
  assert.throws(() => validateBuild(run, jobs.map(job => job.name === 'windows-x64' ? { ...job, conclusion: 'failure' } : job), artifacts, commit));
});
test('media binaries cannot be released without the complete corresponding source artifact', () => {
  const { run, jobs, artifacts } = fixture();
  assert.throws(() => validateBuild(run, jobs, artifacts.filter(artifact => !artifact.name.includes('runtime-source')), commit));
  assert.throws(() => validateBuild(run, jobs.filter(job => job.name !== 'Corresponding media source'), artifacts, commit));
  assert.throws(() => validateBuild(run, jobs, artifacts.map(artifact => ({ ...artifact, expired: true })), commit));
});
test('every desktop platform must actually finish its installed speech verification step', () => {
  const { run, jobs, artifacts } = fixture();
  for (const platform of ['windows-x64', 'macos-arm64', 'macos-x64']) {
    for (const steps of [undefined, [], [{ name: 'Verify every installed speech voice', status: 'completed', conclusion: 'skipped' }], [{ name: 'Verify every installed speech voice', status: 'completed', conclusion: 'failure' }], [{ name: 'Verify every installed speech voice', status: 'in_progress', conclusion: null }]]) {
      assert.throws(() => validateBuild(run, jobs.map(job => job.name === platform ? { ...job, steps } : job), artifacts, commit), /Installed speech verification did not pass/);
    }
    const passed = jobs.find(job => job.name === platform).steps[0];
    assert.throws(() => validateBuild(run, jobs.map(job => job.name === platform ? { ...job, steps: [passed, passed] } : job), artifacts, commit), /Installed speech verification did not pass/);
  }
});
test('explicit disabled voice policy permits only omitted or skipped verification steps', () => {
  const { run, jobs, artifacts } = fixture();
  const omitted = jobs.map(job => ({ ...job, steps: [] }));
  assert.equal(validateBuild(run, omitted, artifacts, commit, disabledSpeechPolicy).length, 4);
  const skipped = jobs.map(job => ({ ...job, steps: [{ name: 'Verify every installed speech voice', status: 'completed', conclusion: 'skipped' }] }));
  assert.equal(validateBuild(run, skipped, artifacts, commit, disabledSpeechPolicy).length, 4);
  assert.throws(() => validateBuild(run, omitted, artifacts, commit), /did not pass/);
  assert.throws(() => validateBuild(run, skipped, artifacts, commit, enabledSpeechPolicy), /did not pass/);
  for (const platform of ['windows-x64', 'macos-arm64', 'macos-x64']) {
    for (const step of [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }, { status: 'in_progress', conclusion: null }]) {
      const changed = omitted.map(job => job.name === platform ? { ...job, steps: [{ name: 'Verify every installed speech voice', ...step }] } : job);
      assert.throws(() => validateBuild(run, changed, artifacts, commit, disabledSpeechPolicy), /contradicts/);
    }
    const duplicate = skipped.map(job => job.name === platform ? { ...job, steps: [...job.steps, ...job.steps] } : job);
    assert.throws(() => validateBuild(run, duplicate, artifacts, commit, disabledSpeechPolicy), /contradicts/);
  }
});
test('disabled voice policy preserves source, platform job and artifact release gates', () => {
  const { run, artifacts, jobs: original } = fixture();
  const jobs = original.map(job => ({ ...job, steps: [] }));
  assert.throws(() => validateBuild({ ...run, head_sha: 'b'.repeat(40) }, jobs, artifacts, commit, disabledSpeechPolicy));
  assert.throws(() => validateBuild({ ...run, conclusion: 'failure' }, jobs, artifacts, commit, disabledSpeechPolicy));
  for (const job of jobs) {
    assert.throws(() => validateBuild(run, jobs.filter(item => item !== job), artifacts, commit, disabledSpeechPolicy));
    assert.throws(() => validateBuild(run, jobs.map(item => item === job ? { ...item, conclusion: 'failure' } : item), artifacts, commit, disabledSpeechPolicy));
  }
  for (const artifact of artifacts) {
    assert.throws(() => validateBuild(run, jobs, artifacts.filter(item => item !== artifact), commit, disabledSpeechPolicy));
    assert.throws(() => validateBuild(run, jobs, artifacts.map(item => item === artifact ? { ...item, expired: true } : item), commit, disabledSpeechPolicy));
  }
});
test('malformed voice policies cannot weaken release verification', () => {
  const { run, jobs, artifacts } = fixture();
  for (const policy of [null, false, {}, { installedSpeechVerification: false }, { installedSpeechVerification: { enabled: 'false', reason: 'disabled' } }, { installedSpeechVerification: { enabled: false } }, ...['', ' ', ' reason ', 'reason\n', 'a'.repeat(1001)].map(reason => ({ installedSpeechVerification: { enabled: false, reason } }))]) {
    assert.throws(() => validateBuild(run, jobs, artifacts, commit, policy), /policy|requires a nonempty reason/);
    assert.throws(() => verifySpeechSynthesis(synthesisFixture(), 'macos-arm64', commit, policy), /policy|requires a nonempty reason/);
  }
});
test('installer digest and provenance must match before publishing', () => {
  const bytes = Buffer.from('installer');
  verifyDigest(bytes, `sha256:${digest(bytes)}`);
  assert.throws(() => verifyDigest(Buffer.from('changed'), `sha256:${digest(bytes)}`));
  verifyMetadata({ commit, version: '0.1.0', platform: 'windows-x64' }, 'windows-x64', commit, '0.1.0');
  assert.throws(() => verifyMetadata({ commit, version: '0.1.0', platform: 'macos-x64' }, 'windows-x64', commit, '0.1.0'));
});
test('media encoder capabilities must come from the release source and ship in corresponding sources', () => {
  const expected = { sourceLockSha256: 'a'.repeat(64), buildScriptSha256: 'b'.repeat(64), capabilitiesScriptSha256: 'c'.repeat(64) };
  verifyMediaMetadata({ ...expected }, 'windows-x64', expected);
  for (const field of Object.keys(expected)) {
    const stale = { ...expected, [field]: 'd'.repeat(64) };
    assert.throws(() => verifyMediaMetadata(stale, 'windows-x64', expected), /stale media runtime/);
    delete stale[field];
    assert.throws(() => verifyMediaMetadata(stale, 'windows-x64', expected), /stale media runtime/);
  }
  assert.ok(mediaRuntimeSourceFiles.includes('scripts/media-runtime-capabilities.mjs'));
  const directory = mkdtempSync(join(tmpdir(), 'open-media-capabilities-source-'));
  const archive = join(directory, 'source.tar.gz');
  const expectedFiles = new Map(mediaRuntimeSourceFiles.map(file => [file, digest(Buffer.from(file))]));
  try {
    const createArchive = omitted => execFileSync('python3', ['-c', `
import io,json,sys,tarfile
archive,omitted=sys.argv[1:]
with tarfile.open(archive,'w:gz') as out:
    for name in json.load(sys.stdin):
        if name==omitted: continue
        data=name.encode()
        info=tarfile.TarInfo('media-runtime-source/'+name)
        info.size=len(data)
        out.addfile(info,io.BytesIO(data))
`, archive, omitted], { input: JSON.stringify(mediaRuntimeSourceFiles) });
    createArchive('');
    verifySourceContents(archive, 'media-runtime-source', expectedFiles);
    createArchive('scripts/media-runtime-capabilities.mjs');
    assert.throws(() => verifySourceContents(archive, 'media-runtime-source', expectedFiles), /Missing corresponding source files/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
function speechFixture() {
  const expected = { sourceLockSha256: 'a'.repeat(64), prepareScriptSha256: 'b'.repeat(64), runnerSourceSha256: 'c'.repeat(64), runnerManifestSha256: 'd'.repeat(64), model: { id: 'offline-voices', version: '1.0', license: 'Apache-2.0' } };
  const files = ['manifest.json', 'source-lock.json', 'runtime/bin/open-media-speech', 'model/voices.bin', 'licenses/NOTICE'].map(path => ({ path, sha256: 'a'.repeat(64) }));
  const runtime = { schema: 1, platform: 'darwin', arch: 'arm64', ...expected, files, licenses: [files.at(-1)] };
  return { expected, runtime };
}
test('offline speech release requires the exact platform, runner, model and original notices', () => {
  const { expected, runtime } = speechFixture();
  verifySpeechMetadata(runtime, 'macos-arm64', expected);
  assert.throws(() => verifySpeechMetadata(undefined, 'macos-arm64', expected));
  assert.throws(() => verifySpeechMetadata(runtime, 'macos-x64', expected));
  assert.throws(() => verifySpeechMetadata({ ...runtime, runnerSourceSha256: 'e'.repeat(64) }, 'macos-arm64', expected));
  assert.throws(() => verifySpeechMetadata({ ...runtime, model: { ...runtime.model, license: 'unknown' } }, 'macos-arm64', expected));
  assert.throws(() => verifySpeechMetadata({ ...runtime, licenses: [] }, 'macos-arm64', expected));
  assert.throws(() => verifySpeechMetadata({ ...runtime, files: runtime.files.filter(file => !file.path.startsWith('model/')) }, 'macos-arm64', expected));
  assert.throws(() => verifySpeechMetadata({ ...runtime, files: [...runtime.files, { path: '../outside', sha256: 'a'.repeat(64) }] }, 'macos-arm64', expected));
  assert.throws(() => verifySpeechMetadata({ ...runtime, licenses: [{ path: 'licenses/NOTICE', sha256: 'e'.repeat(64) }] }, 'macos-arm64', expected));
});
function synthesisFixture(platform = 'macos-arm64') {
  return {
    schema: 1, platform, sourceCommit: commit, status: 'passed', text: '这是一款全程由AI接管并生成的软件',
    runtimeIntegrity: { unchanged: true }, installationIntegrity: { unchanged: true },
    availability: { python: { mpsAvailable: false, cudaAvailable: false, cudaDeviceCount: 0 }, native: { operatorPlacementMeasured: false } },
    voices: installedSpeechVoiceIds.map(voiceId => ({
      voiceId, status: 'passed', backend: 'cpu', events: ['stage=device,device=cpu', 'stage=complete'], partial: [], fallback: [],
      requestedDevice: 'auto', gpuInferenceVerified: false,
      text: '这是一款全程由AI接管并生成的软件', productionPath: 'SpeechRuntime::command + generate_wave', completionVerified: true, eosVerified: voiceId.startsWith('qwen3_'),
      audio: { path: `${voiceId}/speech.wav`, sha256: digest(Buffer.from(voiceId)), bytes: 192044, sampleRate: voiceId === 'matcha_zh_en_female' ? 16000 : 24000, channels: 1, durationSeconds: 4, peak: 0.8, rms: 0.1, finite: true },
    })),
  };
}
test('disabled voice evidence must truthfully report its source-bound skip reason', () => {
  for (const platform of ['windows-x64', 'macos-arm64', 'macos-x64']) {
    const evidence = { schema: 1, platform, sourceCommit: commit, status: 'skipped', reason: disabledSpeechPolicy.installedSpeechVerification.reason, voices: [] };
    assert.equal(verifySpeechSynthesis(evidence, platform, commit, disabledSpeechPolicy), evidence);
    assert.throws(() => verifySpeechSynthesis(evidence, platform, commit));
    assert.throws(() => verifySpeechSynthesis(evidence, platform, commit, enabledSpeechPolicy));
    assert.throws(() => verifySpeechSynthesis(synthesisFixture(platform), platform, commit, disabledSpeechPolicy), /explicit skipped evidence/);
    for (const patch of [{ schema: 2 }, { platform: 'linux-x64' }, { sourceCommit: 'b'.repeat(40) }, { status: 'passed' }, { status: 'failed' }, { reason: 'different reason' }, { reason: undefined }, { voices: undefined }, { voices: synthesisFixture(platform).voices }, { availability: { python: { mpsAvailable: true } } }, { runtimeIntegrity: { unchanged: true } }, { installationIntegrity: { unchanged: true } }, { gpuInferenceVerified: true }]) {
      assert.throws(() => verifySpeechSynthesis({ ...evidence, ...patch }, platform, commit, disabledSpeechPolicy));
    }
    const passed = synthesisFixture(platform);
    assert.equal(verifySpeechSynthesis(passed, platform, commit, enabledSpeechPolicy), passed);
  }
});
test('installed speech proof is bound to every voice, platform and source commit', () => {
  for (const platform of ['windows-x64', 'macos-arm64', 'macos-x64']) {
    const evidence = synthesisFixture(platform);
    assert.equal(verifySpeechSynthesis(evidence, platform, commit), evidence);
    for (const patch of [{ sourceCommit: 'b'.repeat(40) }, { platform: 'linux-x64' }, { status: 'failed' }, { voices: evidence.voices.slice(1) }, { voices: [...evidence.voices.slice(1), evidence.voices[1]] }, { runtimeIntegrity: { unchanged: false } }, { installationIntegrity: undefined }]) {
      assert.throws(() => verifySpeechSynthesis({ ...evidence, ...patch }, platform, commit));
    }
    for (const patch of [{ voiceId: 'unknown' }, { status: 'failed' }, { events: [] }, { backend: 'mps' }, { text: 'unrelated' }, { productionPath: 'mock' }, { completionVerified: false }, { requestedDevice: 'cpu' }, { gpuInferenceVerified: true }, { events: ['stage=device,device=cpu', 'stage=writing'] }]) {
      assert.throws(() => verifySpeechSynthesis({ ...evidence, voices: evidence.voices.map((voice, i) => i === 0 ? { ...voice, ...patch } : voice) }, platform, commit));
    }
  }
});
test('generated speech evidence rejects silence, corrupt measurements and reused output', () => {
  const evidence = synthesisFixture();
  for (const patch of [{ finite: false }, { peak: 0 }, { rms: 0 }, { rms: NaN }, { peak: Infinity }, { durationSeconds: 0 }, { durationSeconds: 121 }, { sampleRate: 0 }, { sampleRate: 24000 }, { channels: 2 }, { bytes: 44 }, { sha256: 'bad' }, { path: '../speech.wav' }, { sha256: evidence.voices[1].audio.sha256 }, { path: evidence.voices[1].audio.path }]) {
    const changed = { ...evidence, voices: evidence.voices.map((voice, i) => i === 0 ? { ...voice, audio: { ...voice.audio, ...patch } } : voice) };
    assert.throws(() => verifySpeechSynthesis(changed, 'macos-arm64', commit), /speech audio|audible samples/);
  }
  const optional = evidence.voices.find(voice => voice.voiceId === 'f5_zh_female');
  optional.audio.peak = 1.2;
  verifySpeechSynthesis(evidence, 'macos-arm64', commit);
  optional.audio.sampleRate = 16000;
  assert.throws(() => verifySpeechSynthesis(evidence, 'macos-arm64', commit), /audible samples/);
});
test('autoregressive voice verification requires a normal end-of-speech marker', () => {
  const evidence = synthesisFixture();
  for (const voiceId of ['qwen3_serena', 'qwen3_uncle_fu']) {
    const changed = { ...evidence, voices: evidence.voices.map(voice => voice.voiceId === voiceId ? { ...voice, eosVerified: false } : voice) };
    assert.throws(() => verifySpeechSynthesis(changed, 'macos-arm64', commit), /production path/);
  }
});
test('GPU claims require the actual final device event and available hardware', () => {
  const evidence = synthesisFixture();
  const qwen = evidence.voices.find(voice => voice.voiceId === 'qwen3_serena');
  qwen.backend = 'mps'; qwen.gpuInferenceVerified = true;
  qwen.events = ['stage=device,device=mps,engine=qwen3,partial=audio-cpu', 'stage=complete'];
  qwen.partial = [qwen.events[0]];
  assert.throws(() => verifySpeechSynthesis(evidence, 'macos-arm64', commit), /availability evidence/);
  evidence.availability.python.mpsAvailable = true;
  verifySpeechSynthesis(evidence, 'macos-arm64', commit);
  qwen.events.splice(-1, 0, 'stage=device,device=cpu,engine=qwen3');
  assert.throws(() => verifySpeechSynthesis(evidence, 'macos-arm64', commit), /production event/);
  qwen.backend = 'cpu'; qwen.gpuInferenceVerified = false;
  qwen.fallback = ['stage=fallback,from=mps,device=cpu,reason=unsupported_operation'];
  verifySpeechSynthesis(evidence, 'macos-arm64', commit);
  const windows = synthesisFixture('windows-x64');
  const voice = windows.voices.find(voice => voice.voiceId === 'f5_zh_male');
  voice.backend = 'cuda'; voice.gpuInferenceVerified = true; voice.events = ['stage=device,device=cuda,engine=f5', 'stage=complete'];
  assert.throws(() => verifySpeechSynthesis(windows, 'windows-x64', commit), /availability evidence/);
  windows.availability.python.cudaAvailable = true;
  windows.availability.python.cudaDeviceCount = 1;
  verifySpeechSynthesis(windows, 'windows-x64', commit);
});
test('CoreML provider evidence preserves the unmeasured operator placement limitation', () => {
  const evidence = synthesisFixture();
  const voice = evidence.voices[0];
  voice.backend = 'coreml'; voice.gpuInferenceVerified = null; voice.events = ['stage=device,device=coreml,engine=matcha', 'stage=complete'];
  assert.throws(() => verifySpeechSynthesis(evidence, 'macos-arm64', commit), /operator placement/);
  voice.backendNote = 'CoreML execution provider completed; individual operator placement is not measured.';
  verifySpeechSynthesis(evidence, 'macos-arm64', commit);
  evidence.availability.native.operatorPlacementMeasured = true;
  assert.throws(() => verifySpeechSynthesis(evidence, 'macos-arm64', commit), /operator placement/);
  evidence.availability.native.operatorPlacementMeasured = false;
  evidence.platform = 'windows-x64';
  assert.throws(() => verifySpeechSynthesis(evidence, 'windows-x64', commit), /operator placement/);
});
test('corresponding source checksums require both media and speech archives exactly once', () => {
  const media = `${'a'.repeat(64)}  open-media-runtime-source.tar.gz`;
  const speech = `${'b'.repeat(64)}  open-media-speech-source.tar.gz`;
  assert.equal(sourceChecksums(`${media}\n${speech}\n`).size, 2);
  assert.throws(() => sourceChecksums(media));
  assert.throws(() => sourceChecksums(speech));
  assert.throws(() => sourceChecksums(`${media}\n${speech}\n${speech}`));
});
test('streaming source verification rejects missing dependencies and modified model bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-media-release-'));
  try {
    const archive = join(directory, 'source.tar.gz');
    const sources = [
      { id: 'engine', archive: 'engine.tar.gz', kind: 'source', bytes: 'complete engine source' },
      { id: 'dependency', archive: 'dependency.tar.gz', kind: 'source', bytes: 'complete dependency source and license' },
      { id: 'model', archive: 'model.tar.gz', kind: 'model', bytes: 'original model weights and license' },
      { id: 'vocoder', archive: 'vocoder.onnx', kind: 'vocoder', bytes: 'original vocoder weights' },
      { id: 'runtime', archive: 'runtime.tar.gz', kind: 'runtime', bytes: 'verified runtime release' },
    ].map(source => ({ ...source, sha256: digest(Buffer.from(source.bytes)) }));
    const expected = speechSourceRequirements({ sources });
    const writeArchive = files => execFileSync('python3', ['-c', `
import io,json,sys,tarfile
with tarfile.open(sys.argv[1],'w:gz') as archive:
    for file in json.load(sys.stdin):
        data=file['bytes'].encode()
        entry=tarfile.TarInfo('speech-runtime-source/.speech-runtime/downloads/'+file['archive'])
        entry.size=len(data)
        archive.addfile(entry,io.BytesIO(data))
`, archive], { input: JSON.stringify(files) });
    writeArchive(sources);
    verifySourceContents(archive, 'speech-runtime-source', expected);
    writeArchive(sources.filter(source => source.id !== 'dependency'));
    assert.throws(() => verifySourceContents(archive, 'speech-runtime-source', expected), /Missing corresponding source files/);
    writeArchive(sources.filter(source => source.id !== 'vocoder'));
    assert.throws(() => verifySourceContents(archive, 'speech-runtime-source', expected), /Missing corresponding source files/);
    writeArchive(sources.map(source => source.id === 'model' ? { ...source, bytes: 'modified weights' } : source));
    assert.throws(() => verifySourceContents(archive, 'speech-runtime-source', expected), /checksum mismatch/);
    assert.throws(() => speechSourceRequirements({ sources: sources.filter(source => source.kind !== 'source') }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(repository, path));
test('offline speech notices retain original model and dependency license bytes', () => {
  const lock = JSON.parse(read('scripts/speech-runtime.lock.json'));
  const inventory = JSON.parse(read('licenses/speech-runtime/manifest.json'));
  const sources = new Map(lock.sources.map(source => [source.id, source]));
  assert.equal(inventory.schema, 1);
  assert.ok(inventory.files.length);
  const paths = new Set();
  for (const file of inventory.files) {
    assert.ok(sources.has(file.sourceId), `Unknown speech license source: ${file.sourceId}`);
    assert.ok(file.sourcePath, 'Preserve the original source path of each notice.');
    assert.ok(!paths.has(file.path), `Duplicate speech notice: ${file.path}`);
    paths.add(file.path);
    assert.equal(digest(read(`licenses/speech-runtime/${file.path}`)), file.sha256, `Original speech notice was modified: ${file.path}`);
  }
  for (const source of lock.sources.filter(source => source.kind === 'model')) assert.ok(inventory.files.some(file => file.sourceId === source.id), `Missing model license: ${source.id}`);
});
test('native dependency notices cover locked archives and retain verified original texts', () => {
  const base = 'licenses/application/cargo';
  const inventory = JSON.parse(read(`${base}/manifest.json`));
  const lock = read('src-tauri/Cargo.lock');
  assert.equal(inventory.sourceLockSha256, digest(lock), 'Refresh the dependency inventory after changing the lock file.');
  const packages = lock.toString().split('[[package]]').filter(block => /source = "registry\+/.test(block)).map(block => ({
    name: /^name = "([^"]+)"/m.exec(block)[1],
    version: /^version = "([^"]+)"/m.exec(block)[1],
    checksum: /^checksum = "([^"]+)"/m.exec(block)[1],
  }));
  assert.equal(inventory.packages.length, packages.length);
  for (const item of packages) {
    const entry = inventory.packages.find(value => value.name === item.name && value.version === item.version);
    assert.ok(entry, `Missing notices for ${item.name} ${item.version}`);
    assert.equal(entry.archiveSha256, item.checksum);
    assert.ok(entry.notices.length, `Missing original license texts for ${item.name}`);
    for (const notice of entry.notices) assert.equal(digest(read(`${base}/${notice.file}`)), notice.sha256);
  }
});

test('frontend dependency notices match audited inputs and include vendored helper permissions', () => {
  const inventory = JSON.parse(read('licenses/application/frontend/manifest.json'));
  for (const input of inventory.inputs) assert.equal(digest(read(input.path)), input.sha256, `Refresh the frontend inventory after changing ${input.path}.`);
  for (const entry of inventory.packages) {
    assert.ok(entry.licenses.length);
    for (const license of entry.licenses) assert.equal(digest(read(license.bundledPath)), license.sha256);
  }
  for (const entry of inventory.vendoredComponents) {
    assert.equal(digest(read(entry.bundledLicensePath)), entry.licenseSha256);
    assert.equal(digest(read(entry.sourcePath)), entry.sourceFileSha256);
  }
});
