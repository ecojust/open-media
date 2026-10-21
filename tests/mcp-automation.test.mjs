import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { IDBFactory } from 'fake-indexeddb'
import { createClip, createProject, createSubtitleClip, cloneProject } from '../src/core/project.ts'
import { addClip, commitHistory, createHistory, findClip, redoHistory, undoHistory } from '../src/core/timeline.ts'
import { getSpeechSettings, subscribeSpeechSettings, updateSpeechSettings } from '../src/core/speech-settings.ts'
import { storeToolArtifact } from '../src/core/tool-artifacts.ts'
import { addTransition } from '../src/core/transitions.ts'

// Replace only native/file/canvas I/O boundaries. The controller, project edits,
// revision checks, undo history, speech settings and speech scheduler are real.
const boundaryExports = {
  '../src/native.ts': ['acceptSpeechJobs', 'beginSpeechJob', 'beginSpeechModelDownload', 'cancelMediaJob', 'cancelSpeechJob', 'cancelSpeechModelDownload', 'discardSpeechJob', 'getMediaJobs', 'getSpeechJob', 'getSpeechStatus', 'repairSpeechModel', 'revealMediaJobOutput'],
  '../src/native-mcp-files.ts': ['beginMcpMediaJob', 'importMcpMediaPaths', 'openMcpProjectFile', 'saveMcpProjectFile'],
  '../src/native-asset-tools.ts': ['runAssetTool'],
  '../src/native-video-generation.ts': ['getVideoGenerationStatus', 'beginVideoModelDownload', 'cancelVideoModelDownload', 'beginVideoGeneration', 'getVideoGenerationJob', 'cancelVideoGeneration'],
  '../src/native-ai.ts': ['beginAiGeneration', 'cancelAiJob', 'cancelAiModelDownload', 'downloadAiModel', 'getAiJob', 'getAiStatus', 'repairAiModel'],
  '../src/core/native-project.ts': ['prepareNativeProject'],
  '../src/native-project-files.ts': ['prepareNativeProjectArchive', 'restoreNativeProjectArchive'],
  '../src/core/mcp-materials.ts': ['listMcpMaterials', 'prepareMcpMaterial'],
  '../src/core/editor-preview-tools.ts': ['preparePreviewTool'],
}
const mockedModules = new Map(Object.entries(boundaryExports).map(([file, exports]) => [new URL(file, import.meta.url).href, exports]))
registerHooks({ load(url, context, nextLoad) {
  const exports = mockedModules.get(url)
  if (!exports) return nextLoad(url, context)
  return { format: 'module', shortCircuit: true, source: exports.map(name => `export function ${name}(...args) { return globalThis.__openMediaMcpTestIo.${name}(...args) }`).join('\n') }
} })
const { createMcpAutomation } = await import('../src/core/mcp-automation.ts')
// Load the actual material service under a separate URL so these integration
// cases replace only media I/O, while existing controller tests retain their stub.
const { prepareMcpMaterial: prepareRealMcpMaterial } = await import('../src/core/mcp-materials.ts?integration')
const clone = value => structuredClone(value)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate, description = 'asynchronous operation') {
  for (let index = 0; index < 1000; index++) { if (predicate()) return; await tick() }
  throw new Error(`Timed out waiting for ${description}`)
}
async function finished(controller, job) {
  await until(() => controller.status(job.id).state !== 'running', `job ${job.id}`)
  await tick()
  return controller.status(job.id)
}
const video = (id = 'source-video') => ({ id, name: 'video.mp4', kind: 'video', url: 'blob:video', nativePath: '/private/video.mp4', duration: 10, width: 1280, height: 720, size: 10, mime: 'video/mp4' })
const voice = { id: 'matcha_zh_en_female', name: 'Matcha 中英', language: 'zh-CN', status: 'bundled' }

function fixture(initialProject = createProject('当前工程', { width: 640, height: 360 })) {
  globalThis.indexedDB = new IDBFactory()
  let history = createHistory(initialProject), revision = 7, projectSession = 1, busy = false, dirty = false, target
  let playback = { time: 2.5, playing: false, selectedClipId: '' }
  const calls = [], announcements = [], assets = [], commits = [], blobs = new Map()
  const io = {
    async getAiStatus() { return { busy: false, jobs: [], models: [
      ...['qwen-image', 'z-image-turbo'].map(id => ({ id, provider: 'image' })),
      ...['ace-step-1.5-turbo', 'ace-step-1.5-sft'].map(id => ({ id, provider: 'music' })),
      { id: 'f5-v1-base-fp32', provider: 'speech' }, { id: 'h3-base-fl2va', provider: 'video' },
    ].map(model => ({ ...model, name: model.id, state: 'ready', runtime: { state: 'ready' }, size: 100, downloadedBytes: 100 })) } },
    async downloadAiModel() { return io.getAiStatus() }, async repairAiModel() { return io.getAiStatus() }, async cancelAiModelDownload() { return io.getAiStatus() },
    async beginAiGeneration({ provider, request }) { return { id: request.requestId, provider, modelId: request.modelId, kind: 'generation', state: 'completed', stage: '完成', progress: 1, startedAt: Date.now(), elapsedSeconds: 1, cancelable: false,
      assets: [{ ...video(`generated-${request.requestId}`), kind: provider === 'image' ? 'image' : 'audio', name: provider === 'image' ? '生成.png' : '生成.wav', mime: provider === 'image' ? 'image/png' : 'audio/wav', duration: provider === 'image' ? 0 : 30, provenance: { kind: 'url', url: 'https://private.example/secret', sha256: 'a'.repeat(64), importedAt: 1 } }] } },
    async getAiJob() { throw new Error('unexpected AI generation polling') }, async cancelAiJob() {},
    async getVideoGenerationStatus() { return { supported: true, runtimeReady: true, models: [{ id: 'h3-base-fl2va', name: '视频生成', modes: ['prompt', 'image', 'storyboard'], state: 'ready', size: 100, downloadedBytes: 100 }, { id: 'h3-base-ref2va', name: '参考生成', modes: ['reference'], state: 'ready', size: 100, downloadedBytes: 100 }] } },
    async beginVideoModelDownload() { return io.getVideoGenerationStatus() },
    async cancelVideoModelDownload() { return io.getVideoGenerationStatus() },
    async beginVideoGeneration(request) { const assets = request.shots.map((shot, index) => ({ ...video(`generated-${request.requestId}-${index}`), name: `${shot.title}.mp4`, duration: shot.seconds })); return { id: request.requestId, state: 'completed', stage: '完成', progress: 1, shotIndex: assets.length - 1, shotCount: assets.length, assets, startedAt: Date.now(), elapsedSeconds: 1, ...(request.joinShots && assets.length > 1 ? { combinedAsset: { ...video(`generated-combined-${request.requestId}`), duration: assets.reduce((sum, asset) => sum + asset.duration, 0) } } : {}) } },
    async getVideoGenerationJob() { throw new Error('unexpected video generation polling') }, async cancelVideoGeneration() {},
    async getSpeechStatus() { return { ready: true, voices: [voice] } },
    async beginSpeechJob(request) { return { id: request.requestId, state: 'completed', progress: 1, stage: '完成', asset: { id: `speech-${request.requestId}`, name: '配音.wav', kind: 'audio', url: 'http://asset.localhost/voice.wav', nativePath: '/private/voice.wav', duration: 2, width: 0, height: 0, size: 10, mime: 'audio/wav' } } },
    async getSpeechJob() { throw new Error('unexpected speech polling') },
    async cancelSpeechJob() {}, async discardSpeechJob() {}, async acceptSpeechJobs() {},
    async beginSpeechModelDownload() { return { ready: true, voices: [voice] } }, async cancelSpeechModelDownload() { return { ready: true, voices: [voice] } }, async repairSpeechModel() { return { ready: true, voices: [voice] } },
    async beginMcpMediaJob(spec, outputPath) { return { id: 'native-export', state: 'completed', progress: 1, name: '导出', outputPath, backend: 'cpu', elapsedSeconds: 2 } },
    async getMediaJobs() { return [] }, async cancelMediaJob() {},
    async revealMediaJobOutput() {},
    async importMcpMediaPaths() { return [video()] },
    async runAssetTool(operation, args) {
      if (operation === 'asset_upload_commit') return { asset: video('uploaded-video'), source: { kind: 'upload', sha256: 'a'.repeat(64), importedAt: Date.now() } }
      if (operation === 'asset_upload_abort') return { aborted: true }
      return { uploadId: args.uploadId || 'upload-source', receivedBytes: 4, totalBytes: 4 }
    },
    async openMcpProjectFile(path) { return { path, token: 'open-file-capability', project: createProject('已打开工程') } },
    async saveMcpProjectFile(_project, options) { return { path: options.path || '/existing.omedia', token: 'saved-file-capability' } },
    async prepareNativeProjectArchive(project, options) { options.onProgress?.(1, 1); return clone(project) },
    async restoreNativeProjectArchive(project) { return clone(project) },
    async prepareNativeProject(project) { return { project: clone(project) } },
    async preparePreviewTool() { throw new Error('unexpected preview operation') },
    async listMcpMaterials(query) { return { kind: query.kind, total: 1, offset: 0, limit: 50, items: [{ id: 'sample', name: '示例' }] } },
    async prepareMcpMaterial(project, args) {
      const clip = createSubtitleClip(project, { text: '内置素材', start: args.start ?? 0 })
      return { project: addClip(project, project.tracks[0].id, clip), label: '添加素材', selection: { clipId: clip.id, trackId: project.tracks[0].id } }
    },
  }
  globalThis.__openMediaMcpTestIo = Object.fromEntries(Object.keys(io).map(name => [name, (...args) => { calls.push({ name, args }); return io[name](...args) }]))
  const host = {
    getProject: () => history.present, getRevision: () => revision, getProjectSession: () => projectSession, isBusy: () => busy,
    getBlobs: () => blobs, getSaveTarget: () => target,
    commit(project, label, expected) {
      if (expected.projectId !== history.present.id || expected.revision !== revision || expected.projectSession !== projectSession) return false
      commits.push({ project: clone(project), label, expected })
      history = commitHistory(history, project); revision++; dirty = true; return true
    },
    async hydrate(imported) { return imported.project },
    async didSave(project, value, expected) { if (expected.projectId !== history.present.id || expected.projectSession !== projectSession) return; target = value; if (project.updatedAt === history.present.updatedAt) dirty = false },
    history(direction) { history = direction === 'undo' ? undoHistory(history) : redoHistory(history); revision++; dirty = true },
    getPlayback: () => clone(playback), async setPlayback(patch) { playback = { ...playback, ...patch }; return clone(playback) },
    ownAsset(asset, blob) { assets.push(asset); if (blob) blobs.set(asset.id, blob) },
    onBusy(value) { busy = value }, onJobsChanged() {}, announce(value) { announcements.push(value) },
  }
  const controller = createMcpAutomation(host)
  return { controller, host, io, calls, announcements, assets, commits,
    get project() { return history.present }, get revision() { return revision }, get busy() { return busy }, get dirty() { return dirty }, get target() { return target },
    setBusy(value) { busy = value }, setDirty(value) { dirty = value }, setTarget(value) { target = value },
    externalChange() { history.present.title = '本地更新'; revision++; dirty = true },
    reopen() { history = createHistory(clone(history.present)); projectSession++ },
    openOther() { history = createHistory(createProject('其他工程')); projectSession++ },
    run: (name, args = {}) => controller.execute(`open_media_${name}`, args),
  }
}

