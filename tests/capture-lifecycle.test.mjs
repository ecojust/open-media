import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as vue from 'vue'
import { captureErrorMessage } from '../src/core/capture.ts'
import { recordingClock } from '../src/core/capture-controls.ts'
import { validateGifSegments, gifFrameCount } from '../src/core/gif.ts'
import { recentVideoAssets, videoDuration, videoImportedTime } from '../src/core/video-assets.ts'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const asset = { id: 'source', name: 'source.mp4', kind: 'video', url: 'blob:source', duration: 10, width: 320, height: 180, size: 1000, mime: 'video/mp4', nativePath: '/source.mp4' }
const captureDevices = [{ id: 'screen:1', name: '屏幕一', kind: 'screen', width: 2560, height: 1440 }, { id: 'screen:2', name: '屏幕二', kind: 'screen', width: 1920, height: 1080 }, { id: 'window:24', name: '演示窗口', kind: 'window', width: 1200, height: 900 }]

function workspace(name, overrides = {}) {
  const script = readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const exposed = name === 'RecorderWorkspace' ? 'phase, elapsed, error, countdown, begin, stop, pauseOrResume, toggleMicrophone, microphone, microphoneEnabled, microphonePending, muted, audioAvailable, controlBusy, selection, pickerPreferences, actualSource, browserPicker, chooseBrowserSource' : 'exporting, error, jobId, exportGif, cancel'
  const compiled = ts.transpileModule(`${script.replace(/^import .*$/gm, '')}\nreturn { ${exposed} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const mounted = [], unmounted = [], deactivated = [], timers = new Map(), events = []
  let actionListener, unlistened = 0
  let nextTimer = 1
  const injected = {
    ref: vue.ref, shallowRef: vue.shallowRef, computed: vue.computed, nextTick: vue.nextTick, watch: vue.watch,
    onMounted: callback => mounted.push(callback), onBeforeUnmount: callback => unmounted.push(callback), onDeactivated: callback => deactivated.push(callback),
    onCaptureControlsAction: async callback => { actionListener = callback; return () => { unlistened++; actionListener = undefined } },
    setCaptureMicrophone: async enabled => ({ state: 'recording', elapsed: 1, segments: 0, audioAvailable: enabled, muted: !enabled, microphoneEnabled: enabled }), recordingClock,
    defineProps: () => ({ assets: [asset], native: true }), withDefaults: (props, defaults) => ({ ...defaults, ...props }), defineEmits: () => (...args) => events.push(args), defineExpose: () => {},
    window: { addEventListener() {}, removeEventListener() {} },
    setInterval: callback => { const id = nextTimer++; timers.set(id, callback); return id }, clearInterval: id => timers.delete(id),
    listCaptureDevices: async () => captureDevices, pickCaptureSource: async () => ({ sourceId: 'screen:1', sourceName: '屏幕一', sourceWidth: 2560, sourceHeight: 1440 }), cancelCapturePicker: async () => {}, startCapture: async () => ({ state: 'recording', elapsed: 0, segments: 0 }),
    getCaptureStatus: async () => ({ state: 'recording', elapsed: 1, segments: 0 }),
    showMainWindow: async () => {},
    pauseCapture: async () => ({ state: 'paused', elapsed: 1, segments: 1 }),
    resumeCapture: async () => ({ state: 'recording', elapsed: 1, segments: 1 }), stopCapture: async () => null, cancelCaptureStart: async () => {},
    beginMediaJob: async () => ({ id: 'job', state: 'running', progress: 0, name: 'result.gif' }),
    cancelMediaJob: async () => {}, getMediaJobs: async () => [],
    captureErrorMessage, validateGifSegments, gifFrameCount, recentVideoAssets, videoDuration, videoImportedTime,
    // Shared-directory scanning has its own composable tests; keep these tests focused on export cancellation.
    useStoredVideos: source => ({ assets: vue.computed(() => recentVideoAssets(source())), directory: vue.ref(''), loading: vue.ref(false), error: vue.ref(''), warnings: vue.ref([]), preparing: vue.ref(false), refresh: async () => {}, reveal: async () => {}, preparePreview: async () => {} }),
    readMicrophonePreference: () => ({ deviceId: '', name: '' }), writeMicrophonePreference: () => {},
    ...overrides,
  }
  const scope = vue.effectScope()
  const state = scope.run(() => new Function(...Object.keys(injected), compiled)(...Object.values(injected)))
  mounted.forEach(callback => callback())
  return { state, events, timers, action: value => actionListener?.(value), get unlistened() { return unlistened }, deactivate: () => deactivated.forEach(callback => callback()), tick: () => [...timers.values()].forEach(callback => callback()), dispose: () => { unmounted.forEach(callback => callback()); scope.stop() } }
}
async function settle() { await Promise.resolve(); await Promise.resolve(); await vue.nextTick() }

test('native recorder reflects recoverable paused state and resumes saved segments', async () => {
  let status = { state: 'paused', elapsed: 7.4, segments: 2, error: '采集已中断，已保留录制片段。' }
  let resumed = 0
  const harness = workspace('RecorderWorkspace', { getCaptureStatus: async () => status, resumeCapture: async () => { resumed++; return { state: 'recording', elapsed: 7.4, segments: 2 } } })
  try {
    await settle()
    harness.state.countdown.value = 0
    await harness.state.begin()
    harness.tick(); await settle()
    assert.equal(harness.state.phase.value, 'paused')
    assert.equal(harness.state.elapsed.value, 7.4)
    assert.match(harness.state.error.value, /保留录制片段/)
    await harness.state.pauseOrResume()
    assert.equal(resumed, 1)
    assert.equal(harness.state.phase.value, 'recording')
    assert.equal(harness.state.error.value, '')
    status = { state: 'paused', elapsed: 9, segments: 3 }
    harness.tick(); await settle()
    assert.equal(harness.state.phase.value, 'paused')
    status = { state: 'recording', elapsed: 9.5, segments: 3 }
    harness.tick(); await settle()
    assert.equal(harness.state.phase.value, 'recording')
  } finally { harness.dispose() }
})

test('late recorder polling cannot restore paused state during or after stop', async () => {
  const pendingStatus = deferred(), pendingStop = deferred()
  const harness = workspace('RecorderWorkspace', { getCaptureStatus: () => pendingStatus.promise, stopCapture: () => pendingStop.promise })
  try {
    await settle()
    harness.state.countdown.value = 0
    await harness.state.begin()
    harness.tick()
    const stopped = harness.state.stop()
    assert.equal(harness.state.phase.value, 'stopping')
    pendingStatus.resolve({ state: 'paused', elapsed: 4, segments: 1, error: 'old status' })
    await settle()
    assert.equal(harness.state.phase.value, 'stopping')
    assert.equal(harness.state.error.value, '')
    pendingStop.resolve(null)
    await stopped
    assert.equal(harness.state.phase.value, 'idle')
  } finally { harness.dispose() }
})

test('a pre-resume poll cannot overwrite the newly resumed recorder state', async () => {
  const pending = deferred()
  const harness = workspace('RecorderWorkspace', { getCaptureStatus: () => pending.promise })
  try {
    await settle()
    harness.state.countdown.value = 0
    await harness.state.begin()
    await harness.state.pauseOrResume()
    harness.tick()
    await harness.state.pauseOrResume()
    pending.resolve({ state: 'paused', elapsed: 1, segments: 1 })
    await settle()
    assert.equal(harness.state.phase.value, 'recording')
  } finally { harness.dispose() }
})

test('failed native recording merge keeps recoverable segments and permits another stop', async () => {
  let stops = 0
  const harness = workspace('RecorderWorkspace', {
    stopCapture: async () => { if (++stops === 1) throw new Error('合并失败，录制片段仍保留。'); return asset },
    getCaptureStatus: async () => ({ state: 'paused', elapsed: 18.5, segments: 3 }),
  })
  try {
    await settle()
    harness.state.countdown.value = 0
    await harness.state.begin()
    await harness.state.stop()
    assert.equal(harness.state.phase.value, 'paused')
    assert.equal(harness.state.elapsed.value, 18.5)
    assert.equal(harness.state.error.value, '合并失败，录制片段仍保留。')
    harness.tick(); await settle()
    assert.equal(harness.state.error.value, '合并失败，录制片段仍保留。', 'routine polling must preserve the merge error')
    await harness.state.stop()
    assert.equal(stops, 2)
    assert.equal(harness.state.phase.value, 'idle')
    assert.equal(harness.state.error.value, '')
    assert.ok(harness.events.some(event => event[0] === 'asset' && event[1] === asset))
  } finally { harness.dispose() }
})

test('failed native stop and failed status query conservatively retain paused recovery controls', async () => {
  let stops = 0
  const harness = workspace('RecorderWorkspace', {
    stopCapture: async () => { if (++stops === 1) throw new Error('保存录制失败。'); return null },
    getCaptureStatus: async () => { throw new Error('状态查询失败。') },
  })
  try {
    await settle()
    harness.state.countdown.value = 0
    await harness.state.begin()
    harness.state.elapsed.value = 12
    await harness.state.stop()
    assert.equal(harness.state.phase.value, 'paused')
    assert.equal(harness.state.elapsed.value, 12)
    assert.equal(harness.state.error.value, '保存录制失败。')
    harness.tick(); await settle()
    assert.equal(harness.state.error.value, '保存录制失败。')
    await harness.state.stop()
    assert.equal(stops, 2)
    assert.equal(harness.state.phase.value, 'idle')
  } finally { harness.dispose() }
})

test('failed native stop honors a still-recording status and preserves its original failure', async () => {
  const harness = workspace('RecorderWorkspace', {
    stopCapture: async () => { throw new Error('结束录制失败。') },
    getCaptureStatus: async () => ({ state: 'recording', elapsed: 22, segments: 1, error: 'secondary status error' }),
  })
  try {
    await settle()
    harness.state.countdown.value = 0
    await harness.state.begin()
    await harness.state.stop()
    assert.equal(harness.state.phase.value, 'recording')
    assert.equal(harness.state.elapsed.value, 22)
    assert.equal(harness.state.error.value, '结束录制失败。')
  } finally { harness.dispose() }
})

test('opening the recorder never enumerates sources or requests permission', async () => {
  let enumerated = 0, selected = 0
  const harness = workspace('RecorderWorkspace', { listCaptureDevices: async () => { enumerated++; return captureDevices }, pickCaptureSource: async () => { selected++; return null } })
  try {
    await settle()
    assert.equal(enumerated, 0)
    assert.equal(selected, 0)
    assert.equal(harness.state.phase.value, 'idle')
    assert.deepEqual(harness.events, [])
    await harness.state.begin()
    assert.equal(selected, 1)
    assert.equal(harness.state.phase.value, 'idle')
    assert.deepEqual(harness.events, [['recording-change', true], ['recording-change', false]])
  } finally { harness.dispose() }
})

test('selected window and output dimensions are passed exactly after the picker confirms', async () => {
  const calls = [], picker = deferred()
  const chosen = { sourceId: 'window:24', sourceName: '演示窗口', sourceWidth: 1200, sourceHeight: 900, outputSize: { width: 1280, height: 720 } }
  const harness = workspace('RecorderWorkspace', {
    pickCaptureSource: () => picker.promise,
    startCapture: async options => { calls.push(options); return { state: 'recording', elapsed: 0, segments: 0, sourceId: options.sourceId, sourceName: '演示窗口', sourceWidth: 1200, sourceHeight: 900, outputSize: options.outputSize } },
  })
  try {
    harness.state.countdown.value = 0
    const start = harness.state.begin()
    assert.equal(harness.state.phase.value, 'selecting')
    assert.equal(calls.length, 0, '打开范围选择器不允许开始编码')
    assert.deepEqual(harness.events, [['recording-change', true]], '选择器出现时立即阻止项目切换与关闭')
    picker.resolve(chosen)
    await start
    assert.equal(harness.state.phase.value, 'recording')
    assert.equal(calls[0].sourceId, 'window:24')
    assert.deepEqual(calls[0].outputSize, { width: 1280, height: 720 })
    assert.equal('region' in calls[0], false)
    assert.deepEqual(harness.state.actualSource.value, { label: '演示窗口', width: 1200, height: 900, outputWidth: 1280, outputHeight: 720 })
    assert.equal(harness.state.pickerPreferences.value.mode, 'window')
  } finally { harness.dispose() }
})

test('drawn region uses source-relative physical pixels returned by the picker', async () => {
  const calls = [], chosen = { sourceId: 'screen:2', sourceName: '副屏幕', sourceWidth: 2560, sourceHeight: 1440, region: { x: 202, y: 110, width: 640, height: 480 }, outputSize: { width: 1280, height: 720 } }
  const harness = workspace('RecorderWorkspace', {
    pickCaptureSource: async () => chosen,
    startCapture: async options => { calls.push(options); return { state: 'recording', elapsed: 0, segments: 0 } },
  })
  try {
    harness.state.countdown.value = 0
    await harness.state.begin()
    assert.equal(calls[0].sourceId, chosen.sourceId)
    assert.deepEqual(calls[0].region, chosen.region)
    assert.deepEqual(calls[0].outputSize, chosen.outputSize)
    assert.equal(harness.state.pickerPreferences.value.mode, 'region')
  } finally { harness.dispose() }
})

test('cancelling source selection waits for native acknowledgement and never starts capture', async () => {
  const picker = deferred(), cancelled = []
  let pickerId, starts = 0
  const harness = workspace('RecorderWorkspace', {
    pickCaptureSource: id => { pickerId = id; return picker.promise },
    cancelCapturePicker: async id => { cancelled.push(id) },
    startCapture: async () => { starts++; return { state: 'recording', elapsed: 0, segments: 0 } },
  })
  try {
    harness.state.countdown.value = 0
    const start = harness.state.begin()
    await settle()
    await harness.state.stop()
    assert.deepEqual(cancelled, [pickerId])
    assert.equal(harness.state.phase.value, 'selecting', '恢复主窗口前必须保留活动保护')
    picker.resolve({ sourceId: 'window:24' })
    await start
    assert.equal(starts, 0, '晚到的选择结果不能绕过取消')
    assert.equal(harness.state.phase.value, 'idle')
    assert.equal(harness.state.error.value, '')
    assert.deepEqual(harness.events, [['recording-change', true], ['recording-change', false]])
  } finally { harness.dispose() }
})

test('permission failures return a retryable idle state and retry opens a new picker', async () => {
  let selections = 0, starts = 0
  const harness = workspace('RecorderWorkspace', {
    pickCaptureSource: async () => { if (++selections === 1) throw new Error('未获得屏幕录制权限，请允许后重试。'); return { sourceId: 'screen:1' } },
    startCapture: async () => { starts++; return { state: 'recording', elapsed: 0, segments: 0 } },
  })
  try {
    harness.state.countdown.value = 0
    await harness.state.begin()
    assert.equal(starts, 0)
    assert.equal(harness.state.phase.value, 'idle')
    assert.match(harness.state.error.value, /屏幕录制权限/)
    await harness.state.begin()
    assert.equal(starts, 1)
    assert.equal(harness.state.phase.value, 'recording')
    assert.equal(harness.state.error.value, '')
  } finally { harness.dispose() }
})

test('unmount cancels an open native picker and rejects its late selection', async () => {
  const picker = deferred(), cancelled = []
  let starts = 0
  const harness = workspace('RecorderWorkspace', {
    pickCaptureSource: () => picker.promise,
    cancelCapturePicker: async id => { cancelled.push(id) },
    startCapture: async () => { starts++; return { state: 'recording', elapsed: 0, segments: 0 } },
  })
  harness.state.countdown.value = 0
  const start = harness.state.begin()
  await settle()
  harness.dispose()
  assert.equal(cancelled.length, 1)
  picker.resolve({ sourceId: 'screen:1' })
  await start
  assert.equal(starts, 0)
})

test('cancelling a pending native start keeps recovery controls when final stop fails', async () => {
  const pending = deferred()
  let stops = 0
  const harness = workspace('RecorderWorkspace', {
    startCapture: () => pending.promise,
    stopCapture: async () => { if (++stops === 1) throw new Error('停止保存失败，片段已保留。'); return null },
    getCaptureStatus: async () => ({ state: 'paused', elapsed: 2, segments: 1 }),
  })
  try {
    await settle()
    harness.state.countdown.value = 0
    const starting = harness.state.begin()
    await settle()
    assert.equal(harness.state.phase.value, 'starting')
    await harness.state.stop()
    pending.resolve({ state: 'recording', elapsed: 1, segments: 0 })
    await starting
    assert.equal(harness.state.phase.value, 'paused')
    assert.equal(harness.state.elapsed.value, 2)
    assert.match(harness.state.error.value, /片段已保留/)
    await harness.state.stop()
    assert.equal(stops, 2)
    assert.equal(harness.state.phase.value, 'idle')
  } finally { harness.dispose() }
})

test('native start cancellation reaches the pending request before it returns', async () => {
  const pending = deferred(), cancelled = []
  let requestId
  const harness = workspace('RecorderWorkspace', {
    startCapture: options => { requestId = options.requestId; return pending.promise },
    cancelCaptureStart: async id => { cancelled.push(id) },
  })
  try {
    await settle()
    harness.state.countdown.value = 0
    const starting = harness.state.begin()
    await settle()
    assert.match(requestId, /^[0-9a-f-]{36}$/)
    await harness.state.stop()
    assert.deepEqual(cancelled, [requestId])
    assert.equal(harness.state.phase.value, 'starting', '界面必须等待原生请求确认取消后再解锁')
    pending.reject(new Error('录制已取消。'))
    await starting
    assert.equal(harness.state.phase.value, 'idle')
    assert.equal(harness.state.error.value, '')
  } finally { harness.dispose() }
})

test('cancelling GIF while the save dialog is pending cancels its returned job without polling', async () => {
  const pendingJob = deferred(), cancelled = []
  let polled = 0
  const harness = workspace('GifWorkspace', { beginMediaJob: () => pendingJob.promise, cancelMediaJob: async id => { cancelled.push(id) }, getMediaJobs: async () => { polled++; return [] } })
  try {
    const exporting = harness.state.exportGif()
    assert.equal(harness.state.exporting.value, true)
    await harness.state.cancel()
    assert.equal(harness.state.exporting.value, true, 'pending save dialog keeps the operation guarded')
    pendingJob.resolve({ id: 'late-job', state: 'running', progress: 0, name: 'result.gif' })
    await exporting
    assert.deepEqual(cancelled, ['late-job'])
    assert.equal(polled, 0)
    assert.equal(harness.timers.size, 0)
    assert.equal(harness.state.exporting.value, false)
    assert.equal(harness.state.jobId.value, '')
    assert.deepEqual(harness.events.filter(event => event[0] === 'busy-change').map(event => event[1]), [true, false])
    assert.ok(harness.events.some(event => event[0] === 'status' && event[1].includes('已取消')))
  } finally { harness.dispose() }
})

test('cancelling a pending GIF save dialog also handles choosing no destination', async () => {
  const pendingJob = deferred()
  let cancelled = 0
  const harness = workspace('GifWorkspace', { beginMediaJob: () => pendingJob.promise, cancelMediaJob: async () => { cancelled++ } })
  try {
    const exporting = harness.state.exportGif()
    await harness.state.cancel()
    pendingJob.resolve(null)
    await exporting
    assert.equal(cancelled, 0)
    assert.equal(harness.state.exporting.value, false)
    assert.equal(harness.timers.size, 0)
  } finally { harness.dispose() }
})


test('floating recording actions pause, resume and stop through the same recorder and import once', async () => {
  let status = { state: 'recording', elapsed: 3, segments: 0, muted: false, audioAvailable: true }
  const calls = []
  const stopped = deferred()
  const harness = workspace('RecorderWorkspace', {
    startCapture: async () => ({ ...status }), getCaptureStatus: async () => ({ ...status }),
    pauseCapture: async () => { calls.push('pause'); status = { ...status, state: 'paused', segments: 1 }; return { ...status } },
    resumeCapture: async () => { calls.push('resume'); status = { ...status, state: 'recording' }; return { ...status } },
    stopCapture: async () => { calls.push('stop'); return stopped.promise },
  })
  try {
    await settle()
    harness.state.countdown.value = 0
    await harness.state.begin()
    harness.action('pause'); await settle()
    assert.equal(harness.state.phase.value, 'paused')
    harness.action('pause'); await settle()
    assert.deepEqual(calls, ['pause'], '重复 pause 不允许反向恢复录制')
    harness.action('resume'); await settle()
    assert.equal(harness.state.phase.value, 'recording')
    harness.action('resume'); await settle()
    assert.deepEqual(calls, ['pause', 'resume'], '重复 resume 不允许反向暂停')
    harness.action('stop')
    harness.action('stop')
    await harness.state.stop()
    harness.action('pause')
    assert.equal(harness.state.phase.value, 'stopping')
    assert.equal(harness.state.controlBusy.value, true)
    assert.deepEqual(calls, ['pause', 'resume', 'stop'])
    stopped.resolve(asset); await settle(); await settle()
    assert.equal(harness.state.phase.value, 'idle')
    assert.equal(harness.state.controlBusy.value, false)
    assert.deepEqual(harness.events.filter(event => event[0] === 'asset'), [['asset', asset]])
    harness.action('stop'); await settle()
    assert.equal(calls.filter(call => call === 'stop').length, 1)
  } finally { harness.dispose() }
  assert.equal(harness.unlistened, 1)
  harness.action('stop')
  assert.equal(calls.filter(call => call === 'stop').length, 1, '卸载后浮栏事件不再触发录制命令')
})

test('picker receives default enabled microphone and its disabled choice is honored', async () => {
  let preferences, started
  const harness = workspace('RecorderWorkspace', {
    pickCaptureSource: async (_id, value) => { preferences = value; return { sourceId: 'window:24', microphone: false } },
    startCapture: async options => { started = options; return { state: 'recording', elapsed: 0, microphoneEnabled: options.microphone } },
  })
  try {
    assert.equal(harness.state.microphone.value, true)
    harness.state.countdown.value = 0
    await harness.state.begin()
    assert.equal(preferences.microphone, true, '初次选择范围默认开启麦克风')
    assert.equal(started.microphone, false, '窗口选择中的关闭选择必须传到实际采集')
    assert.equal(harness.state.microphoneEnabled.value, false)
    assert.equal(harness.state.pickerPreferences.value.microphone, false)
  } finally { harness.dispose() }
})

test('native recorder remembers its own input and forwards the chosen input even when muted', async () => {
  const saved = [], shown = [], started = []
  let remembered = { deviceId: 'native-old-input', name: '旧麦克风' }
  const chosen = { sourceId: 'window:24', microphone: false, audioDevice: 'native-usb-input' }
  const harness = workspace('RecorderWorkspace', {
    readMicrophonePreference: scope => { assert.equal(scope, 'capture-native'); return remembered },
    writeMicrophonePreference: (scope, value) => { remembered = value; saved.push({ scope, value }) },
    pickCaptureSource: async (_id, preferences) => { shown.push(preferences); return chosen },
    startCapture: async options => { started.push(options); return { state: 'recording', elapsed: 0, microphoneEnabled: false } },
  })
  try {
    harness.state.countdown.value = 0
    await harness.state.begin()
    assert.equal(shown[0].audioDevice, 'native-old-input')
    assert.equal(started[0].audioDevice, 'native-usb-input')
    assert.equal(started[0].microphone, false)
    assert.equal(harness.state.pickerPreferences.value.audioDevice, 'native-usb-input')
    assert.equal(saved[0].scope, 'capture-native')
    assert.equal(saved[0].value.deviceId, 'native-usb-input')
    await harness.state.stop()
    await harness.state.begin()
    assert.equal(shown[1].audioDevice, 'native-usb-input')
  } finally { harness.dispose() }
})

test('microphone can enable after a silent start and retains its choice across pause and resume', async () => {
  let status = { state: 'recording', elapsed: 4.5, segments: 0, muted: true, audioAvailable: false, microphoneEnabled: false }
  const changed = []
  const harness = workspace('RecorderWorkspace', {
    pickCaptureSource: async () => ({ sourceId: 'window:24', microphone: false }),
    startCapture: async () => ({ ...status }), getCaptureStatus: async () => ({ ...status }),
    pauseCapture: async () => { status = { ...status, state: 'paused', segments: 1 }; return { ...status } },
    resumeCapture: async () => { status = { ...status, state: 'recording' }; return { ...status } },
    setCaptureMicrophone: async (enabled, id) => { assert.match(id, /^[0-9a-f-]{36}$/); changed.push(enabled); status = { ...status, microphoneEnabled: enabled, muted: !enabled, audioAvailable: enabled }; return { ...status } },
  })
  try {
    await settle(); harness.state.countdown.value = 0; await harness.state.begin()
    assert.equal(harness.state.microphoneEnabled.value, false)
    await harness.state.toggleMicrophone()
    assert.equal(harness.state.microphoneEnabled.value, true)
    assert.equal(harness.state.phase.value, 'recording')
    await harness.state.pauseOrResume()
    assert.equal(harness.state.microphoneEnabled.value, true)
    assert.equal(harness.state.phase.value, 'paused')
    await harness.state.pauseOrResume()
    assert.equal(harness.state.microphoneEnabled.value, true)
    await harness.state.pauseOrResume()
    await harness.state.toggleMicrophone()
    assert.equal(harness.state.microphoneEnabled.value, false)
    assert.equal(harness.state.phase.value, 'paused', '暂停时关闭麦克风不能恢复录制')
    assert.equal(harness.state.elapsed.value, 4.5)
    assert.deepEqual(changed, [true, false])
  } finally { harness.dispose() }
})

test('rejected microphone enable queries native state and keeps silent video recording usable', async () => {
  const status = { state: 'recording', elapsed: 6.5, segments: 0, microphoneEnabled: false, audioAvailable: false, muted: true }
  let queries = 0
  const harness = workspace('RecorderWorkspace', {
    startCapture: async () => ({ ...status }),
    getCaptureStatus: async () => { queries++; return { ...status } },
    setCaptureMicrophone: async () => { throw new Error('麦克风权限未开启。') },
  })
  try {
    harness.state.countdown.value = 0; await harness.state.begin()
    await harness.state.toggleMicrophone()
    assert.equal(queries, 1, '失败后使用原生真实状态恢复界面')
    assert.equal(harness.state.phase.value, 'recording')
    assert.equal(harness.state.microphoneEnabled.value, false)
    assert.equal(harness.state.controlBusy.value, false)
    assert.equal(harness.state.microphonePending.value, false)
    assert.match(harness.state.error.value, /麦克风权限/)
    await harness.state.stop()
    assert.equal(harness.state.phase.value, 'idle')
  } finally { harness.dispose() }
})

test('stop cancels pending microphone permission, ignores stale polling and saves only once', async () => {
  const pending = deferred(), stale = deferred(), cancelled = [], calls = []
  let microphoneId
  const harness = workspace('RecorderWorkspace', {
    startCapture: async () => ({ state: 'recording', elapsed: 3, microphoneEnabled: false, audioAvailable: false, muted: true }),
    getCaptureStatus: () => stale.promise,
    setCaptureMicrophone: async (_enabled, id) => { microphoneId = id; calls.push('microphone'); return pending.promise },
    cancelCaptureStart: async id => { cancelled.push(id) },
    stopCapture: async () => { calls.push('stop'); return asset },
  })
  try {
    harness.state.countdown.value = 0; await harness.state.begin()
    harness.tick()
    const changing = harness.state.toggleMicrophone()
    assert.equal(harness.state.microphonePending.value, true)
    harness.action('toggle-microphone'); harness.action('pause')
    const stopping = harness.state.stop()
    harness.action('stop')
    assert.deepEqual(cancelled, [microphoneId], '等待系统授权时停止必须取消该授权请求')
    assert.deepEqual(calls, ['microphone'], '取消确认前不并发停止原生采集')
    stale.resolve({ state: 'paused', elapsed: 99, microphoneEnabled: true, audioAvailable: true })
    await settle()
    assert.equal(harness.state.elapsed.value, 3)
    assert.equal(harness.state.microphoneEnabled.value, false)
    pending.reject(new Error('已取消麦克风。'))
    await Promise.all([changing, stopping]); await settle()
    assert.deepEqual(calls, ['microphone', 'stop'])
    assert.equal(harness.state.phase.value, 'idle')
    assert.equal(harness.state.error.value, '')
    assert.deepEqual(harness.events.filter(event => event[0] === 'asset'), [['asset', asset]])
  } finally { harness.dispose() }
})

test('pending native controls reject repeated actions and stale status updates', async () => {
  const pending = deferred(), stale = deferred()
  let pauses = 0, muted = 0, stops = 0
  const harness = workspace('RecorderWorkspace', {
    startCapture: async () => ({ state: 'recording', elapsed: 2, segments: 0, muted: false, audioAvailable: true }),
    getCaptureStatus: () => stale.promise,
    pauseCapture: async () => { pauses++; return pending.promise },
    setCaptureMicrophone: async () => { muted++; return {} },
    stopCapture: async () => { stops++; return null },
  })
  try {
    await settle(); harness.state.countdown.value = 0; await harness.state.begin()
    harness.tick()
    harness.action('pause')
    harness.action('pause'); harness.action('toggle-microphone'); harness.action('stop')
    await harness.state.pauseOrResume()
    assert.equal(harness.state.controlBusy.value, true)
    assert.equal(pauses, 1); assert.equal(muted, 0); assert.equal(stops, 0)
    stale.resolve({ state: 'recording', elapsed: 99, segments: 0, muted: false, audioAvailable: false })
    await settle()
    assert.equal(harness.state.elapsed.value, 2)
    assert.equal(harness.state.audioAvailable.value, true)
    pending.resolve({ state: 'paused', elapsed: 2.8, segments: 1, muted: true, audioAvailable: true })
    await settle()
    assert.equal(harness.state.phase.value, 'paused')
    assert.equal(harness.state.elapsed.value, 2.8)
    assert.equal(harness.state.muted.value, true)
    assert.equal(harness.state.controlBusy.value, false)
  } finally { harness.dispose() }
})


test('cancelling before the floating action listener is ready never opens a picker', async () => {
  const listening = deferred()
  let pickers = 0, starts = 0, unlistened = 0
  const harness = workspace('RecorderWorkspace', {
    onCaptureControlsAction: () => listening.promise,
    pickCaptureSource: async () => { pickers++; return { sourceId: 'screen:1' } },
    startCapture: async () => { starts++; return { state: 'recording', elapsed: 0, segments: 0 } },
  })
  harness.state.countdown.value = 0
  const starting = harness.state.begin()
  await harness.state.stop()
  assert.equal(harness.state.phase.value, 'selecting')
  harness.dispose()
  listening.resolve(() => { unlistened++ })
  await starting
  assert.equal(pickers, 0)
  assert.equal(starts, 0)
  assert.equal(unlistened, 1)
  assert.equal(harness.state.phase.value, 'idle')
})
