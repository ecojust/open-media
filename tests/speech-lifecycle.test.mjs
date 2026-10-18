import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as vue from 'vue'
import { createProject, createTextClip, validateProject } from '../src/core/project.ts'
import { addClip, clipDuration } from '../src/core/timeline.ts'
import { alignTextToSpeech, applySpeechResults, planSpeech, validateSpeechPlanCapacity } from '../src/core/speech.ts'
import { compactVoiceCatalog } from '../src/core/voice-catalog.ts'
import { voiceReady, voiceDownloading, voiceDownloadId, voiceRepairId, voiceRuntimeUpgrade } from '../src/core/voice-downloads.ts'
import { getSpeechSettings, subscribeSpeechSettings, updateSpeechSettings } from '../src/core/speech-settings.ts'

const mountedPanels = new Set()
let previousSettings, previousStorage
beforeEach(() => {
  previousSettings = getSpeechSettings()
  previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const stored = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, String(value)) },
    removeItem: key => { stored.delete(key) },
    clear: () => { stored.clear() },
  } })
  updateSpeechSettings({ voiceId: '', rate: 1, alignText: true })
})
afterEach(() => {
  for (const harness of mountedPanels) harness.dispose()
  updateSpeechSettings(previousSettings)
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
  else delete globalThis.localStorage
})