test('controller edits the authoritative project, rejects stale revisions and shares undo/redo', async () => {
  const f = fixture()
  const first = await f.run('project_get')
  assert.equal(first.revision, 7)
  const update = await f.run('project_update', { expectedRevision: 7, patch: { title: '远程修改' } })
  assert.equal(update.revision, 8)
  assert.equal(f.project.title, '远程修改')
  assert.equal(f.commits.length, 1)
  await assert.rejects(f.run('project_update', { expectedRevision: 7, patch: { title: '过时覆盖' } }), /版本已变化/)
  assert.equal(f.project.title, '远程修改')
  await f.run('project_history', { direction: 'undo', expectedRevision: 8 })
  assert.equal(f.project.title, '当前工程')
  await f.run('project_history', { direction: 'redo' })
  assert.equal(f.project.title, '远程修改')
  await assert.rejects(f.run('project_update', { patch: { id: 'forged' } }), /不支持/)
  await f.controller.dispose()
})

test('busy project remains inspectable but rejects edits, undo and playback control', async () => {
  const f = fixture()
  f.setBusy(true)
  assert.equal((await f.run('project_get')).title, '当前工程')
  for (const [name, args] of [['project_update', { patch: { title: '不得修改' } }], ['project_history', { direction: 'undo' }], ['playback_set', { time: 1 }], ['speech_settings_set', { rate: 1.1 }]]) await assert.rejects(f.run(name, args), /正在处理/)
  assert.equal(f.commits.length, 0)
  f.setBusy(false)
  assert.equal((await f.run('playback_set', { time: 4, playing: true })).time, 4)
  await f.controller.dispose()
})

test('motion style discovery is synchronous, searchable and isolated from project edits and jobs', async () => {
  const f = fixture()
  f.setBusy(true)
  const all = await f.run('motion_style_list', { expectedProjectId: f.project.id, expectedRevision: f.revision })
  assert.equal(all.execution, 'synchronous')
  assert.equal(all.final, true)
  assert.equal(all.total, 15)
  assert.equal(all.count, 15)
  assert.equal(all.items.length, 15)
  assert.equal(all.capabilities.editable, true)
  assert.equal(all.capabilities.rendering, '2d')
  assert.equal(all.projectId, f.project.id)
  const filtered = await f.run('motion_style_list', { search: '  TECH-HUD  ' })
  assert.deepEqual(filtered.items.map(style => style.id), ['tech-hud'])
  assert.equal(filtered.total, 15)
  assert.equal(filtered.count, 1)
  assert.equal((await f.run('motion_style_list', { search: '科普' })).items[0].id, 'sticker-notes')
  assert.equal((await f.run('motion_style_list', { search: 'no-matching-style' })).count, 0)
  filtered.items[0].palette.accent = '#000000'
  filtered.items[0].tags.push('injected')
  const original = (await f.run('motion_style_list', { search: 'tech-hud' })).items[0]
  assert.notEqual(original.palette.accent, '#000000')
  assert.equal(original.tags.includes('injected'), false)
  await assert.rejects(f.run('motion_style_list', { expectedProjectId: 'old-project' }), /当前工程已变化/)
  await assert.rejects(f.run('motion_style_list', { expectedRevision: 0 }), /项目版本已变化/)
  assert.equal(f.calls.length, 0)
  assert.equal(f.commits.length, 0)
  assert.equal(f.controller.list().length, 0)
  await f.controller.dispose()
})

test('motion composition preflight uses the asynchronous shared tool without creating artwork or editing the project', async () => {
  const project = createProject('风格预检', { width: 640, height: 360 })
  project.assets.push(video())
  const f = fixture(project), before = clone(project)
  const args = { styleId: 'tech-hud', scenes: [{ assetId: 'source-video', heading: '测试场景', duration: 4 }], dryRun: true, expectedProjectId: project.id, expectedRevision: f.revision }
  const job = await f.run('motion_compose', args)
  assert.equal(job.execution, 'asynchronous')
  assert.equal(job.responseType, 'job')
  assert.equal(job.tool, 'open_media_motion_compose')
  assert.deepEqual(job.poll, { tool: 'open_media_job_get', arguments: { id: job.jobId } })
  const done = await finished(f.controller, job)
  assert.equal(done.state, 'completed', done.error)
  assert.equal(done.result.dryRun, true)
  assert.equal(done.result.styleId, 'tech-hud')
  assert.equal(done.result.scenes.length, 1)
  assert.equal(done.result.duration, 4)
  assert.deepEqual(f.project, before)
  assert.equal(f.commits.length, 0)
  assert.equal(f.assets.length, 0)
  assert.equal(f.calls.length, 0)
  assert.equal(f.busy, false)
  const missing = await finished(f.controller, await f.run('motion_compose', { ...args, scenes: [{ assetId: 'missing-asset' }] }))
  assert.equal(missing.state, 'failed')
  assert.equal(f.commits.length, 0)
  assert.deepEqual(f.project, before)
  await f.controller.dispose()
})

test('expected project identity rejects stale clients before edits, native I/O or settings changes', async () => {
  const f = fixture(), before = clone(f.project), settings = getSpeechSettings()
  for (const [name, args] of [['project_get', {}], ['project_update', { patch: { title: '不应修改' } }], ['asset_import', { paths: ['/other.mp4'] }], ['project_save', {}], ['speech_settings_set', { rate: 1.5 }], ['ai_status', {}]]) {
    await assert.rejects(f.run(name, { ...args, expectedProjectId: 'another-project' }), /当前工程已变化/)
  }
  assert.deepEqual(f.project, before)
  assert.deepEqual(getSpeechSettings(), settings)
  assert.equal(f.calls.length, 0)
  assert.equal(f.commits.length, 0)
  assert.equal(f.controller.list().length, 0)
  const result = await f.run('project_update', { expectedProjectId: before.id, expectedRevision: f.revision, patch: { title: '当前工程更新' } })
  assert.equal(result.projectId, before.id)
  assert.equal(f.commits[0].expected.projectSession, 1)
  await f.run('speech_settings_set', { expectedProjectId: before.id, rate: settings.rate })
  assert.equal(Object.hasOwn(getSpeechSettings(), 'expectedProjectId'), false)
  await f.controller.dispose()
})

test('MCP cannot create or open another project even with discard consent', async () => {
  const f = fixture(), before = clone(f.project)
  f.setDirty(true)
  for (const [name, args] of [['project_new', { title: '新工程' }], ['project_new', { discardUnsaved: true }], ['project_open', { path: '/other.omedia', discardUnsaved: true }]]) {
    await assert.rejects(f.run(name, args), /MCP 只能处理当前打开的工程/)
  }
  assert.deepEqual(f.project, before)
  assert.equal(f.dirty, true)
  assert.equal(f.target, undefined)
  assert.equal(f.calls.length, 0)
  assert.equal(f.controller.list().length, 0)
  await f.controller.dispose()
})

test('import runs once as an atomic undo step and adopts source size for a fresh project', async () => {
  const f = fixture(createProject('跟随源尺寸'))
  const job = await f.run('asset_import', { paths: ['/video.mp4'], expectedRevision: 7 })
  assert.equal(job.state, 'running')
  const done = await finished(f.controller, job)
  assert.equal(done.state, 'completed')
  assert.equal(f.project.assets.length, 1)
  assert.equal(f.project.width, 1280)
  assert.equal(f.project.height, 720)
  assert.equal(f.commits.length, 1)
  assert.equal(f.assets.length, 1)
  assert.equal(f.busy, false)
  await f.run('project_history', { direction: 'undo' })
  assert.equal(f.project.assets.length, 0)
  await f.controller.dispose()
})

