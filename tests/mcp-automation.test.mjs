import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { createProject, createSubtitleClip, cloneProject } from '../src/core/project.ts'
import { addClip, commitHistory, createHistory, findClip, redoHistory, undoHistory } from '../src/core/timeline.ts'
import { getSpeechSettings, subscribeSpeechSettings, updateSpeechSettings } from '../src/core/speech-settings.ts'

// Replace only native/file/canvas I/O boundaries. The controller, project edits,
// revision checks, undo history, speech settings and speech scheduler are real.
const boundaryExports = {
  '../src/native.ts': ['acceptSpeechJobs', 'beginSpeechJob', 'beginSpeechModelDownload', 'cancelMediaJob', 'cancelSpeechJob', 'cancelSpeechModelDownload', 'discardSpeechJob', 'getMediaJobs', 'getSpeechJob', 'getSpeechStatus', 'repairSpeechModel'],
  '../src/native-mcp-files.ts': ['beginMcpMediaJob', 'importMcpMediaPaths', 'openMcpProjectFile', 'saveMcpProjectFile'],
  '../src/core/native-project.ts': ['prepareNativeProject'],
  '../src/core/project-file.ts': ['exportProjectFile', 'importProjectFile'],
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
  let history = createHistory(initialProject), revision = 7, busy = false, dirty = false, target
  let playback = { time: 2.5, playing: false, selectedClipId: '' }
  const calls = [], announcements = [], assets = [], commits = [], blobs = new Map()
  const io = {
    async getSpeechStatus() { return { ready: true, voices: [voice] } },
    async beginSpeechJob(request) { return { id: request.requestId, state: 'completed', progress: 1, stage: '完成', asset: { id: `speech-${request.requestId}`, name: '配音.wav', kind: 'audio', url: 'http://asset.localhost/voice.wav', nativePath: '/private/voice.wav', duration: 2, width: 0, height: 0, size: 10, mime: 'audio/wav' } } },
    async getSpeechJob() { throw new Error('unexpected speech polling') },
    async cancelSpeechJob() {}, async discardSpeechJob() {}, async acceptSpeechJobs() {},
    async beginSpeechModelDownload() { return { ready: true, voices: [voice] } }, async cancelSpeechModelDownload() { return { ready: true, voices: [voice] } }, async repairSpeechModel() { return { ready: true, voices: [voice] } },
    async beginMcpMediaJob(spec, outputPath) { return { id: 'native-export', state: 'completed', progress: 1, name: '导出', outputPath, backend: 'cpu', elapsedSeconds: 2 } },
    async getMediaJobs() { return [] }, async cancelMediaJob() {},
    async importMcpMediaPaths() { return [video()] },
    async openMcpProjectFile(path) { return { path, token: 'open-file-capability', bytes: [1, 2, 3] } },
    async saveMcpProjectFile(_bytes, options) { return { path: options.path || '/existing.omedia', token: 'saved-file-capability' } },
    async exportProjectFile(project, options) { options.onProgress?.(1, 1); return new Blob([JSON.stringify(project)]) },
    async importProjectFile() { return { project: createProject('已打开工程'), blobs: new Map(), revoke() {} } },
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
    getProject: () => history.present, getRevision: () => revision, isBusy: () => busy, isDirty: () => dirty,
    getBlobs: () => blobs, getSaveTarget: () => target,
    commit(project, label, expected) {
      if (expected.projectId !== history.present.id || expected.revision !== revision) return false
      commits.push({ project: clone(project), label, expected })
      history = commitHistory(history, project); revision++; dirty = true; return true
    },
    async adopt(project) { history = createHistory(project); revision++; dirty = false },
    async hydrate(imported) { return imported.project },
    async didSave(project, value) { target = value; if (project.updatedAt === history.present.updatedAt) dirty = false },
    async didOpen(value) { target = value; dirty = false },
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

test('new and open require explicit discard for dirty projects and switch the authoritative project on completion', async () => {
  const f = fixture()
  f.setDirty(true)
  const rejected = await finished(f.controller, await f.run('project_new', { title: '新工程' }))
  assert.equal(rejected.state, 'failed')
  assert.match(rejected.error, /未保存/)
  assert.equal(f.project.title, '当前工程')
  const created = await finished(f.controller, await f.run('project_new', { title: '新工程', width: 800, height: 600, discardUnsaved: true }))
  assert.equal(created.state, 'completed')
  assert.equal(f.project.title, '新工程')
  assert.equal(f.project.width, 800)
  const opened = await finished(f.controller, await f.run('project_open', { path: '/document.omedia' }))
  assert.equal(opened.state, 'completed')
  assert.equal(f.project.title, '已打开工程')
  assert.equal(f.target.path, '/document.omedia')
  assert.ok(!JSON.stringify(opened.result).includes('open-file-capability'))
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

test('cancelled and stale imports never overwrite the active project', async () => {
  for (const mode of ['cancel', 'stale']) {
    const f = fixture(), pending = deferred()
    f.io.importMcpMediaPaths = () => pending.promise
    const job = await f.run('asset_import', { paths: ['/slow.mp4'] })
    await until(() => f.calls.some(call => call.name === 'importMcpMediaPaths'))
    if (mode === 'cancel') await f.run('job_cancel', { id: job.id })
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

test('save reuses the existing target without another path, and explicit save-as preserves overwrite consent', async () => {
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
  const saved = await finished(f.controller, await f.run('project_save', { path: '/copy.omedia', overwrite: true }))
  assert.equal(saved.state, 'completed')
  const lastCall = f.calls.filter(call => call.name === 'saveMcpProjectFile').at(-1)
  assert.equal(lastCall.args[1].token, undefined)
  assert.equal(lastCall.args[1].path, '/copy.omedia')
  assert.equal(lastCall.args[1].overwrite, true)
  assert.equal(f.target.path, '/copy.omedia')
  await f.controller.dispose()
})

test('failed save keeps dirty state and existing target', async () => {
  const f = fixture()
  f.setDirty(true)
  f.setTarget({ path: '/existing.omedia', token: 'existing-capability' })
  f.io.saveMcpProjectFile = async () => { throw new Error('目标文件已存在，请明确允许覆盖') }
  const done = await finished(f.controller, await f.run('project_save', { path: '/copy.omedia' }))
  assert.equal(done.state, 'failed')
  assert.equal(f.dirty, true)
  assert.equal(f.target.path, '/existing.omedia')
  assert.equal(f.calls.find(call => call.name === 'saveMcpProjectFile').args[1].overwrite, undefined)
  await f.controller.dispose()
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
  await f.controller.dispose()
})

test('cancelling export while native launch is pending cancels the late native job', async () => {
  const f = fixture(), pending = deferred()
  f.io.beginMcpMediaJob = () => pending.promise
  const job = await f.run('export_start', { outputPath: '/cancel.mp4', format: 'mp4' })
  await until(() => f.calls.some(call => call.name === 'beginMcpMediaJob'))
  await f.run('job_cancel', { id: job.id })
  pending.resolve({ id: 'late-native', state: 'running', name: '导出', progress: .1 })
  const done = await finished(f.controller, job)
  assert.equal(done.state, 'cancelled')
  assert.ok(f.calls.some(call => call.name === 'cancelMediaJob' && call.args[0] === 'late-native'))
  assert.equal(f.busy, false)
  await f.controller.dispose()
})

test('native export cancellation is reported as cancellation rather than a failed export', async () => {
  const f = fixture()
  f.io.beginMcpMediaJob = async () => ({ id: 'native-cancelled', state: 'cancelled', name: '导出', progress: 0 })
  const done = await finished(f.controller, await f.run('export_start', { outputPath: '/cancelled.mp4', format: 'mp4' }))
  assert.equal(done.state, 'cancelled')
  assert.equal(f.busy, false)
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
  const job = await f.run('project_save', { path: '/writing.omedia' })
  await until(() => f.calls.some(call => call.name === 'saveMcpProjectFile'))
  assert.equal((await f.run('job_get', { id: job.id })).cancelable, false)
  await assert.rejects(f.run('job_cancel', { id: job.id }), /无法取消/)
  pending.resolve({ path: '/writing.omedia', token: 'final-capability' })
  const done = await finished(f.controller, job)
  assert.equal(done.state, 'completed')
  assert.equal(f.target.path, '/writing.omedia')
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
  await assert.rejects(f.run('project_new', { title: '不应切换' }), /正在处理/)
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
