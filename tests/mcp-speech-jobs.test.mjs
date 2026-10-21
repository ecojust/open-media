import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject, createTextClip } from '../src/core/project.ts'
import { createMcpSpeechJobs } from '../src/core/mcp-speech-jobs.ts'
import { getSpeechSettings, subscribeSpeechSettings, updateSpeechSettings, validateSpeechSettings } from '../src/core/speech-settings.ts'

const voice = { id: 'matcha_zh_en_female', name: '内置配音', language: 'zh', gender: 'female', status: 'bundled' }

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture(overrides = {}) {
  let project = createProject('远程配音测试'), revision = 1, projectSession = 1, busy = false
  project.tracks[0].clips.push(createTextClip(project, { id: 'first', text: '第一段字幕。', start: 1, trimOut: 3 }))
  project.tracks[0].clips.push(createTextClip(project, { id: 'second', text: '第二段字幕。', start: 6, trimOut: 3 }))
  const original = structuredClone(project)
  const calls = { begin: [], cancel: [], discard: [], accept: [], commits: [], assets: [], events: [] }
  function completed(request) {
    return { id: request.requestId, state: 'completed', stage: '完成', asset: { id: `audio-${request.requestId}`, name: '配音.wav', kind: 'audio', duration: 2, width: 0, height: 0, size: 8000, mime: 'audio/wav', nativePath: `/tmp/open-media/${request.requestId}.wav`, url: `asset://localhost/${request.requestId}.wav` } }
  }
  const native = {
    getSpeechStatus: async () => ({ ready: true, voices: [voice] }),
    beginSpeechJob: async request => { calls.begin.push(request); return overrides.begin ? overrides.begin(request, calls, completed) : completed(request) },
    getSpeechJob: async id => { if (overrides.get) return overrides.get(id); throw new Error('Unexpected poll') },
    cancelSpeechJob: async id => { calls.cancel.push(id) },
    discardSpeechJob: async id => { calls.discard.push(id) },
    acceptSpeechJobs: async ids => { calls.accept.push(ids); if (overrides.failAccept) throw new Error('接受结果暂时失败') },
    ...overrides.native,
  }
  const service = createMcpSpeechJobs({
    getProject: () => project,
    getRevision: () => revision,
    getProjectSession: () => projectSession,
    isBusy: () => busy,
    onBusy: value => { busy = value },
    onAssets: assets => calls.assets.push(...assets),
    prepareProject: overrides.prepareProject,
    onChange: job => calls.events.push(job),
    commit: (next, label, expected) => {
      if (expected.projectId !== project.id || expected.revision !== revision || expected.projectSession !== projectSession || overrides.rejectCommit) return false
      calls.commits.push({ next, label, expected })
      project = next; revision++
      return true
    },
    native,
    pollIntervalMs: 1,
  })
  return { service, calls, original, completed, get project() { return project }, get busy() { return busy }, edit() { project = structuredClone(project); project.title = '用户最新修改'; revision++ }, reopen() { project = structuredClone(project); projectSession++ } }
}

async function finish(service, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = service.status(id)
    if (current.state !== 'running' && current.finishedAt) return current
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('Task did not finish')
}

test('设置使用同一数据源，严格校验并向订阅方提供副本', () => {
  updateSpeechSettings({ voiceId: '', rate: 1, alignText: true })
  let notified
  const stop = subscribeSpeechSettings(settings => { notified = settings; settings.voiceId = '不能修改内部状态' })
  updateSpeechSettings({ voiceId: voice.id, rate: 1.2, alignText: false })
  assert.equal(notified.rate, 1.2)
  assert.equal(getSpeechSettings().voiceId, voice.id)
  assert.deepEqual(validateSpeechSettings({ rate: 0.5 }), { voiceId: '', rate: 0.5, alignText: true })
  for (const patch of [{ rate: NaN }, { rate: 4 }, { alignText: 'false' }, { voiceId: 2 }, { extra: true }]) assert.throws(() => updateSpeechSettings(patch))
  stop()
  updateSpeechSettings({ voiceId: '', rate: 1, alignText: true })
})