test('upload capabilities belong to the current project session while old uploads may be aborted', async () => {
  for (const change of ['reopen', 'openOther']) {
    const f = fixture()
    const upload = await f.run('asset_upload', { action: 'begin', name: 'sample.mp4', size: 4, sha256: 'a'.repeat(64) })
    await f.run('asset_upload', { action: 'status', uploadId: upload.uploadId })
    f[change]()
    const priorCalls = f.calls.length
    for (const action of ['status', 'commit', 'chunk']) {
      await assert.rejects(f.run('asset_upload', { action, uploadId: upload.uploadId, ...(action === 'chunk' ? { offset: 0, base64: 'dGVzdA==', sha256: 'a'.repeat(64) } : {}) }), /不属于当前打开的工程会话/)
    }
    assert.equal(f.calls.length, priorCalls)
    assert.equal(f.project.assets.length, 0)
    assert.equal((await f.run('asset_upload', { action: 'abort', uploadId: upload.uploadId })).aborted, true)
    await assert.rejects(f.run('asset_upload', { action: 'abort', uploadId: upload.uploadId }), /失效/)
    await f.controller.dispose()
  }
})

test('upload capabilities survive edits in the same session and commit to its current project', async () => {
  const f = fixture()
  const upload = await f.run('asset_upload', { action: 'begin', name: 'sample.mp4', size: 4, sha256: 'a'.repeat(64) })
  await f.run('project_update', { patch: { title: '继续编辑当前工程' } })
  const done = await finished(f.controller, await f.run('asset_upload', { action: 'commit', uploadId: upload.uploadId }))
  assert.equal(done.state, 'completed')
  assert.equal(done.result.assetId, 'uploaded-video')
  assert.equal(f.project.title, '继续编辑当前工程')
  assert.equal(f.project.assets.length, 1)
  await f.controller.dispose()
})

test('nested preview artifacts stay readable only in the session that generated them', async () => {
  for (const change of ['reopen', 'openOther']) {
    const f = fixture()
    const artifact = await storeToolArtifact(new Blob(['preview'], { type: 'image/png' }), 'frame.png')
    f.io.preparePreviewTool = async () => ({ data: { frames: [{ sheet: artifact }] } })
    const job = await finished(f.controller, await f.run('timeline_get_frame', { time: 0 }))
    assert.equal(job.state, 'completed')
    const read = await f.run('artifact_read', { artifactId: artifact.artifactId })
    assert.equal(Buffer.from(read.data, 'base64').toString(), 'preview')
    await f.run('project_update', { patch: { title: '同工程更新' } })
    assert.equal((await f.run('artifact_read', { artifactId: artifact.artifactId })).bytes, 7)
    f[change]()
    assert.equal((await f.run('job_get', { id: job.id })).result, undefined)
    assert.equal(f.controller.status(job.id).result.frames[0].sheet.artifactId, artifact.artifactId)
    await assert.rejects(f.run('artifact_read', { artifactId: artifact.artifactId }), /不属于当前打开的工程会话/)
    await f.controller.dispose()
  }
})

test('remote old-session jobs expose only status while internal history retains inline preview results', async () => {
  for (const change of ['reopen', 'openOther']) {
    const f = fixture()
    f.io.preparePreviewTool = async () => ({ data: { base64: 'private-frame-payload', nested: { artifactId: 'private-artifact' }, sourceName: '私有素材名称' } })
    const job = await finished(f.controller, await f.run('timeline_get_frame', { time: 0 }))
    assert.equal((await f.run('job_get', { id: job.id })).projectCurrent, true)
    f[change]()
    for (const response of [await f.run('job_get', { id: job.id }), (await f.run('job_list')).find(item => item.id === job.id), await f.run('job_cancel', { id: job.id })]) {
      assert.equal(response.state, 'completed')
      assert.equal(response.projectCurrent, false)
      assert.equal(response.resultAvailable, false)
      for (const field of ['result', 'error', 'errorDetails', 'warning']) assert.equal(Object.hasOwn(response, field), false)
      assert.equal(JSON.stringify(response).includes('private-'), false)
      assert.equal(JSON.stringify(response).includes('私有素材名称'), false)
    }
    assert.equal(f.controller.status(job.id).result.base64, 'private-frame-payload')
    assert.equal(f.controller.list()[0].result.base64, 'private-frame-payload')
    await f.controller.dispose()
  }
})

test('old-session speech job responses omit generated IDs and skipped subtitle contents', async () => {
  let project = createProject('配音状态归属')
  project = addClip(project, project.tracks[0].id, createSubtitleClip(project, { id: 'private-caption', name: '私有字幕名称', text: '字幕内容' }))
  project = addClip(project, project.tracks[0].id, createSubtitleClip(project, { id: 'private-empty', name: '私有空字幕名称', text: '' }))
  const f = fixture(project)
  const job = await finished(f.controller, await f.run('speech_generate'))
  assert.equal(job.state, 'completed')
  assert.ok(job.skipped.length)
  assert.ok(job.result.assetIds.length)
  f.reopen()
  for (const response of [await f.run('job_get', { id: job.id }), (await f.run('job_list')).find(item => item.id === job.id), await f.run('job_cancel', { id: job.id })]) {
    assert.equal(response.projectCurrent, false)
    assert.equal(response.result, undefined)
    assert.equal(response.skipped, undefined)
    assert.equal(response.currentClipId, undefined)
    assert.equal(response.voiceId, undefined)
    assert.equal(JSON.stringify(response).includes('private-'), false)
    assert.equal(JSON.stringify(response).includes('私有'), false)
  }
  assert.ok(f.controller.status(job.id).result.assetIds.length)
  await f.controller.dispose()
})

test('remote cancel checks project ownership after an awaited native cancellation', async () => {
  const f = fixture(), started = deferred(), cancelled = deferred()
  f.io.beginMcpMediaJob = async () => ({ id: 'native-active', state: 'running', stage: '私有视频正在导出' })
  f.io.cancelMediaJob = async () => { started.resolve(); await cancelled.promise }
  const job = await f.run('export_start', { outputPath: '/private/result.mp4', format: 'mp4' })
  await until(() => f.calls.some(call => call.name === 'beginMcpMediaJob'))
  const response = f.run('job_cancel', { id: job.id })
  await started.promise
  f.reopen()
  cancelled.resolve()
  const result = await response
  assert.equal(result.projectCurrent, false)
  assert.equal(result.result, undefined)
  assert.equal(JSON.stringify(result).includes('私有'), false)
  assert.equal(JSON.stringify(result).includes('/private/'), false)
  await finished(f.controller, job)
  await f.controller.dispose()
})

test('a late upload start never grants its capability to a replacement project session', async () => {
  const f = fixture(), pending = deferred()
  f.io.runAssetTool = () => pending.promise
  const upload = f.run('asset_upload', { action: 'begin', name: 'sample.mp4', size: 4, sha256: 'a'.repeat(64) })
  await until(() => f.calls.some(call => call.name === 'runAssetTool'))
  f.reopen()
  pending.resolve({ uploadId: 'late-upload', receivedBytes: 0, totalBytes: 4 })
  await assert.rejects(upload, /当前工程会话已变化/)
  await assert.rejects(f.run('asset_upload', { action: 'commit', uploadId: 'late-upload' }), /不属于当前打开的工程会话/)
  assert.equal(f.project.assets.length, 0)
  await f.controller.dispose()
})

test('failed or cancelled previews never expose artifact capabilities in a later session', async () => {
  for (const action of ['reopen', 'cancel']) {
    const f = fixture(), pending = deferred()
    const artifact = await storeToolArtifact(new Blob(['preview'], { type: 'image/png' }), 'frame.png')
    f.io.preparePreviewTool = () => pending.promise
    const job = await f.run('timeline_get_frame', { time: 0 })
    await until(() => f.calls.some(call => call.name === 'preparePreviewTool'))
    if (action === 'cancel') await f.run('job_cancel', { id: job.id })
    else f.reopen()
    pending.resolve({ data: { artifact } })
    assert.equal((await finished(f.controller, job)).state, action === 'cancel' ? 'cancelled' : 'failed')
    await assert.rejects(f.run('artifact_read', { artifactId: artifact.artifactId }), /不属于当前打开的工程会话/)
    await f.controller.dispose()
  }
})

test('cancelled and stale imports never overwrite the active project', async () => {
  for (const mode of ['cancel', 'stale', 'reopen']) {
    const f = fixture(), pending = deferred()
    f.io.importMcpMediaPaths = () => pending.promise
    const job = await f.run('asset_import', { paths: ['/slow.mp4'] })
    await until(() => f.calls.some(call => call.name === 'importMcpMediaPaths'))
    if (mode === 'cancel') await f.run('job_cancel', { id: job.id })
    else if (mode === 'reopen') f.reopen()
    else f.externalChange()
    pending.resolve([video()])
    const done = await finished(f.controller, job)
    assert.equal(done.state, mode === 'cancel' ? 'cancelled' : 'failed')
    assert.equal(f.project.assets.length, 0)
    assert.equal(f.commits.length, 0)
    assert.equal(f.busy, false)
    assert.equal((await f.run('job_get', { id: job.id })).state, done.state)
    await f.controller.dispose()
  }
})

test('save writes only the existing GUI target and rejects path or overwrite overrides', async () => {
  const f = fixture()
  f.setDirty(true)
  f.setTarget({ path: '/existing.omedia', token: 'existing-capability' })
  const first = await finished(f.controller, await f.run('project_save'))
  assert.equal(first.state, 'completed')
  const firstCall = f.calls.find(call => call.name === 'saveMcpProjectFile')
  assert.equal(firstCall.args[1].token, 'existing-capability')
  assert.equal(firstCall.args[1].path, undefined)
  assert.equal(f.dirty, false)
  assert.ok(!JSON.stringify(first.result).includes('capability'))
  for (const args of [{ path: '/copy.omedia' }, { overwrite: true }, { token: 'forged-capability' }]) {
    await assert.rejects(f.run('project_save', args), /不支持参数/)
  }
  assert.equal(f.calls.filter(call => call.name === 'saveMcpProjectFile').length, 1)
  assert.equal(f.target.path, '/existing.omedia')
  await f.controller.dispose()
})