function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
function fixture() {
  let project = createProject('语音生命周期')
  const track = project.tracks.find(item => item.kind === 'text')
  project = addClip(project, track.id, createTextClip(project, { text: '第一段文字', start: 0, trimOut: 1 }))
  project = addClip(project, track.id, createTextClip(project, { text: '第二段文字', start: 4, trimOut: 1 }))
  return project
}
function complete(request, duration = 2.5) {
  return { id: request.requestId, state: 'completed', stage: '语音已生成', asset: { id: `asset-${request.requestId}`, name: '配音.wav', kind: 'audio', url: 'data:audio/wav;base64,', nativePath: `/assets/${request.requestId}.wav`, duration, width: 0, height: 0, mime: 'audio/wav', size: 24044 } }
}
function panel(overrides = {}, options = {}) {
  const source = readFileSync(new URL('../src/components/SpeechPanel.vue', import.meta.url), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const compiled = ts.transpileModule(`${source.replace(/^import .*$/gm, '')}\nreturn { generate, cancel, align, busy, error, notice, operationKind, generationLabel, voiceId, speed, alignText, previewUrl, previewVoice, previewVoiceId, previewState, player, status, loadStatus, changeModelDownload, pendingModels, downloadError }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const props = vue.shallowReactive({ project: fixture(), active: true, ...options })
  const events = [], calls = [], unmount = []
  const injections = {
    ref: vue.ref, computed: vue.computed, watch: vue.watch, nextTick: vue.nextTick,
    onBeforeUnmount: callback => unmount.push(callback), defineProps: () => props,
    defineEmits: () => (...event) => { events.push(event); if (event[0] === 'change' && options.applyChanges !== false) props.project = event[1] }, defineExpose: () => {},
    planSpeech, applySpeechResults, alignTextToSpeech, validateSpeechPlanCapacity, compactVoiceCatalog, voiceReady, voiceDownloading, voiceDownloadId, voiceRepairId, voiceRuntimeUpgrade, isDesktop: () => true,
    getSpeechSettings, subscribeSpeechSettings, updateSpeechSettings,
    bundledVoicePreviewUrl: () => undefined,
    VOICE_PREVIEW_TEXT: { zh: '欢迎使用 Open Media。你可以录制屏幕、剪辑视频、编辑图片，还能生成配音，让创作更轻松。', en: '欢迎使用 Open Media。你可以录制屏幕、剪辑视频、编辑图片，还能生成配音，让创作更轻松。' },
    getSpeechStatus: async () => ({ ready: true, voices: [{ id: 'voice-1', name: '声音一', language: 'zh-CN' }, { id: 'voice-2', name: '声音二', language: 'zh-CN' }] }),
    beginSpeechModelDownload: async modelId => { throw new Error(`unexpected model download ${modelId}`) },
    repairSpeechModel: async modelId => { throw new Error(`unexpected model repair ${modelId}`) },
    cancelSpeechModelDownload: async modelId => { throw new Error(`unexpected model cancellation ${modelId}`) },
    beginSpeechJob: async request => { calls.push(['begin', request]); return complete(request) },
    getSpeechJob: async id => { throw new Error(`unexpected poll ${id}`) },
    cancelSpeechJob: async id => { calls.push(['cancel', id]) },
    discardSpeechJob: async id => { calls.push(['discard', id]) },
    acceptSpeechJobs: async ids => { calls.push(['accept', ids]) },
    ...overrides,
  }
  const scope = vue.effectScope()
  const state = scope.run(() => new Function(...Object.keys(injections), compiled)(...Object.values(injections)))
  let disposed = false
  const harness = { state, props, events, calls, dispose() {
    if (disposed) return
    disposed = true
    unmount.forEach(callback => callback()); scope.stop(); mountedPanels.delete(harness)
  } }
  mountedPanels.add(harness)
  return harness
}
async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); await vue.nextTick() }

test('shared speech settings initialize the panel, synchronize both directions and persist without feedback loops', async () => {
  updateSpeechSettings({ voiceId: 'voice-2', rate: 1.3, alignText: false })
  const harness = panel({}, { active: false }), updates = []
  const unsubscribe = subscribeSpeechSettings(value => updates.push(value))
  try {
    assert.equal(harness.state.voiceId.value, 'voice-2')
    assert.equal(harness.state.speed.value, 1.3)
    assert.equal(harness.state.alignText.value, false)
    updateSpeechSettings({ voiceId: 'voice-1', rate: 0.75, alignText: true })
    await settle()
    assert.equal(updates.length, 1, 'a remote settings patch must not feed back from the three panel watchers')
    assert.equal(harness.state.voiceId.value, 'voice-1')
    assert.equal(harness.state.speed.value, 0.75)
    assert.equal(harness.state.alignText.value, true)
    harness.state.speed.value = 1.15
    assert.equal(updates.length, 2)
    assert.equal(getSpeechSettings().rate, 1.15)
    assert.deepEqual(JSON.parse(localStorage.getItem('open-media:speech-settings')), getSpeechSettings())
    harness.props.active = true
    await settle()
    assert.equal(harness.state.speed.value, 1.15, 'loading the catalog preserves configured speed')
    assert.equal(updates.length, 2)
  } finally { unsubscribe(); harness.dispose() }
})

test('unmounted panels release shared subscriptions while a reopened panel inherits current preferences', async () => {
  const first = panel({}, { active: false }), second = panel({}, { active: false })
  try {
    first.state.voiceId.value = 'voice-2'
    first.state.speed.value = 1.4
    first.state.alignText.value = false
    assert.equal(second.state.voiceId.value, 'voice-2')
    assert.equal(second.state.speed.value, 1.4)
    assert.equal(second.state.alignText.value, false)
    first.dispose()
    updateSpeechSettings({ voiceId: 'voice-1', rate: 0.8, alignText: true })
    await settle()
    assert.equal(first.state.voiceId.value, 'voice-2', 'a disposed subscription cannot update dead component state')
    assert.equal(first.state.speed.value, 1.4)
    assert.equal(second.state.voiceId.value, 'voice-1')
    assert.equal(second.state.speed.value, 0.8)
    first.state.speed.value = 1.9
    assert.equal(getSpeechSettings().rate, 0.8, 'disposed watchers cannot write shared preferences')
    const reopened = panel({}, { active: false })
    try {
      assert.equal(reopened.state.voiceId.value, 'voice-1')
      assert.equal(reopened.state.speed.value, 0.8)
      assert.equal(reopened.state.alignText.value, true)
    } finally { reopened.dispose() }
  } finally { first.dispose(); second.dispose() }
})

function downloadableCatalog(state = 'not-downloaded') {
  return { ready: true, voices: [
    { id: 'extra-zh', name: '低沉男声', language: 'zh-CN', gender: 'male', modelId: 'extra-model', modelSize: 176_000_000, downloadSize: 176_000_000, status: state },
    { id: 'voice-1', name: '内置女声', language: 'zh-CN', gender: 'female', status: 'bundled' },
    { id: 'extra-en', name: '英语女声', language: 'en-US', gender: 'female', modelId: 'extra-model', modelSize: 176_000_000, downloadSize: 176_000_000, status: state },
  ] }
}

test('uninstalled voices cannot be synthesized or dynamically previewed and never download implicitly', async () => {
  const harness = panel({ getSpeechStatus: async () => downloadableCatalog() })
  try {
    await settle()
    assert.equal(harness.state.voiceId.value, 'voice-1', 'defaults skip the uninstalled Chinese voice')
    await harness.state.previewVoice('extra-zh')
    assert.deepEqual(harness.calls, [])
    harness.state.voiceId.value = 'extra-zh'
    await harness.state.generate()
    assert.match(harness.state.error.value, /先下载/)
    assert.deepEqual(harness.calls, [])
    assert.equal(harness.props.project.assets.length, 0)
  } finally { harness.dispose() }
})

test('a fixed local audition remains available before its optional model is downloaded', async () => {
  const harness = panel({ getSpeechStatus: async () => downloadableCatalog(), bundledVoicePreviewUrl: id => `/local/${id}.mp3` })
  try {
    await settle()
    harness.state.player.value = audioPlayer()
    await harness.state.previewVoice('extra-zh')
    assert.equal(harness.state.previewUrl.value, '/local/extra-zh.mp3')
    assert.equal(harness.state.voiceId.value, 'voice-1')
    assert.deepEqual(harness.calls, [])
    assert.equal(harness.state.busy.value, false)
  } finally { harness.dispose() }
})

test('optional downloads do not lock editing, deduplicate start clicks and keep running when the dialog closes', async () => {
  const pending = deferred(), downloads = [], cancelled = []
  let catalog = downloadableCatalog()
  const harness = panel({ getSpeechStatus: async () => structuredClone(catalog),
    beginSpeechModelDownload: async id => { downloads.push(id); return pending.promise },
    cancelSpeechModelDownload: async id => { cancelled.push(id); return downloadableCatalog() },
  })
  try {
    await settle()
    const download = harness.state.changeModelDownload('extra-model')
    await harness.state.changeModelDownload('extra-model')
    assert.deepEqual(downloads, ['extra-model'])
    assert.equal(harness.state.busy.value, false)
    assert.deepEqual(harness.events.filter(event => event[0] === 'busy'), [])
    harness.props.active = false
    await settle()
    catalog = downloadableCatalog('downloading'); pending.resolve(structuredClone(catalog))
    await download
    assert.deepEqual(cancelled, [])
    assert.equal(harness.state.voiceId.value, 'voice-1')
    catalog = downloadableCatalog('ready')
    harness.props.active = true
    await settle()
    assert(harness.state.status.value.voices.every(voiceReady))
    assert.equal(harness.state.voiceId.value, 'voice-1', 'completed downloads must not replace the selected voice')
    harness.state.voiceId.value = 'extra-en'
    await harness.state.generate()
    assert(harness.calls.filter(call => call[0] === 'begin').every(call => call[1].voiceId === 'extra-en'))
  } finally { harness.dispose() }
})

test('model download cancellation, failed status and retry stay separate from speech generation', async () => {
  let catalog = downloadableCatalog('downloading'), cancellations = 0, starts = 0
  const harness = panel({ getSpeechStatus: async () => structuredClone(catalog),
    cancelSpeechModelDownload: async () => { cancellations++; catalog = downloadableCatalog(); return structuredClone(catalog) },
    beginSpeechModelDownload: async () => { starts++; catalog = downloadableCatalog('downloading'); return structuredClone(catalog) },
  })
  try {
    await settle()
    await harness.state.changeModelDownload('extra-model', true)
    assert.equal(cancellations, 1)
    assert.equal(harness.state.status.value.voices[0].status, 'not-downloaded')
    catalog = downloadableCatalog('failed'); catalog.voices[0].error = '连接中断'
    await harness.state.loadStatus(false)
    assert.equal(harness.state.status.value.voices[0].error, '连接中断')
    await harness.state.changeModelDownload('extra-model')
    assert.equal(starts, 1)
    assert.equal(harness.state.status.value.voices[0].status, 'downloading')
    assert.equal(harness.state.busy.value, false)
    assert.deepEqual(harness.events.filter(event => event[0] === 'change' || event[0] === 'busy'), [])
  } finally { harness.dispose() }
})

test('GPU upgrades keep CPU synthesis available and route shared download cancellation and retry correctly', async () => {
  let runtimeStatus = 'upgrade-available'
  const requests = []
  const current = () => ({ ready: true, voices: downloadableCatalog('ready').voices.map(voice => ({ ...voice, runtimeStatus, runtimeDownloadId: 'native-gpu-runtime' })) })
  const pending = deferred()
  const harness = panel({ getSpeechStatus: async () => current(),
    beginSpeechModelDownload: async id => { requests.push(['start', id]); await pending.promise; runtimeStatus = 'upgrade-downloading'; return current() },
    cancelSpeechModelDownload: async id => { requests.push(['cancel', id]); runtimeStatus = 'upgrade-available'; return current() },
  })
  try {
    await settle()
    harness.state.voiceId.value = 'extra-zh'
    const downloading = harness.state.changeModelDownload('native-gpu-runtime')
    await harness.state.changeModelDownload('native-gpu-runtime')
    assert.deepEqual(requests, [['start', 'native-gpu-runtime']])
    assert.deepEqual(harness.state.pendingModels.value, ['native-gpu-runtime'])
    assert(harness.state.status.value.voices.every(voiceReady))
    pending.resolve(); await downloading
    assert(harness.state.status.value.voices.every(voiceReady))
    assert(harness.state.status.value.voices.every(voiceDownloading))
    await harness.state.generate()
    assert(harness.calls.some(call => call[0] === 'begin'), 'CPU synthesis stays usable during GPU download')
    await harness.state.changeModelDownload('native-gpu-runtime', true)
    assert.deepEqual(requests[1], ['cancel', 'native-gpu-runtime'])
    assert(harness.state.status.value.voices.every(voiceReady))
    runtimeStatus = 'upgrade-failed'; await harness.state.loadStatus(false)
    await harness.state.changeModelDownload('native-gpu-runtime')
    assert.equal(requests.length, 3, 'failed GPU upgrades can be retried without redownloading the model')
    assert.equal(harness.state.voiceId.value, 'extra-zh')
  } finally { harness.dispose() }
})

test('repair addresses the installed model rather than its shared GPU download and deduplicates clicks', async () => {
  const gate = deferred(), repairs = []
  const catalog = downloadableCatalog('ready')
  for (const voice of catalog.voices) if (voice.modelId) Object.assign(voice, { runtimeStatus: 'upgrade-failed', runtimeDownloadId: 'native-gpu-runtime' })
  const harness = panel({ getSpeechStatus: async () => catalog,
    repairSpeechModel: async id => { repairs.push(id); return gate.promise },
  })
  try {
    await settle()
    const task = harness.state.changeModelDownload('extra-model', false, true)
    await harness.state.changeModelDownload('extra-model', false, true)
    await harness.state.changeModelDownload('native-gpu-runtime')
    assert.deepEqual(repairs, ['extra-model'])
    assert.deepEqual(harness.state.pendingModels.value, ['extra-model'])
    gate.resolve(catalog); await task
    assert(harness.state.status.value.voices.every(voiceReady))
    assert.deepEqual(harness.state.pendingModels.value, [])
    assert.equal(harness.state.downloadError.value, '')
  } finally { harness.dispose() }
})

test('a failed download start remains visible after the following catalog refresh', async () => {
  const harness = panel({ getSpeechStatus: async () => downloadableCatalog(), beginSpeechModelDownload: async () => { throw new Error('网络不可用') } })
  try {
    await settle()
    await harness.state.changeModelDownload('extra-model')
    assert.match(harness.state.downloadError.value, /无法开始下载：网络不可用/)
    assert.deepEqual(harness.state.pendingModels.value, [])
    assert.equal(harness.state.status.value.voices[0].status, 'not-downloaded')
    assert.equal(harness.state.voiceId.value, 'voice-1')
  } finally { harness.dispose() }
})

test('a stale catalog response cannot overwrite the result of a download action', async () => {
  let readCount = 0, catalog = downloadableCatalog()
  const oldRead = deferred()
  const harness = panel({ getSpeechStatus: async () => ++readCount === 2 ? oldRead.promise : structuredClone(catalog),
    beginSpeechModelDownload: async () => { catalog = downloadableCatalog('downloading'); return structuredClone(catalog) },
  })
  try {
    await settle()
    const refresh = harness.state.loadStatus(false)
    const start = harness.state.changeModelDownload('extra-model')
    await settle()
    oldRead.resolve(downloadableCatalog())
    await refresh; await start
    assert.equal(harness.state.status.value.voices[0].status, 'downloading')
    assert.equal(readCount, 3, 'action completion refreshes the authoritative catalog after the old request settles')
  } finally { harness.dispose() }
})

test('a read started while the download command is pending cannot restore its earlier state', async () => {
  const pendingStart = deferred(), pendingRead = deferred()
  let reads = 0, catalog = downloadableCatalog()
  const harness = panel({ getSpeechStatus: async () => ++reads === 2 ? pendingRead.promise : structuredClone(catalog),
    beginSpeechModelDownload: async () => pendingStart.promise,
  })
  try {
    await settle()
    const start = harness.state.changeModelDownload('extra-model')
    const refresh = harness.state.loadStatus(false)
    catalog = downloadableCatalog('downloading')
    pendingStart.resolve(structuredClone(catalog))
    await settle()
    pendingRead.resolve(downloadableCatalog())
    await refresh; await start
    assert.equal(harness.state.status.value.voices[0].status, 'downloading')
    assert.equal(reads, 3)
  } finally { harness.dispose() }
})

function audioPlayer() {
  return { paused: true, ended: false, playbackRate: 1, preservesPitch: false, currentTime: 0,
    async play() { this.paused = false }, pause() { this.paused = true }, removeAttribute() {}, load() {} }
}

test('bundled auditions play immediately without native jobs, preserve pitch and reuse files after switching or reopening', async () => {
  const harness = panel({ bundledVoicePreviewUrl: id => `/assets/${id}.mp3` })
  try {
    await settle()
    harness.state.player.value = audioPlayer()
    await harness.state.previewVoice('voice-1')
    assert.equal(harness.state.previewUrl.value, '/assets/voice-1.mp3')
    assert.equal(harness.state.player.value.paused, false)
    assert.equal(harness.state.player.value.preservesPitch, true)
    harness.state.player.value.currentTime = 2
    harness.state.speed.value = 1.25
    await settle()
    assert.equal(harness.state.player.value.playbackRate, 1.25)
    assert.equal(harness.state.player.value.currentTime, 2, 'rate changes must not seek or recreate the sample')
    await harness.state.previewVoice('voice-1')
    assert.equal(harness.state.player.value.paused, true)
    await harness.state.previewVoice('voice-1')
    assert.equal(harness.state.player.value.paused, false)
    assert.equal(harness.state.player.value.currentTime, 2)
    await harness.state.previewVoice('voice-2')
    assert.equal(harness.state.previewUrl.value, '/assets/voice-2.mp3')
    harness.props.active = false
    await settle()
    assert.equal(harness.state.previewUrl.value, '')
    assert.equal(harness.state.player.value.paused, true)
    harness.props.active = true
    await settle()
    await harness.state.previewVoice('voice-1')
    assert.equal(harness.state.previewUrl.value, '/assets/voice-1.mp3')
    assert.deepEqual(harness.calls, [], 'local auditions must not synthesize, poll, accept or discard jobs')
    assert.deepEqual(harness.events.filter(event => event[0] === 'change' || event[0] === 'busy'), [])
    assert.equal(harness.props.project.assets.length, 0)
  } finally { harness.dispose() }
})

test('a broken bundled sample reports an error and retries the same file without synthesizing a replacement', async () => {
  const harness = panel({ bundledVoicePreviewUrl: id => `/assets/${id}.mp3` })
  try {
    await settle()
    harness.state.player.value = { ...audioPlayer(), async play() { throw new Error('decode failed') } }
    await harness.state.previewVoice('voice-1')
    assert.match(harness.state.error.value, /内置试听音频无法播放.*重试/)
    assert.equal(harness.state.previewUrl.value, '')
    assert.equal(harness.state.previewState.value, 'idle')
    harness.state.player.value = audioPlayer()
    await harness.state.previewVoice('voice-1')
    assert.equal(harness.state.previewUrl.value, '/assets/voice-1.mp3')
    assert.equal(harness.state.error.value, '')
    assert.deepEqual(harness.calls, [])
  } finally { harness.dispose() }
})

test('closing during local playback startup invalidates late playback results', async () => {
  const pending = deferred(), started = deferred()
  const harness = panel({ bundledVoicePreviewUrl: id => `/assets/${id}.mp3` })
  try {
    await settle()
    harness.state.player.value = { ...audioPlayer(), play() { started.resolve(); return pending.promise } }
    const audition = harness.state.previewVoice('voice-1')
    await started.promise
    harness.props.active = false
    await settle()
    pending.resolve()
    await audition
    assert.equal(harness.state.previewUrl.value, '')
    assert.equal(harness.state.previewState.value, 'idle')
    assert.equal(harness.state.notice.value, '')
    assert.deepEqual(harness.calls, [])
  } finally { harness.dispose() }
})

test('Chinese narration is selected by default even when the bundled manifest lists English voices first', async () => {
  const harness = panel({ getSpeechStatus: async () => ({ ready: true, voices: [{ id: 'english-first', name: '英语声音', language: 'en-US' }, { id: 'chinese-default', name: '中文声音', language: 'zh-CN' }] }) })
  try {
    await settle()
    assert.equal(harness.state.voiceId.value, 'chinese-default')
    await harness.state.generate()
    assert(harness.calls.filter(call => call[0] === 'begin').every(call => call[1].voiceId === 'chinese-default'))
  } finally { harness.dispose() }
})

test('the first available voice remains usable when a runtime provides no Chinese voice', async () => {
  const harness = panel({ getSpeechStatus: async () => ({ ready: true, voices: [{ id: 'english-only', name: '英语声音', language: 'en-GB' }] }) })
  try { await settle(); assert.equal(harness.state.voiceId.value, 'english-only') } finally { harness.dispose() }
})

test('batch synthesis inserts real returned assets in one undoable project change and retains accepted files', async () => {
  const harness = panel()
  try {
    await harness.state.generate()
    const changes = harness.events.filter(event => event[0] === 'change')
    assert.equal(changes.length, 1)
    const project = changes[0][1]
    assert.equal(project.assets.length, 2)
    assert.equal(project.tracks.flatMap(track => track.clips).filter(clip => clip.speech).length, 2)
    assert.equal(clipDuration(project.tracks.find(track => track.kind === 'text').clips[0]), 2.5)
    assert.deepEqual(harness.events.filter(event => event[0] === 'busy').map(event => event[1]), [true, false])
    assert.equal(harness.calls.filter(call => call[0] === 'discard').length, 0)
    assert.match(harness.state.notice.value, /已添加 2 段语音/)
  } finally { harness.dispose() }
})

test('male voice selection reaches synthesis and survives the project document round trip', async () => {
  const catalog = JSON.parse(readFileSync(new URL('../src-tauri/resources/speech-models.json', import.meta.url), 'utf8'))
  const voices = catalog.models.flatMap(model => model.voices.map(voice => ({ ...voice, modelId: model.id, status: 'ready', runtimeStatus: 'ready' })))
  for (const voice of voices.filter(voice => voice.gender === 'male')) {
    const harness = panel({ getSpeechStatus: async () => ({ ready: true, voices }) })
    try {
      await settle()
      harness.state.voiceId.value = voice.id
      await harness.state.generate()
      const requests = harness.calls.filter(call => call[0] === 'begin')
      assert.equal(requests.length, 2)
      assert.ok(requests.every(call => call[1].voiceId === voice.id), 'male selection must not fall back to the female voice sharing its model')
      const restored = validateProject(JSON.parse(JSON.stringify(harness.props.project)))
      const audio = restored.tracks.flatMap(track => track.clips).filter(clip => clip.speech)
      assert.equal(audio.length, 2)
      assert.ok(audio.every(clip => clip.speech.voiceId === voice.id))
      assert.equal(harness.events.filter(event => event[0] === 'change').length, 1)
    } finally { harness.dispose() }
  }
})

test('batch failure discards earlier outputs and leaves the project unchanged', async () => {
  let count = 0
  const discarded = []
  const harness = panel({ beginSpeechJob: async request => ++count === 1 ? complete(request) : { id: request.requestId, state: 'failed', stage: '', error: '合成中断' }, discardSpeechJob: async id => discarded.push(id) })
  try {
    await harness.state.generate()
    assert.equal(harness.events.filter(event => event[0] === 'change').length, 0)
    assert.equal(discarded.length, 2)
    assert.equal(harness.state.error.value, '合成中断')
    assert.equal(harness.state.busy.value, false)
  } finally { harness.dispose() }
})

test('a rejected parent project commit discards unreferenced results instead of acknowledging them', async () => {
  const harness = panel({}, { applyChanges: false })
  try {
    await harness.state.generate()
    assert.equal(harness.props.project.assets.length, 0)
    assert.equal(harness.calls.filter(call => call[0] === 'accept').length, 0)
    assert.equal(harness.calls.filter(call => call[0] === 'discard').length, 2)
    assert.match(harness.state.error.value, /没有写入项目/)
  } finally { harness.dispose() }
})

test('acknowledgement failure never discards audio already referenced by the project and undo history', async () => {
  const harness = panel({ acceptSpeechJobs: async () => { throw new Error('记录暂不可用') } })
  try {
    await harness.state.generate()
    assert.equal(harness.props.project.assets.length, 2)
    assert.equal(harness.calls.filter(call => call[0] === 'discard').length, 0)
    assert.match(harness.state.notice.value, /音频已保留/)
    assert.equal(harness.state.busy.value, false)
  } finally { harness.dispose() }
})

test('cancellation before the native start returns prevents late results from entering the project', async () => {
  const pending = deferred(), started = deferred(), calls = []
  let request
  const harness = panel({ beginSpeechJob: value => { request = value; started.resolve(); return pending.promise }, cancelSpeechJob: async id => calls.push(['cancel', id]), discardSpeechJob: async id => calls.push(['discard', id]) })
  try {
    const generation = harness.state.generate()
    await started.promise
    assert.equal(harness.state.operationKind.value, 'all')
    assert.equal(harness.state.generationLabel.value, '正在生成…')
    await harness.state.cancel()
    assert.equal(harness.state.generationLabel.value, '正在取消…')
    assert.equal(calls[0][1], request.requestId)
    pending.resolve(complete(request))
    await generation
    assert.equal(harness.events.filter(event => event[0] === 'change').length, 0)
    assert(calls.some(call => call[0] === 'discard' && call[1] === request.requestId))
    assert.match(harness.state.notice.value, /取消/)
  } finally { harness.dispose() }
})

test('a project change during synthesis cancels the old job and never overwrites newer edits', async () => {
  const pending = deferred(), started = deferred()
  let request
  const harness = panel({ beginSpeechJob: value => { request = value; started.resolve(); return pending.promise } })
  try {
    const generation = harness.state.generate()
    await started.promise
    harness.props.project = { ...harness.props.project, title: '新的项目修改' }
    pending.resolve(complete(request))
    await generation
    assert.equal(harness.props.project.title, '新的项目修改')
    assert.equal(harness.events.filter(event => event[0] === 'change').length, 0)
    assert.match(harness.state.notice.value, /项目已经变化/)
  } finally { harness.dispose() }
})

test('unmount cancels a pending native request and cleans its late audio result', async () => {
  const pending = deferred(), started = deferred()
  let request
  const harness = panel({ beginSpeechJob: value => { request = value; started.resolve(); return pending.promise } })
  const generation = harness.state.generate()
  await started.promise
  harness.dispose()
  pending.resolve(complete(request))
  await generation
  assert.equal(harness.events.filter(event => event[0] === 'change').length, 0)
  assert(harness.calls.some(call => call[0] === 'cancel'))
  assert(harness.calls.some(call => call[0] === 'discard'))
})

test('Chinese card preview uses fixed sample text without adding timeline clips and disposes audio when the voice changes', async () => {
  const harness = panel()
  try {
    await settle()
    await harness.state.previewVoice('voice-1')
    const request = harness.calls.find(call => call[0] === 'begin')[1]
    assert.equal(request.text, '欢迎使用 Open Media。你可以录制屏幕、剪辑视频、编辑图片，还能生成配音，让创作更轻松。')
    assert.equal(harness.state.operationKind.value, 'preview')
    assert.match(harness.state.previewUrl.value, /^data:audio/)
    assert.equal(harness.events.filter(event => event[0] === 'change').length, 0)
    assert.equal(harness.calls.filter(call => call[0] === 'discard').length, 0)
    harness.state.voiceId.value = 'voice-2'
    await settle()
    assert.equal(harness.state.previewUrl.value, '')
    assert.equal(harness.calls.filter(call => call[0] === 'discard').length, 1)
  } finally { harness.dispose() }
})

test('disabling alignment preserves text duration and forwards the chosen voice and speed', async () => {
  const harness = panel()
  try {
    await settle()
    harness.state.voiceId.value = 'voice-2'; harness.state.speed.value = 1.4; harness.state.alignText.value = false
    await harness.state.generate([harness.props.project.tracks.find(track => track.kind === 'text').clips[0].id])
    assert.equal(harness.state.operationKind.value, 'selected')
    const begin = harness.calls.find(call => call[0] === 'begin')[1]
    assert.equal(begin.voiceId, 'voice-2'); assert.equal(begin.speed, 1.4)
    const changed = harness.events.find(event => event[0] === 'change')[1]
    assert.equal(clipDuration(changed.tracks.find(track => track.kind === 'text').clips[0]), 1)
    assert.equal(changed.assets.length, 1)
  } finally { harness.dispose() }
})

test('card audition uses the requested voice and shared corpus without selecting it or changing the timeline', async () => {
  const harness = panel({ getSpeechStatus: async () => ({ ready: true, voices: [
    { id: 'chinese-selected', name: '中文女声', language: 'zh-CN', gender: 'female' },
    { id: 'english-audition', name: '英文女声', language: 'en-US', gender: 'female' },
  ] }) })
  try {
    await settle()
    harness.state.speed.value = 1.25
    await settle()
    await harness.state.previewVoice('english-audition')
    const request = harness.calls.find(call => call[0] === 'begin')[1]
    assert.equal(request.voiceId, 'english-audition')
    assert.equal(request.speed, 1.25)
    assert.equal(request.text, '欢迎使用 Open Media。你可以录制屏幕、剪辑视频、编辑图片，还能生成配音，让创作更轻松。')
    assert.equal(harness.state.voiceId.value, 'chinese-selected')
    assert.equal(harness.state.previewVoiceId.value, 'english-audition')
    assert.equal(harness.events.filter(event => event[0] === 'change').length, 0)
    harness.props.active = false
    await settle()
    assert.equal(harness.state.previewUrl.value, '')
    assert.equal(harness.state.previewVoiceId.value, '')
    assert.equal(harness.state.notice.value, '')
    assert(harness.calls.some(call => call[0] === 'discard' && call[1] === request.requestId))
  } finally { harness.dispose() }
})

test('cancelling a card audition cleans the late result and restores the picker without changing its selection', async () => {
  const pending = deferred(), started = deferred()
  let request
  const harness = panel({ beginSpeechJob: value => { request = value; started.resolve(); return pending.promise } })
  try {
    await settle()
    const audition = harness.state.previewVoice('voice-2')
    await started.promise
    assert.equal(harness.state.previewVoiceId.value, 'voice-2')
    assert.equal(harness.state.previewState.value, 'loading')
    await harness.state.cancel()
    pending.resolve(complete(request))
    await audition
    assert.equal(harness.state.busy.value, false)
    assert.equal(harness.state.previewState.value, 'idle')
    assert.equal(harness.state.previewVoiceId.value, '')
    assert.equal(harness.state.previewUrl.value, '')
    assert.equal(harness.state.voiceId.value, 'voice-1')
    assert.equal(harness.events.filter(event => event[0] === 'change').length, 0)
    assert(harness.calls.some(call => call[0] === 'discard' && call[1] === request.requestId))
  } finally { harness.dispose() }
})

test('a hidden speech panel performs no runtime lookup and the browser never starts native synthesis', async () => {
  let lookups = 0, starts = 0
  const hidden = panel({ getSpeechStatus: async () => { lookups++; return { ready: false, voices: [] } } }, { active: false })
  try { await settle(); assert.equal(lookups, 0) } finally { hidden.dispose() }
  const browser = panel({ isDesktop: () => false, beginSpeechJob: async () => { starts++; throw new Error('not available') } })
  try { await browser.state.generate(); assert.equal(starts, 0); assert.match(browser.state.error.value, /桌面端/) } finally { browser.dispose() }
})

test('explicit clip generation works while settings stay closed, loads defaults lazily and reuses current voice settings', async () => {
  let lookups = 0
  const harness = panel({ getSpeechStatus: async () => {
    lookups++
    return { ready: true, voices: [{ id: 'voice-1', name: '声音一', language: 'zh-CN' }, { id: 'voice-2', name: '声音二', language: 'zh-CN' }] }
  } }, { active: false })
  try {
    await settle()
    assert.equal(lookups, 0)
    const clipId = harness.props.project.tracks.find(track => track.kind === 'text').clips[0].id
    await harness.state.generate([clipId])
    assert.equal(harness.props.active, false)
    assert.equal(lookups, 1)
    assert.equal(harness.state.error.value, '')
    const first = harness.calls.find(call => call[0] === 'begin')[1]
    assert.equal(first.voiceId, 'voice-1')
    assert.equal(first.speed, 1)
    assert.equal(harness.props.project.assets.length, 1)
    harness.state.voiceId.value = 'voice-2'; harness.state.speed.value = 1.25
    await harness.state.generate([clipId])
    const latest = harness.calls.filter(call => call[0] === 'begin').at(-1)[1]
    assert.equal(latest.voiceId, 'voice-2')
    assert.equal(latest.speed, 1.25)
    assert.equal(lookups, 1, 'the hidden controller keeps its loaded catalog and user settings')
    assert.equal(harness.props.project.tracks.flatMap(track => track.clips).filter(clip => clip.speech?.textClipId === clipId).length, 1, 'regeneration replaces the linked clip')
    assert.match(harness.state.notice.value, /已添加 1 段语音/)
    harness.state.align([clipId])
    assert.equal(harness.state.error.value, '')
    assert.match(harness.state.notice.value, /文字起点和时长已对齐关联语音/)
    assert.equal(harness.props.active, false)
  } finally { harness.dispose() }
})