test('立即返回任务编号，完整批次一次写入原生素材并接收全部结果', async () => {
  const f = fixture()
  const job = f.service.startSpeech({ rate: 1.15, alignText: false })
  assert.equal(job.state, 'running')
  assert.equal(job.total, 2)
  assert.equal(f.calls.commits.length, 0)
  assert.equal(f.busy, true)
  assert.throws(() => f.service.startSpeech(), /其他操作/)
  const done = await finish(f.service, job.id)
  assert.equal(done.state, 'completed')
  assert.equal(done.progress, 1)
  assert.equal(done.completed, 2)
  assert.equal(done.cancelable, false)
  assert.equal(f.busy, false)
  assert.equal(f.calls.commits.length, 1)
  assert.equal(f.calls.assets.length, 2)
  assert.equal(f.calls.accept.length, 1)
  assert.equal(f.calls.accept[0].length, 2)
  assert.equal(f.calls.discard.length, 0)
  assert.equal(f.calls.begin[0].speed, 1.15)
  assert.equal(f.calls.begin[0].text, '第一段字幕。')
  assert.equal(f.project.tracks[0].clips[0].trimOut, 3)
  assert.ok(f.project.assets.every(asset => asset.nativePath && !asset.url.startsWith('blob:')))
  assert.ok(f.calls.events.filter(event => event.state === 'running').every(event => event.progress === undefined || event.progress < 1))
  const external = f.service.status(job.id)
  external.result.assetIds.length = 0
  assert.equal(f.service.status(job.id).result.assetIds.length, 2)
  const summary = f.service.summaries()[0]
  assert.equal(summary.id, job.id)
  assert.equal(summary.completed, 2)
  assert.equal(summary.state, 'completed')
  assert.equal(Object.hasOwn(summary, 'result'), false)
  assert.equal(f.service.list()[0].result.assetIds.length, 2)
  await f.service.dispose()
})

test('第二段失败会丢弃所有临时结果，保留完整原项目', async () => {
  const f = fixture({ begin: (request, calls, completed) => calls.begin.length === 1 ? completed(request) : { id: request.requestId, state: 'failed', stage: '失败', error: '模型生成失败' } })
  const done = await finish(f.service, f.service.startSpeech().id)
  assert.equal(done.state, 'failed')
  assert.match(done.error, /模型生成失败/)
  assert.equal(f.calls.commits.length, 0)
  assert.equal(f.calls.discard.length, 2)
  assert.equal(f.calls.accept.length, 0)
  assert.deepEqual(f.project, f.original)
  assert.equal(f.busy, false)
})

test('整批配音先归档到当前工程，注册归档后的素材并保留生成元数据', async () => {
  let prepared
  const f = fixture({ prepareProject: async (project, options) => {
    options.assertCurrent()
    assert.equal(options.signal.aborted, false)
    assert.equal(f.calls.commits.length, 0)
    assert.equal(f.calls.accept.length, 0)
    prepared = structuredClone(project)
    return { ...project, assets: project.assets.map(asset => ({ ...asset, nativePath: `/projects/${project.id}/assets/${asset.id}.wav`, url: `asset://localhost/projects/${project.id}/assets/${asset.id}.wav` })) }
  } })
  const done = await finish(f.service, f.service.startSpeech().id)
  assert.equal(done.state, 'completed', done.error)
  assert.equal(f.calls.commits.length, 1)
  for (const asset of f.calls.assets) {
    assert.equal(asset.nativePath, `/projects/${f.project.id}/assets/${asset.id}.wav`)
    assert.deepEqual(asset, f.project.assets.find(item => item.id === asset.id))
    assert.equal(asset.duration, prepared.assets.find(item => item.id === asset.id).duration)
    assert.ok(prepared.assets.find(item => item.id === asset.id).nativePath.startsWith('/tmp/'))
  }
  assert.equal(f.calls.accept.length, 1)
  assert.equal(f.calls.discard.length, 0)
  await f.service.dispose()
})

test('配音归档期间取消或重新打开同一工程不会写回过期结果，仅清理临时原件', async () => {
  for (const action of ['cancel', 'edit', 'reopen', 'copy-failed']) {
    const pending = deferred()
    let prepared, options
    const f = fixture({ prepareProject: (project, context) => { prepared = project; options = context; return pending.promise } })
    const job = f.service.startSpeech()
    for (let index = 0; !prepared && index < 100; index++) await new Promise(resolve => setTimeout(resolve, 1))
    assert.ok(prepared)
    assert.equal(f.service.status(job.id).cancelable, true)
    assert.equal(f.calls.begin.length, 2)
    if (action === 'cancel') await f.service.cancel(job.id)
    else if (action !== 'copy-failed') f[action]()
    if (action !== 'copy-failed') assert.throws(options.assertCurrent)
    // A failed native copy can leave a reusable, unreferenced project copy;
    // discardSpeechJob still receives only the original generation job IDs.
    pending.resolve(action === 'copy-failed' ? { ...prepared, id: 'other-project' } : prepared)
    const done = await finish(f.service, job.id)
    assert.equal(done.state, action === 'cancel' ? 'cancelled' : 'failed')
    assert.equal(f.calls.commits.length, 0)
    assert.equal(f.calls.assets.length, 0)
    assert.equal(f.calls.accept.length, 0)
    assert.deepEqual(f.calls.discard.sort(), f.calls.begin.map(request => request.requestId).sort())
    assert.equal(f.busy, false)
    await f.service.dispose()
  }
})