test('save without a GUI-granted target requests a local save without preparing or writing files', async () => {
  for (const target of [undefined, { path: '/unselected.omedia', token: '' }]) {
    const f = fixture()
    f.setTarget(target)
    const done = await finished(f.controller, await f.run('project_save'))
    assert.equal(done.state, 'failed')
    assert.match(done.error, /请先在软件界面中保存工程/)
    assert.equal(f.calls.length, 0)
    await f.controller.dispose()
  }
})

test('changing the GUI save target during preparation never writes the prior target', async () => {
  const f = fixture(), pending = deferred()
  f.setTarget({ path: '/prior.omedia', token: 'prior-capability' })
  f.io.prepareNativeProjectArchive = () => pending.promise
  const job = await f.run('project_save')
  await until(() => f.calls.some(call => call.name === 'prepareNativeProjectArchive'))
  f.setTarget({ path: '/new.omedia', token: 'new-capability' })
  pending.resolve(clone(f.project))
  const done = await finished(f.controller, job)
  assert.equal(done.state, 'failed')
  assert.match(done.error, /保存位置已变化/)
  assert.equal(f.calls.some(call => call.name === 'saveMcpProjectFile'), false)
  assert.equal(f.target.path, '/new.omedia')
  await f.controller.dispose()
})

test('failed save keeps dirty state and existing target', async () => {
  const f = fixture()
  f.setDirty(true)
  f.setTarget({ path: '/existing.omedia', token: 'existing-capability' })
  f.io.saveMcpProjectFile = async () => { throw new Error('无法写入当前工程') }
  const done = await finished(f.controller, await f.run('project_save'))
  assert.equal(done.state, 'failed')
  assert.equal(f.dirty, true)
  assert.equal(f.target.path, '/existing.omedia')
  assert.equal(f.calls.find(call => call.name === 'saveMcpProjectFile').args[1].overwrite, undefined)
  await f.controller.dispose()
})

test('multi-gigabyte project save passes project metadata to the archive bridge without a portable Blob', async () => {
  const project = createProject('大型录屏工程')
  project.assets = [{ ...video(), size: 8 * 1024 ** 3 }]
  const f = fixture(project)
  f.setTarget({ path: '/large.omedia', token: 'large-capability' })
  const done = await finished(f.controller, await f.run('project_save'))
  assert.equal(done.state, 'completed')
  const call = f.calls.find(call => call.name === 'saveMcpProjectFile')
  assert.equal(call.args[0].assets[0].size, 8 * 1024 ** 3)
  assert.equal(call.args[0].assets[0].nativePath, '/private/video.mp4')
  assert.equal(call.args[0] instanceof Uint8Array, false)
  assert.equal(call.args[0] instanceof Blob, false)
  await f.controller.dispose()
})

test('cancellation and stale revisions during asset preparation never begin the final project write', async () => {
  for (const mode of ['cancel', 'stale', 'reopen']) {
    const f = fixture(), pending = deferred()
    f.setDirty(true)
    f.setTarget({ path: '/existing.omedia', token: 'existing-capability' })
    f.io.prepareNativeProjectArchive = () => pending.promise
    const job = await f.run('project_save')
    await until(() => f.calls.some(call => call.name === 'prepareNativeProjectArchive'))
    if (mode === 'cancel') await f.run('job_cancel', { id: job.id })
    else if (mode === 'reopen') f.reopen()
    else f.externalChange()
    pending.resolve(cloneProject(f.project))
    const done = await finished(f.controller, job)
    assert.equal(done.state, mode === 'cancel' ? 'cancelled' : 'failed')
    assert.equal(f.calls.some(call => call.name === 'saveMcpProjectFile'), false)
    assert.equal(f.target.path, '/existing.omedia')
    assert.equal(f.dirty, true)
    await f.controller.dispose()
  }
})

test('material insertion uses current playhead, commits once and selects the inserted clip', async () => {
  const f = fixture()
  assert.equal((await f.run('material_list', { kind: 'watermark', search: '测试' })).total, 1)
  const job = await f.run('material_add', { kind: 'watermark', id: 'sample' })
  const done = await finished(f.controller, job)
  assert.equal(done.state, 'completed')
  assert.equal(f.calls.find(call => call.name === 'prepareMcpMaterial').args[1].start, 2.5)
  assert.equal(findClip(f.project, done.result.clipId).clip.start, 2.5)
  assert.equal((await f.run('playback_get')).selectedClipId, done.result.clipId)
  assert.equal(f.commits.length, 1)
  await f.controller.dispose()
})

function transitionSoundFixture() {
  let project = createProject('转场音效 MCP')
  const source = video()
  project.assets.push(source)
  project.tracks.find(track => track.kind === 'video').clips = [0, 4, 8].map((start, index) => createClip(source, project, { id: `picture-${index}`, start, trimIn: start, trimOut: Math.min(start + 4, 10) }))
  project = addTransition(project, 4, 'fade')
  const f = fixture(project), transitionId = project.tracks.flatMap(track => track.clips).find(clip => clip.transition).id
  const bytes = readFileSync(new URL('../src/assets/transition-sounds/air-sweep.wav', import.meta.url)), blob = new Blob([bytes], { type: 'audio/wav' })
  const asset = { id: 'transition-sound-source', name: '风掠.wav', kind: 'audio', duration: 0.8, width: 0, height: 0, size: bytes.length, mime: blob.type, nativePath: '/private/transition-sound.wav', url: 'blob:transition-sound-preview' }
  const dependencies = {
    loadTransitionSounds: async () => [{ id: 'air-sweep', title: '风掠', description: '切点风声', duration: 0.8, anchor: 0.35, url: '/assets/air-sweep.wav', filename: 'air-sweep.wav' }],
    fetchBlob: async () => blob,
    native: { isDesktop: () => true, importBlobAsset: async imported => { assert.deepEqual(Buffer.from(imported), bytes); return { ...asset } } },
  }
  f.io.prepareMcpMaterial = (snapshot, args, options) => prepareRealMcpMaterial(snapshot, args, { ...dependencies, ...options })
  return { f, transitionId, dependencies, asset, bytes }
}

test('转场音效 MCP 实际执行选中转场或指定时间，持久化素材且共享片段编辑和撤销', async () => {
  for (const [target, expectedStart] of [[{}, 3.65], [{ time: 7.9 }, 7.65], [{ time: 7.9, explicitTransition: true }, 3.65]]) {
    const { f, transitionId, bytes } = transitionSoundFixture(), before = clone(f.project)
    await f.host.setPlayback({ selectedClipId: transitionId, time: 8 })
    const { explicitTransition, ...timing } = target
    const job = await f.run('material_add', { kind: 'transition_sound', id: 'air-sweep', ...timing, ...(explicitTransition ? { transitionClipId: transitionId } : {}), expectedProjectId: f.project.id, expectedRevision: f.revision })
    assert.equal(job.execution, 'asynchronous')
    const done = await finished(f.controller, job)
    assert.equal(done.state, 'completed', done.error)
    const { clip, track } = findClip(f.project, done.result.clipId)
    assert.equal(clip.start, expectedStart); assert.equal(track.name, '转场音效')
    assert.equal(f.commits.length, 1); assert.equal(f.assets.length, 1)
    assert.equal(f.assets[0].libraryRole, 'transition-sound')
    assert.equal(f.assets[0].nativePath, '/private/transition-sound.wav')
    assert.deepEqual(Buffer.from(await f.host.getBlobs().get(f.assets[0].id).arrayBuffer()), bytes)
    assert.equal((await f.run('playback_get')).selectedClipId, clip.id)
    await f.run('project_history', { direction: 'undo' })
    assert.deepEqual(f.project, before)
    await f.run('project_history', { direction: 'redo' })
    assert.equal(findClip(f.project, clip.id).clip.start, expectedStart)
    await f.run('clip_update', { clipId: clip.id, patch: { volume: 0.4, fadeOut: 0.1 } })
    assert.equal(findClip(f.project, clip.id).clip.volume, 0.4)
    assert.equal(findClip(f.project, clip.id).clip.fadeOut, 0.1)
    await f.controller.dispose()
  }
  const { f } = transitionSoundFixture()
  await f.host.setPlayback({ time: 8, selectedClipId: '' })
  const done = await finished(f.controller, await f.run('material_add', { kind: 'transition_sound', id: 'air-sweep' }))
  assert.equal(done.state, 'completed', done.error)
  assert.equal(findClip(f.project, done.result.clipId).clip.start, 7.65)
  await f.controller.dispose()
})

test('转场音效 MCP 原生导入期间取消、修改或切换工程均不登记资产和历史', async () => {
  const previousRevoke = URL.revokeObjectURL, revoked = []
  URL.revokeObjectURL = url => revoked.push(url)
  try {
    for (const mode of ['cancel', 'revision', 'reopen', 'other']) {
      const { f, dependencies, asset } = transitionSoundFixture(), pending = deferred()
      let importing = false
      dependencies.native.importBlobAsset = () => { importing = true; return pending.promise }
      const job = await f.run('material_add', { kind: 'transition_sound', id: 'air-sweep', time: 4 })
      await until(() => importing)
      if (mode === 'cancel') await f.run('job_cancel', { id: job.id })
      else if (mode === 'revision') f.externalChange()
      else if (mode === 'reopen') f.reopen()
      else f.openOther()
      pending.resolve(asset)
      const done = await finished(f.controller, job)
      assert.equal(done.state, mode === 'cancel' ? 'cancelled' : 'failed')
      assert.equal(f.commits.length, 0); assert.equal(f.assets.length, 0)
      assert.equal(f.host.getBlobs().size, 0)
      assert.equal(f.project.assets.some(item => item.id === asset.id), false)
      await f.controller.dispose()
    }
    assert.deepEqual(revoked, Array(4).fill('blob:transition-sound-preview'))
  } finally { URL.revokeObjectURL = previousRevoke }
})

