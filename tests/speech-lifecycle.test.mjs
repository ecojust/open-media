import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as vue from 'vue'
import { createProject, createTextClip } from '../src/core/project.ts'
import { addClip, clipDuration } from '../src/core/timeline.ts'
import { alignTextToSpeech, applySpeechResults, planSpeech, validateSpeechPlanCapacity } from '../src/core/speech.ts'
import { compactVoiceCatalog } from '../src/core/voice-catalog.ts'

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
  const compiled = ts.transpileModule(`${source.replace(/^import .*$/gm, '')}\nreturn { generate, cancel, align, busy, error, notice, operationKind, generationLabel, voiceId, speed, alignText, previewUrl, previewVoice, previewVoiceId, previewState, player }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const props = vue.shallowReactive({ project: fixture(), selectedClipId: '', active: true, ...options })
  const events = [], calls = [], unmount = []
  const injections = {
    ref: vue.ref, computed: vue.computed, watch: vue.watch, nextTick: vue.nextTick,
    onBeforeUnmount: callback => unmount.push(callback), defineProps: () => props,
    defineEmits: () => (...event) => { events.push(event); if (event[0] === 'change' && options.applyChanges !== false) props.project = event[1] }, defineExpose: () => {},
    planSpeech, applySpeechResults, alignTextToSpeech, validateSpeechPlanCapacity, compactVoiceCatalog, isDesktop: () => true,
    bundledVoicePreviewUrl: () => undefined,
    VOICE_PREVIEW_TEXT: { zh: '你好，这是一段语音试听。让文字拥有清晰自然的声音。', en: 'Hello, this is a voice preview. Let your story come to life with a clear and natural voice.' },
    getSpeechStatus: async () => ({ ready: true, voices: [{ id: 'voice-1', name: '声音一', language: 'zh-CN' }, { id: 'voice-2', name: '声音二', language: 'zh-CN' }] }),
    beginSpeechJob: async request => { calls.push(['begin', request]); return complete(request) },
    getSpeechJob: async id => { throw new Error(`unexpected poll ${id}`) },
    cancelSpeechJob: async id => { calls.push(['cancel', id]) },
    discardSpeechJob: async id => { calls.push(['discard', id]) },
    acceptSpeechJobs: async ids => { calls.push(['accept', ids]) },
    ...overrides,
  }
  const scope = vue.effectScope()
  const state = scope.run(() => new Function(...Object.keys(injections), compiled)(...Object.values(injections)))
  return { state, props, events, calls, dispose() { unmount.forEach(callback => callback()); scope.stop() } }
}
async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); await vue.nextTick() }

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
    assert.equal(request.text, '你好，这是一段语音试听。让文字拥有清晰自然的声音。')
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

test('card audition uses the requested voice and language without selecting it or changing the timeline', async () => {
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
    assert.equal(request.text, 'Hello, this is a voice preview. Let your story come to life with a clear and natural voice.')
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