test('生成期间项目被修改时，不覆盖最新项目且清理尚未提交音频', async () => {
  const pending = deferred(), f = fixture({ begin: () => pending.promise })
  const job = f.service.startSpeech()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(f.calls.begin.length, 1)
  f.edit()
  pending.resolve(f.completed(f.calls.begin[0]))
  const done = await finish(f.service, job.id)
  assert.equal(done.state, 'failed')
  assert.match(done.error, /项目已经变化/)
  assert.equal(f.project.title, '用户最新修改')
  assert.equal(f.calls.commits.length, 0)
  assert.equal(f.calls.discard.length, 1)
})

test('重新打开同一工程且版本相同，也不会接受旧会话的配音结果', async () => {
  const pending = deferred(), f = fixture({ begin: () => pending.promise })
  const job = f.service.startSpeech()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(f.calls.begin.length, 1)
  f.reopen()
  assert.equal(f.project.id, job.projectId)
  pending.resolve(f.completed(f.calls.begin[0]))
  const done = await finish(f.service, job.id)
  assert.equal(done.state, 'failed')
  assert.match(done.error, /项目已经变化/)
  assert.equal(f.calls.commits.length, 0)
  assert.equal(f.calls.assets.length, 0)
  assert.equal(f.calls.discard.length, 1)
  assert.equal(f.calls.accept.length, 0)
  assert.deepEqual(f.project, f.original)
  await f.service.dispose()
})

test('取消等待中的原生任务，立即显示取消中并在清理后解除忙碌', async () => {
  const pending = deferred(), f = fixture({ begin: () => pending.promise })
  const job = f.service.startSpeech()
  await new Promise(resolve => setTimeout(resolve, 0))
  const cancelling = await f.service.cancel(job.id)
  assert.equal(cancelling.cancelling, true)
  assert.equal(cancelling.cancelable, false)
  assert.equal(f.busy, true)
  pending.resolve(f.completed(f.calls.begin[0]))
  const done = await finish(f.service, job.id)
  assert.equal(done.state, 'cancelled')
  assert.equal(f.busy, false)
  assert.equal(f.calls.cancel.length > 0, true)
  assert.equal(f.calls.discard.length, 1)
  assert.equal(f.calls.commits.length, 0)
})

test('任务完成记录接受失败不删除已写入项目的音频', async () => {
  const f = fixture({ failAccept: true })
  const done = await finish(f.service, f.service.startSpeech({ clipIds: ['first'] }).id)
  assert.equal(done.state, 'completed')
  assert.match(done.warning, /音频已保留/)
  assert.equal(f.calls.discard.length, 0)
  assert.equal(f.project.assets.length, 1)
})

test('选择无效字幕、锁定字幕及不可用声音不能被静默替代', async () => {
  const f = fixture()
  assert.throws(() => f.service.startSpeech({ clipIds: ['first', 'missing'] }), /部分指定字幕无法生成/)
  assert.throws(() => f.service.startSpeech({ clipIds: [] }), /添加字幕/)
  assert.throws(() => f.service.startSpeech({ rate: 100 }), /语速/)
  assert.throws(() => f.service.startSpeech({ clipIds: [4] }), /字符串数组/)
  assert.equal(f.busy, false)
  const done = await finish(f.service, f.service.startSpeech({ voiceId: 'not-installed' }).id)
  assert.equal(done.state, 'failed')
  assert.match(done.error, /下载或修复/)
  assert.equal(f.calls.begin.length, 0)
})

test('返回的实际进度传入任务状态，提交拒绝保持原项目', async () => {
  const pending = deferred()
  const f = fixture({ rejectCommit: true, begin: request => ({ id: request.requestId, state: 'running', stage: '正在生成', progress: 0.4 }), get: () => pending.promise })
  const job = f.service.startSpeech({ clipIds: ['first'] })
  await new Promise(resolve => setTimeout(resolve, 3))
  assert.equal(f.service.status(job.id).progress, 0.4)
  pending.resolve(f.completed(f.calls.begin[0]))
  const done = await finish(f.service, job.id)
  assert.equal(done.state, 'failed')
  assert.match(done.error, /没有写入项目/)
  assert.equal(f.calls.discard.length, 1)
  assert.deepEqual(f.project, f.original)
})

test('释放服务取消运行任务，随后拒绝新任务', async () => {
  const pending = deferred(), f = fixture({ begin: () => pending.promise })
  const job = f.service.startSpeech()
  await new Promise(resolve => setTimeout(resolve, 0))
  const closed = f.service.dispose()
  pending.resolve(f.completed(f.calls.begin[0]))
  await closed
  assert.equal(f.service.status(job.id).state, 'cancelled')
  assert.equal(f.busy, false)
  assert.throws(() => f.service.startSpeech(), /已经关闭/)
})