test('shared speech settings are used when generation omits voice, rate and alignment', async () => {
  let project = createProject('字幕配音')
  project = addClip(project, project.tracks[0].id, createSubtitleClip(project, { id: 'spoken-caption', text: '欢迎使用本地视频剪辑软件。' }))
  const f = fixture(project), notifications = []
  const unsubscribe = subscribeSpeechSettings(settings => notifications.push(settings))
  await f.run('speech_settings_set', { voiceId: voice.id, rate: 1.2, alignText: false })
  assert.equal(getSpeechSettings().rate, 1.2)
  assert.equal(notifications.at(-1).voiceId, voice.id)
  const job = await f.run('speech_generate', { clipIds: ['spoken-caption'] })
  const done = await finished(f.controller, job)
  assert.equal(done.state, 'completed', done.error)
  const request = f.calls.find(call => call.name === 'beginSpeechJob').args[0]
  assert.equal(request.voiceId, voice.id)
  assert.equal(request.speed, 1.2)
  assert.equal(findClip(f.project, 'spoken-caption').clip.trimOut, 5)
  assert.equal(f.project.tracks.flatMap(track => track.clips).filter(clip => clip.speech).length, 1)
  unsubscribe()
  updateSpeechSettings({ voiceId: '', rate: 1, alignText: true })
  await f.controller.dispose()
})

test('export uses project dimensions and forwards output overwrite policy without mutating the project', async () => {
  const f = fixture(createProject('导出', { width: 641, height: 359, fps: 24 }))
  const done = await finished(f.controller, await f.run('export_start', { outputPath: '/result.mp4', format: 'mp4', quality: 'high', overwrite: true }))
  assert.equal(done.state, 'completed')
  const call = f.calls.find(call => call.name === 'beginMcpMediaJob')
  assert.deepEqual(call.args[0].config, { width: 642, height: 360, fps: 24, format: 'mp4', quality: 'high' })
  assert.equal(call.args[1], '/result.mp4')
  assert.equal(call.args[2], true)
  assert.equal(f.commits.length, 0)
  assert.equal(done.result.outputPath, '/result.mp4')
  assert.equal(done.result.backend, 'cpu')
  assert.equal(done.result.folderOpened, true)
  await f.run('job_get', { id: done.id })
  await f.run('job_list')
  f.controller.summaries()
  assert.deepEqual(f.calls.filter(call => call.name === 'revealMediaJobOutput').map(call => call.args), [['native-export']])
  await f.controller.dispose()
})

test('folder opening failure preserves a completed export and reports a separate warning', async () => {
  const f = fixture()
  f.io.revealMediaJobOutput = async () => { throw new Error('系统文件管理器不可用') }
  const done = await finished(f.controller, await f.run('export_start', { outputPath: '/result.mp4', format: 'mp4' }))
  assert.equal(done.state, 'completed')
  assert.equal(done.error, undefined)
  assert.equal(done.result.outputPath, '/result.mp4')
  assert.equal(done.result.folderOpened, false)
  assert.match(done.warning, /系统文件管理器不可用/)
  assert.match(f.announcements.at(-1), /导出视频已完成；无法自动打开导出文件夹/)
  assert.equal(f.calls.some(call => call.name === 'cancelMediaJob'), false)
  assert.equal(f.busy, false)
  await f.controller.dispose()
})

test('running exports wait for native completion before opening the folder once', async () => {
  const f = fixture(), polled = deferred()
  f.io.beginMcpMediaJob = async () => ({ id: 'polled-export', state: 'running', progress: .2 })
  f.io.getMediaJobs = async () => {
    polled.resolve()
    return [{ id: 'polled-export', state: 'completed', progress: 1, outputPath: '/finished.mp4' }]
  }
  const job = await f.run('export_start', { outputPath: '/finished.mp4', format: 'mp4' })
  await until(() => f.calls.some(call => call.name === 'beginMcpMediaJob'))
  assert.equal(f.calls.some(call => call.name === 'revealMediaJobOutput'), false)
  await polled.promise
  const done = await finished(f.controller, job)
  assert.equal(done.state, 'completed')
  assert.equal(done.result.folderOpened, true)
  assert.deepEqual(f.calls.filter(call => call.name === 'revealMediaJobOutput').map(call => call.args), [['polled-export']])
  await f.controller.dispose()
})

test('failed exports never open an output folder', async () => {
  const f = fixture()
  f.io.beginMcpMediaJob = async () => ({ id: 'native-failed', state: 'failed', error: '编码失败', outputPath: '/failed.mp4' })
  const done = await finished(f.controller, await f.run('export_start', { outputPath: '/failed.mp4', format: 'mp4' }))
  assert.equal(done.state, 'failed')
  assert.equal(f.calls.some(call => call.name === 'revealMediaJobOutput'), false)
  await f.controller.dispose()
})

test('cancelling export while native launch is pending cancels the late native job', async () => {
  const f = fixture(), pending = deferred()
  f.io.beginMcpMediaJob = () => pending.promise
  const job = await f.run('export_start', { outputPath: '/cancel.mp4', format: 'mp4' })
  await until(() => f.calls.some(call => call.name === 'beginMcpMediaJob'))
  await f.run('job_cancel', { id: job.id })
  pending.resolve({ id: 'late-native', state: 'completed', name: '导出', progress: 1, outputPath: '/cancel.mp4' })
  const done = await finished(f.controller, job)
  assert.equal(done.state, 'cancelled')
  assert.ok(f.calls.some(call => call.name === 'cancelMediaJob' && call.args[0] === 'late-native'))
  assert.equal(f.busy, false)
  assert.equal(f.calls.some(call => call.name === 'revealMediaJobOutput'), false)
  await f.controller.dispose()
})

test('native export cancellation is reported as cancellation rather than a failed export', async () => {
  const f = fixture()
  f.io.beginMcpMediaJob = async () => ({ id: 'native-cancelled', state: 'cancelled', name: '导出', progress: 0 })
  const done = await finished(f.controller, await f.run('export_start', { outputPath: '/cancelled.mp4', format: 'mp4' }))
  assert.equal(done.state, 'cancelled')
  assert.equal(f.busy, false)
  assert.equal(f.calls.some(call => call.name === 'revealMediaJobOutput'), false)
  await f.controller.dispose()
})

test('stale prepared materials are discarded and never registered in the current project', async () => {
  const f = fixture(), pending = deferred(), revoked = []
  const originalRevoke = URL.revokeObjectURL
  URL.revokeObjectURL = url => { revoked.push(url); originalRevoke.call(URL, url) }
  try {
    f.io.prepareMcpMaterial = () => pending.promise
    const job = await f.run('material_add', { kind: 'music', id: 'sample', start: 3 })
    await until(() => f.calls.some(call => call.name === 'prepareMcpMaterial'))
    f.externalChange()
    pending.resolve({ project: cloneProject(f.project), label: '素材', selection: { clipId: 'unused', trackId: f.project.tracks[0].id }, assets: [{ asset: { ...video('prepared'), url: 'blob:discard-material', sourceUrl: 'blob:discard-material-source' }, blob: new Blob(['x']) }] })
    const done = await finished(f.controller, job)
    assert.equal(done.state, 'failed')
    assert.equal(f.commits.length, 0)
    assert.equal(f.assets.length, 0)
    assert.deepEqual(revoked, ['blob:discard-material', 'blob:discard-material-source'])
    await f.controller.dispose()
  } finally { URL.revokeObjectURL = originalRevoke }
})

test('final file write cannot be cancelled after overwrite has begun', async () => {
  const f = fixture(), pending = deferred()
  f.io.saveMcpProjectFile = () => pending.promise
  f.setTarget({ path: '/writing.omedia', token: 'writing-capability' })
  const job = await f.run('project_save')
  await until(() => f.calls.some(call => call.name === 'saveMcpProjectFile'))
  assert.equal((await f.run('job_get', { id: job.id })).cancelable, false)
  await assert.rejects(f.run('job_cancel', { id: job.id }), /无法取消/)
  pending.resolve({ path: '/writing.omedia', token: 'final-capability' })
  const done = await finished(f.controller, job)
  assert.equal(done.state, 'completed')
  assert.equal(f.target.path, '/writing.omedia')
  await f.controller.dispose()
})

test('a completed write from a prior session does not replace the reopened project target or saved state', async () => {
  const f = fixture(), pending = deferred()
  f.setTarget({ path: '/original.omedia', token: 'original-capability' })
  f.io.saveMcpProjectFile = () => pending.promise
  const job = await f.run('project_save')
  await until(() => f.calls.some(call => call.name === 'saveMcpProjectFile'))
  f.reopen()
  f.setTarget({ path: '/reopened.omedia', token: 'reopened-capability' })
  f.setDirty(true)
  pending.resolve({ path: '/original.omedia', token: 'saved-original-capability' })
  const done = await finished(f.controller, job)
  assert.equal(done.state, 'completed')
  assert.equal(done.result.path, '/original.omedia')
  assert.equal(f.target.path, '/reopened.omedia')
  assert.equal(f.target.token, 'reopened-capability')
  assert.equal(f.dirty, true)
  await f.controller.dispose()
})

test('running speech remains exclusive even if the UI host does not preserve the busy flag', async () => {
  let project = createProject('共享操作锁')
  project = addClip(project, project.tracks[0].id, createSubtitleClip(project, { id: 'caption-locked', text: '测试字幕' }))
  const f = fixture(project), pending = deferred()
  f.io.beginSpeechJob = () => pending.promise
  const job = await f.run('speech_generate', { clipIds: ['caption-locked'] })
  await until(() => f.calls.some(call => call.name === 'beginSpeechJob'))
  f.setBusy(false)
  await assert.rejects(f.run('project_update', { patch: { title: '不应修改' } }), /正在处理/)
  await assert.rejects(f.run('asset_import', { paths: ['/blocked.mp4'] }), /正在处理/)
  await f.run('job_cancel', { id: job.id })
  pending.resolve({ id: f.calls.find(call => call.name === 'beginSpeechJob').args[0].requestId, state: 'cancelled', stage: '取消' })
  const done = await finished(f.controller, job)
  assert.equal(done.state, 'cancelled')
  assert.equal(f.commits.length, 0)
  await f.controller.dispose()
})

test('running jobs expose linked busy errors, final results and truthful cancellation metadata', async () => {
  const { serializeMcpError } = await import('../src/core/mcp-response.ts')
  const f = fixture(), pending = deferred()
  f.io.importMcpMediaPaths = () => pending.promise
  const job = await f.run('asset_import', { paths: ['/slow.mp4'] })
  assert.equal(job.execution, 'asynchronous')
  assert.equal(job.final, false)
  assert.deepEqual(job.poll, { tool: 'open_media_job_get', arguments: { id: job.id } })
  await until(() => f.calls.some(call => call.name === 'importMcpMediaPaths'))
  let blocked
  try { await f.run('project_update', { patch: { title: '不应提交' } }) } catch (error) { blocked = serializeMcpError(error) }
  assert.equal(blocked.code, 'PROJECT_BUSY')
  assert.equal(blocked.blockingJob.jobId, job.id)
  assert.equal(blocked.blockingJob.kind, 'import')
  assert.equal(blocked.blockingJob.tool, 'open_media_asset_import')
  assert.equal(blocked.blockingJob.cancelable, true)
  const status = await f.controller.execute(blocked.blockingJob.poll.tool, blocked.blockingJob.poll.arguments)
  assert.equal(status.status, 'running')
  assert.equal(status.final, false)
  assert.equal((await f.run('project_get')).execution, 'synchronous')
  pending.resolve([video()])
  const done = await finished(f.controller, job)
  assert.equal(done.status, 'completed')
  assert.equal(done.final, true)
  assert.equal(done.cancel, null)
  assert.ok(done.result)
  assert.equal((await f.run('job_list'))[0].jobId, job.id)
  await f.controller.dispose()
})

test('native encoded frame and output time evidence survives final job polling', async () => {
  const f = fixture()
  f.io.beginMcpMediaJob = async () => ({ id: 'native-metrics', state: 'completed', progress: 1, name: '导出', stage: '编码', encodedFrames: 123, outputTime: 4.1, elapsedSeconds: 2, backend: 'cpu', outputPath: '/out.mp4' })
  const done = await finished(f.controller, await f.run('export_start', { outputPath: '/out.mp4', format: 'mp4' }))
  assert.equal(done.encodedFrames, 123)
  assert.equal(done.outputTime, 4.1)
  assert.ok(done.elapsedSeconds >= 0)
  assert.equal(done.result.elapsedSeconds, 2)
  await f.controller.dispose()
})

test('interface job summaries never clone accumulated frame payloads while protocol queries retain full results', async () => {
  const f = fixture(), base64 = 'AQID'.repeat(4096)
  f.io.preparePreviewTool = async () => ({ data: { artifactId: 'frame-preview', base64, width: 1280, height: 720, time: 1 } })
  const first = await finished(f.controller, await f.run('timeline_get_frame', { time: 1, width: 1280 }))
  const second = await finished(f.controller, await f.run('timeline_get_frame', { time: 2, width: 1280 }))
  assert.equal(first.result.base64, base64)
  let payloadCopies = 0
  const originalClone = globalThis.structuredClone
  globalThis.structuredClone = (value, ...args) => {
    if (value?.result?.base64) payloadCopies++
    return originalClone(value, ...args)
  }
  try {
    for (let update = 0; update < 4; update++) {
      const summaries = f.controller.summaries()
      assert.equal(summaries.length, 2)
      for (const job of summaries) {
        assert.equal(Object.hasOwn(job, 'result'), false)
        assert.equal(job.state, 'completed')
        assert.equal(job.cancelable, false)
        assert.equal(job.progress, 1)
        job.name = '外部修改'; job.poll.arguments.id = '不能覆盖任务'
      }
    }
    assert.equal(payloadCopies, 0, 'status refreshes must not traverse frame data')
    const fullList = await f.run('job_list')
    assert.equal(payloadCopies, 2)
    assert.ok(fullList.every(job => job.result.base64 === base64))
    const current = await f.run('job_get', { id: second.id })
    assert.equal(current.result.artifactId, 'frame-preview')
    assert.equal(current.result.base64, base64)
    assert.notEqual(current.name, '外部修改')
    assert.equal(current.poll.arguments.id, second.id)
    fullList[0].result.artifactId = '不能覆盖结果'
    assert.equal((await f.run('job_get', { id: fullList[0].id })).result.artifactId, 'frame-preview')
  } finally { globalThis.structuredClone = originalClone; await f.controller.dispose() }
})

for (const action of ['download', 'repair']) test(`model ${action} explicitly returns model polling links instead of a completed result or invented editor job`, async () => {
  const f = fixture()
  const download = await f.run('speech_model', { action, modelId: 'optional-model' })
  assert.equal(f.calls.at(-1).name, action === 'repair' ? 'repairSpeechModel' : 'beginSpeechModelDownload')
  assert.equal(download.responseType, 'model-status')
  assert.equal(download.execution, 'asynchronous')
  assert.equal(download.final, false)
  assert.equal(download.jobId, undefined)
  assert.deepEqual(download.poll, { tool: 'open_media_speech_model', arguments: { action: 'status', modelId: 'optional-model' } })
  const status = await f.controller.execute(download.poll.tool, download.poll.arguments)
  assert.equal(status.execution, 'synchronous')
  assert.equal(status.ready, true)
  await f.controller.execute(download.cancel.tool, download.cancel.arguments)
  assert.equal(f.calls.at(-1).name, 'cancelSpeechModelDownload')
  await f.controller.dispose()
})

// These checks exercise protocol/transactions with mocked native I/O, not inference quality.
const generation = (patch = {}) => ({ modelId: 'h3-base-fl2va', mode: 'prompt', prompt: '缓慢旋转的蓝色球体', ...patch })
test('video generation exposes safe final assets, optional timeline insertion and one undo transaction', async () => {
  const f = fixture()
  const original = clone(f.project)
  const result = await finished(f.controller, await f.run('video_generation_start', generation({ insert: { start: 3 } })))
  assert.equal(result.state, 'completed')
  assert.equal(result.tool, 'open_media_video_generation_start')
  assert.equal(result.result.assetIds.length, 1)
  assert.equal(result.result.clipIds.length, 1)
  assert.equal(findClip(f.project, result.result.clipIds[0]).clip.start, 3)
  assert.equal(f.commits.length, 1)
  assert.equal(f.assets.length, 1)
  assert.equal(JSON.stringify(result.result).includes('/private/'), false)
  const request = f.calls.find(call => call.name === 'beginVideoGeneration').args[0]
  assert.equal(request.width, 512)
  assert.equal(request.height, 512)
  assert.equal(request.shots[0].seconds, 1)
  assert.equal(request.lowMemory, true)
  assert.equal(request.steps, 20)
  assert.deepEqual((await f.run('job_get', { id: result.id })).result, result.result)
  await f.run('project_history', { direction: 'undo' })
  assert.deepEqual(f.project, original)
  await f.controller.dispose()
})

test('storyboard generates all shots before inserting sequential or combined clips', async () => {
  for (const mode of ['shots', 'combined']) {
    const f = fixture()
    const result = await finished(f.controller, await f.run('video_generation_start', {
      modelId: 'h3-base-fl2va', mode: 'storyboard', shots: [{ title: '开场', prompt: '蓝色球体', seconds: 2 }, { title: '结束', prompt: '金色光芒', seconds: 3 }],
      insert: { mode, trackId: f.project.tracks[1].id, start: 4 },
    }))
    assert.equal(result.state, 'completed')
    assert.equal(f.commits.length, 1)
    assert.equal(f.project.assets.length, 3)
    const clips = f.project.tracks[1].clips
    assert.deepEqual(clips.map(clip => clip.start), mode === 'shots' ? [4, 6] : [4])
    assert.deepEqual(clips.map(clip => clip.trimOut), mode === 'shots' ? [2, 3] : [5])
    await f.controller.dispose()
  }
})

test('generation input validates modes, dimensions, asset ownership and insertion before native work', async () => {
  const f = fixture()
  for (const args of [
    generation({ modelId: 'unreviewed-model' }), generation({ mode: 'image', firstFrameAssetId: 'missing' }),
    generation({ width: 513 }), generation({ width: 1344, height: 1344 }), generation({ seconds: 16 }),
    generation({ prompt: '' }), generation({ nativePath: '/tmp/forged.mp4' }),
    generation({ references: [{ assetId: 'missing', kind: 'image' }] }),
    generation({ shots: [{ prompt: '混用' }] }), generation({ insert: { trackId: f.project.tracks[0].id } }),
    { modelId: 'h3-base-fl2va', mode: 'storyboard', shots: Array.from({ length: 21 }, () => ({ prompt: '超量' })) },
    { modelId: 'h3-base-fl2va', mode: 'storyboard', shots: [{ prompt: '第一镜' }, { prompt: '第二镜' }], joinShots: false, insert: { mode: 'combined' } },
  ]) await assert.rejects(f.run('video_generation_start', args))
  assert.equal(f.calls.filter(call => call.name === 'beginVideoGeneration').length, 0)
  assert.equal(f.commits.length, 0)
  await f.controller.dispose()
})

test('image/reference modes resolve only existing project assets and preserve typed references', async () => {
  const initial = createProject('参考测试')
  initial.assets = [{ ...video('image'), kind: 'image', duration: 0, mime: 'image/png', name: '参考.png' }, video('video')]
  const f = fixture(initial)
  await finished(f.controller, await f.run('video_generation_start', generation({ mode: 'image', firstFrameAssetId: 'image' })))
  const imageRequest = f.calls.find(call => call.name === 'beginVideoGeneration').args[0]
  assert.equal(imageRequest.shots[0].firstFrame.id, 'image')
  const result = await finished(f.controller, await f.run('video_generation_start', { modelId: 'h3-base-ref2va', mode: 'reference', prompt: '保持参考画面的色彩', references: [{ assetId: 'video', kind: 'video', includeAudio: true }] }))
  assert.equal(result.state, 'completed')
  const referenceRequest = f.calls.filter(call => call.name === 'beginVideoGeneration').at(-1).args[0]
  assert.equal(referenceRequest.shots[0].references[0].asset.id, 'video')
  assert.equal(referenceRequest.shots[0].references[0].includeAudio, true)
  assert.equal(referenceRequest.shots[0].seconds, 2)
  await assert.rejects(f.run('video_generation_start', { modelId: 'h3-base-ref2va', mode: 'reference', prompt: '保持参考画面的色彩', seconds: 1, references: [{ assetId: 'video', kind: 'video', includeAudio: true }] }), /2 秒/)
  await assert.rejects(f.run('video_generation_start', generation({ mode: 'image', firstFrameAssetId: 'image', references: [{ assetId: 'video', kind: 'video' }] })), /参考素材/)
  await f.controller.dispose()
})

test('generation cancellation, native failures and stale revisions leave no partial project', async () => {
  for (const outcome of ['cancel', 'stale', 'failed', 'incomplete']) {
    const f = fixture(), pending = deferred(), original = clone(f.project)
    const actual = f.io.beginVideoGeneration
    f.io.beginVideoGeneration = () => pending.promise
    const job = await f.run('video_generation_start', generation())
    await until(() => f.calls.some(call => call.name === 'beginVideoGeneration'))
    assert.equal((await f.run('video_generation_status')).supported, true)
    assert.equal((await f.run('job_get', { id: job.id })).state, 'running')
    await assert.rejects(f.run('project_update', { patch: { title: 'blocked' } }), cause => cause.blockingJob?.jobId === job.id)
    if (outcome === 'cancel') await f.run('job_cancel', { id: job.id })
    if (outcome === 'stale') f.externalChange()
    const request = f.calls.find(call => call.name === 'beginVideoGeneration').args[0]
    const completed = await actual(request)
    pending.resolve(outcome === 'failed' ? { ...completed, state: 'failed', error: '生成设备不可用' } : outcome === 'incomplete' ? { ...completed, assets: [] } : completed)
    const result = await finished(f.controller, job)
    assert.equal(result.state, outcome === 'cancel' ? 'cancelled' : 'failed')
    assert.equal(f.commits.length, 0)
    assert.deepEqual(f.project.assets, original.assets)
    assert.deepEqual(f.project.tracks, original.tracks)
    assert.equal(f.assets.length, 0)
    assert.equal(f.busy, false)
    assert.ok(f.calls.some(call => call.name === 'cancelVideoGeneration'))
    await f.controller.dispose()
  }
})

test('unsupported platform and missing model fail without invoking inference or download', async () => {
  for (const unsupported of [true, false]) {
    const f = fixture()
    const nativeStatus = await f.io.getVideoGenerationStatus()
    f.io.getVideoGenerationStatus = async () => unsupported ? { ...nativeStatus, supported: false, reason: '当前平台不支持', runtimeReady: false } : { ...nativeStatus, models: nativeStatus.models.map(model => ({ ...model, state: 'not-downloaded' })) }
    const result = await finished(f.controller, await f.run('video_generation_start', generation()))
    assert.equal(result.state, 'failed')
    assert.match(result.error, unsupported ? /平台不支持/ : /先下载/)
    assert.equal(f.calls.some(call => call.name === 'beginVideoGeneration'), false)
    assert.equal(f.calls.some(call => call.name === 'beginVideoModelDownload'), false)
    await f.controller.dispose()
  }
})

test('model download requires explicit license consent and uses the shared cancellable job contract', async () => {
  const f = fixture()
  await assert.rejects(f.run('video_model_download', { modelId: 'h3-base-fl2va' }), /acceptedLicense/)
  await assert.rejects(f.run('video_model_download', { modelId: 'h3-base-fl2va', acceptedLicense: false }), /选项/)
  assert.equal(f.calls.some(call => call.name === 'beginVideoModelDownload'), false)
  const result = await finished(f.controller, await f.run('video_model_download', { modelId: 'h3-base-fl2va', acceptedLicense: true }))
  assert.equal(result.state, 'completed')
  assert.equal(result.result.modelId, 'h3-base-fl2va')
  assert.deepEqual(f.calls.find(call => call.name === 'beginVideoModelDownload').args, ['h3-base-fl2va', true])
  assert.equal(f.commits.length, 0)
  const pending = deferred()
  f.io.beginVideoModelDownload = () => pending.promise
  const job = await f.run('video_model_download', { modelId: 'h3-base-ref2va', acceptedLicense: true })
  await until(() => f.calls.filter(call => call.name === 'beginVideoModelDownload').length === 2)
  await f.run('job_cancel', { id: job.id })
  pending.resolve(await f.io.getVideoGenerationStatus())
  assert.equal((await finished(f.controller, job)).state, 'cancelled')
  assert.ok(f.calls.some(call => call.name === 'cancelVideoModelDownload' && call.args[0] === 'h3-base-ref2va'))
  await f.controller.dispose()
})

test('video polling forwards native stages and measured progress while model/project reads stay available', async () => {
  const f = fixture(), release = deferred()
  let nativeJob
  const complete = f.io.beginVideoGeneration
  f.io.beginVideoGeneration = async request => {
    nativeJob = await complete(request)
    return { ...nativeJob, state: 'running', stage: '正在采样 2/20', progress: .1, assets: [] }
  }
  f.io.getVideoGenerationJob = () => release.promise
  const job = await f.run('video_generation_start', generation())
  await until(() => f.controller.status(job.id).progress === .1)
  const status = await f.run('job_get', { id: job.id })
  assert.match(status.stage, /正在采样 2\/20/)
  assert.equal(status.progress, .1)
  assert.equal((await f.run('video_generation_status')).supported, true)
  assert.equal((await f.run('project_get')).revision, 7)
  assert.equal(f.commits.length, 0)
  await new Promise(resolve => setTimeout(resolve, 450))
  release.resolve({ ...nativeJob, warning: '生成时长已按模型帧数取整' })
  const result = await finished(f.controller, job)
  assert.equal(result.state, 'completed')
  assert.match(result.warning, /取整/)
  assert.equal(f.commits.length, 1)
  await f.controller.dispose()
})

test('model polling reports byte progress and unsupported platforms cannot start downloads', async () => {
  const f = fixture(), initialStatus = await f.io.getVideoGenerationStatus()
  const downloading = { ...initialStatus, runtimeReady: false, models: initialStatus.models.map(model => ({ ...model, state: 'downloading', downloadedBytes: 25 })) }
  f.io.beginVideoModelDownload = async () => downloading
  const job = await f.run('video_model_download', { modelId: 'h3-base-fl2va', acceptedLicense: true })
  await until(() => f.controller.status(job.id).progress === .25)
  assert.match(f.controller.status(job.id).stage, /正在下载/)
  assert.equal(f.commits.length, 0)
  await new Promise(resolve => setTimeout(resolve, 450))
  assert.equal((await finished(f.controller, job)).state, 'completed')
  f.io.getVideoGenerationStatus = async () => ({ ...initialStatus, supported: false, reason: '当前平台不支持' })
  const failed = await finished(f.controller, await f.run('video_model_download', { modelId: 'h3-base-ref2va', acceptedLicense: true }))
  assert.equal(failed.state, 'failed')
  assert.match(failed.error, /平台不支持/)
  assert.equal(f.calls.filter(call => call.name === 'beginVideoModelDownload').length, 1)
  await assert.rejects(f.run('video_generation_start', generation({ expectedRevision: 6 })), /版本已变化/)
  assert.equal(f.calls.some(call => call.name === 'beginVideoGeneration'), false)
  await f.controller.dispose()
})

// Unified AI native boundaries are fixtures; these test actual MCP transactions, not inference quality.
const aiImage = (patch = {}) => ({ modelId: 'qwen-image', prompt: '夜色中的城市', ...patch })
const aiMusic = (patch = {}) => ({ modelId: 'ace-step-1.5-turbo', prompt: '柔和钢琴与弦乐', ...patch })
for (const kind of ['image', 'music']) test(`${kind} generation has explicit destinations and inserts in one undo transaction`, async () => {
  for (const destination of ['generated', 'assets', 'timeline']) {
    const f = fixture(), original = clone(f.project)
    const options = { destination, expectedRevision: 7, ...(destination === 'timeline' ? { insert: { start: 4, ...(kind === 'image' ? { duration: 7 } : {}) } } : {}) }
    const result = await finished(f.controller, await f.run(`${kind}_generate`, (kind === 'image' ? aiImage : aiMusic)(options)))
    assert.equal(result.state, 'completed', result.error)
    assert.equal(result.result.destination, destination)
    assert.equal(f.commits.length, destination === 'generated' ? 0 : 1)
    assert.equal(f.assets.length, destination === 'generated' ? 0 : 1)
    assert.equal(result.result.assets[0].kind, kind === 'image' ? 'image' : 'audio')
    for (const privateValue of ['/private/', 'blob:', 'private.example', 'nativePath', 'sourceUrl']) assert.ok(!JSON.stringify(result.result).includes(privateValue))
    if (destination === 'generated') assert.deepEqual(f.project, original)
    if (destination === 'timeline') {
      assert.equal(result.result.clipIds.length, 1)
      const { clip, track } = findClip(f.project, result.result.clipIds[0])
      assert.equal(track.kind, kind === 'image' ? 'video' : 'audio')
      assert.equal(clip.start, 4)
      assert.equal(clip.trimOut, kind === 'image' ? 7 : 30)
    }
    if (destination !== 'generated') { await f.run('project_history', { direction: 'undo' }); assert.deepEqual(f.project, original) }
    await f.controller.dispose()
  }
})

test('AI generation resolves references only from project assets and rejects invalid combinations before starting native work', async () => {
  const project = createProject('AI 参考'), source = { ...video('source-image'), kind: 'image', duration: 0, mime: 'image/png' }
  project.assets = [source, video()]
  const f = fixture(project)
  for (const args of [aiImage({ modelId: 'unknown' }), aiImage({ mode: 'image-to-image' }), aiImage({ inputAssetId: 'missing' }), aiImage({ inputAssetId: 'source-video' }), aiImage({ nativePath: '/private/reference.png' }), aiImage({ mode: 'text-to-image', inputAssetId: source.id }), aiImage({ width: 513 }), aiImage({ strength: 0 }), aiImage({ modelId: 'z-image-turbo', negativePrompt: 'blur' }), aiImage({ insert: { start: 1 } }), aiImage({ destination: 'timeline', insert: { trackId: project.tracks[0].id } }), aiImage({ expectedRevision: 6 })]) await assert.rejects(f.run('image_generate', args))
  for (const args of [aiMusic({ instrumental: false }), aiMusic({ instrumental: true, lyrics: '测试歌词' }), aiMusic({ guidance: 5 }), aiMusic({ inputAssetId: source.id }), aiMusic({ seconds: 601 }), aiMusic({ negativePrompt: 'noise' })]) await assert.rejects(f.run('music_generate', args))
  assert.equal(f.calls.filter(call => call.name === 'beginAiGeneration').length, 0)
  const result = await finished(f.controller, await f.run('image_generate', aiImage({ inputAssetId: source.id, strength: .5 })))
  assert.equal(result.state, 'completed')
  const sent = f.calls.find(call => call.name === 'beginAiGeneration').args[0]
  assert.equal(sent.provider, 'image')
  assert.deepEqual(sent.request.inputAsset, source)
  sent.request.inputAsset.name = '不能改写原素材'
  assert.equal(f.project.assets[0].name, source.name)
  await f.controller.dispose()
})

test('global model downloads and repairs use the shared facade, require license consent and make no project edits', async () => {
  const f = fixture()
  for (const tool of ['ai_model_download', 'ai_model_repair']) {
    await assert.rejects(f.run(tool, { modelId: 'qwen-image' }), /acceptedLicense/)
    await assert.rejects(f.run(tool, { modelId: 'qwen-image', acceptedLicense: false }))
    for (const modelId of ['qwen-image', 'f5-v1-base-fp32', 'h3-base-fl2va']) {
      const result = await finished(f.controller, await f.run(tool, { modelId, acceptedLicense: true }))
      assert.equal(result.state, 'completed', result.error)
      assert.equal(result.result.modelId, modelId)
      assert.equal(result.poll.tool, 'open_media_job_get')
    }
  }
  assert.equal(f.calls.filter(call => call.name === 'downloadAiModel').length, 3)
  assert.equal(f.calls.filter(call => call.name === 'repairAiModel').length, 3)
  assert.equal(f.calls.filter(call => ['beginSpeechModelDownload', 'beginVideoModelDownload'].includes(call.name)).length, 0)
  assert.equal(f.commits.length, 0)
  await f.controller.dispose()
})

test('AI jobs retain global status access while busy and cancel or fail without partial project mutations', async () => {
  for (const outcome of ['cancel', 'stale', 'failed', 'incomplete']) {
    const f = fixture(), pending = deferred(), original = clone(f.project), complete = f.io.beginAiGeneration
    f.io.beginAiGeneration = () => pending.promise
    const job = await f.run('image_generate', aiImage({ destination: 'timeline' }))
    await until(() => f.calls.some(call => call.name === 'beginAiGeneration'))
    assert.ok((await f.run('ai_status')).models.length)
    await assert.rejects(f.run('project_update', { patch: { title: 'blocked' } }), cause => cause.blockingJob?.jobId === job.id && cause.blockingJob.cancel.tool === 'open_media_job_cancel')
    if (outcome === 'cancel') await f.run('job_cancel', { id: job.id })
    if (outcome === 'stale') f.externalChange()
    const request = f.calls.find(call => call.name === 'beginAiGeneration').args[0]
    const native = await complete(request)
    if (outcome === 'cancel') native.id = 'native-id-resolved-after-cancellation'
    pending.resolve(outcome === 'failed' ? { ...native, state: 'failed', error: 'fixture failure' } : outcome === 'incomplete' ? { ...native, assets: [] } : native)
    const result = await finished(f.controller, job)
    assert.equal(result.state, outcome === 'cancel' ? 'cancelled' : 'failed')
    assert.equal(f.commits.length, 0)
    assert.equal(f.assets.length, 0)
    assert.deepEqual(f.project.tracks, original.tracks)
    assert.ok(f.calls.some(call => call.name === 'cancelAiJob'))
    if (outcome === 'cancel') assert.ok(f.calls.some(call => call.name === 'cancelAiJob' && call.args[0] === 'native-id-resolved-after-cancellation'))
    await f.controller.dispose()
  }
})

for (const provider of ['image', 'music']) test(`${provider} cancellation before native registration waits for the actual job ID`, async () => {
  const f = fixture(), pending = deferred(), complete = f.io.beginAiGeneration
  let registeredId
  f.io.beginAiGeneration = () => pending.promise
  f.io.cancelAiJob = async id => {
    if (!registeredId || id !== registeredId) throw Error('AI 任务不存在。')
  }
  const args = provider === 'image' ? aiImage({ destination: 'timeline' }) : { modelId: 'ace-step-1.5-turbo', prompt: '轻快的钢琴纯音乐', instrumental: true, destination: 'timeline' }
  const job = await f.run(provider === 'image' ? 'image_generate' : 'music_generate', args)
  await until(() => f.calls.some(call => call.name === 'beginAiGeneration'))
  await assert.doesNotReject(f.run('job_cancel', { id: job.id }))
  assert.equal(f.calls.filter(call => call.name === 'cancelAiJob').length, 0)
  const request = f.calls.find(call => call.name === 'beginAiGeneration').args[0]
  const native = await complete(request)
  registeredId = `${provider}:${request.request.requestId}`
  pending.resolve({ ...native, id: registeredId })
  const result = await finished(f.controller, job)
  assert.equal(result.state, 'cancelled')
  assert.equal(f.commits.length, 0)
  assert.equal(f.assets.length, 0)
  const cancellations = f.calls.filter(call => call.name === 'cancelAiJob')
  assert.ok(cancellations.length > 0)
  assert.ok(cancellations.every(call => call.args[0] === registeredId))
  await f.controller.dispose()
})

test('global AI job queries redact native capabilities and can cancel a task created in the GUI', async () => {
  const f = fixture()
  const native = { ...(await f.io.beginAiGeneration({ provider: 'image', request: { requestId: 'gui-task', modelId: 'qwen-image' } })), state: 'running', cancelable: true, stage: '正在生成', progress: .5 }
  f.io.getAiJob = async () => clone(native)
  const oldStatus = f.io.getAiStatus
  f.io.getAiStatus = async () => ({ ...await oldStatus(), jobs: [native], busy: true })
  const status = await f.run('ai_status')
  assert.equal(status.jobs[0].progress, .5)
  assert.equal(status.jobs[0].poll.tool, 'open_media_ai_job_get')
  const result = await f.run('ai_job_get', { id: 'gui-task' })
  assert.equal(result.state, 'running')
  for (const privateValue of ['/private/', 'private.example', 'nativePath', 'sourceUrl']) assert.ok(!JSON.stringify(result).includes(privateValue))
  assert.equal((await f.run('ai_job_cancel', { id: 'gui-task' })).cancelRequested, true)
  assert.deepEqual(f.calls.find(call => call.name === 'cancelAiJob').args, ['gui-task'])
  assert.equal(f.commits.length, 0)
  await f.controller.dispose()
})

test('AI generation reports measured native progress and preserves model warnings', async () => {
  const f = fixture(), complete = f.io.beginAiGeneration, pending = deferred()
  let final
  f.io.beginAiGeneration = async request => { final = await complete(request); return { ...final, state: 'running', assets: [], stage: '采样 3/9', progress: 1 / 3, cancelable: true } }
  f.io.getAiJob = () => pending.promise
  const job = await f.run('image_generate', aiImage())
  await until(() => f.controller.status(job.id).progress === 1 / 3)
  assert.equal(f.controller.status(job.id).stage, '采样 3/9')
  assert.equal(f.commits.length, 0)
  await new Promise(resolve => setTimeout(resolve, 450))
  pending.resolve({ ...final, warning: '已回退 CPU' })
  const result = await finished(f.controller, job)
  assert.equal(result.state, 'completed')
  assert.equal(result.warning, '已回退 CPU')
  assert.equal(f.commits.length, 0)
  await f.controller.dispose()
})
