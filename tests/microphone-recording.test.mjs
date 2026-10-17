import test from 'node:test'
import assert from 'node:assert/strict'
import { startMicrophoneRecording, microphoneRecordingErrorMessage } from '../src/core/microphone-recording.ts'
import { authorizeBrowserMicrophones, listBrowserMicrophones, readMicrophonePreference, writeMicrophonePreference } from '../src/core/microphone-devices.ts'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

class Track extends EventTarget {
  kind = 'audio'
  readyState = 'live'
  stops = 0
  stop() { this.stops++; this.readyState = 'ended' }
  disconnect() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')) }
}

async function settle() { for (let i = 0; i < 5; i++) await Promise.resolve() }

function environment(t, options = {}) {
  const previous = new Map(['navigator', 'MediaRecorder', 'performance'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const track = new Track(), requests = [], recorders = []
  const stream = { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] }
  let now = 1000
  class Recorder extends EventTarget {
    static isTypeSupported(type) { return type === (options.mime ?? 'audio/webm;codecs=opus') }
    state = 'inactive'
    stops = 0
    constructor(source, settings) {
      super()
      if (options.constructorError) throw options.constructorError
      this.stream = source
      this.settings = settings
      this.mimeType = settings.mimeType ?? options.defaultMime ?? 'audio/webm'
      recorders.push(this)
    }
    start(timeslice) {
      if (options.startError) throw options.startError
      this.timeslice = timeslice
      this.state = 'recording'
    }
    begin() { this.dispatchEvent(new Event('start')) }
    data(data) {
      const event = new Event('dataavailable')
      Object.defineProperty(event, 'data', { value: data })
      this.dispatchEvent(event)
    }
    error(error) {
      const event = new Event('error')
      Object.defineProperty(event, 'error', { value: error })
      this.dispatchEvent(event)
    }
    stop() {
      this.stops++
      if (options.stopError) throw options.stopError
      this.state = 'inactive'
      if (options.omitStop) return
      queueMicrotask(() => {
        if (!options.empty) this.data(options.finalChunk ?? new Blob(['encoded microphone audio'], { type: this.mimeType }))
        this.dispatchEvent(new Event('stop'))
      })
    }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    async enumerateDevices() { return options.devices ?? [] },
    getUserMedia(constraints) {
    requests.push(constraints)
    return options.permission ? options.permission(stream) : Promise.resolve(stream)
  } } } })
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: Recorder })
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } })
  t.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })
  return {
    track, stream, requests, recorders,
    advance(ms) { now += ms },
    async start(options) {
      const pending = startMicrophoneRecording(options)
      await settle()
      recorders.at(-1).begin()
      return pending
    },
  }
}

test('microphone recording requests only audio and resolves after the actual start event', async t => {
  const env = environment(t)
  let started = false
  const pending = startMicrophoneRecording().then(value => { started = true; return value })
  await settle()
  assert.deepEqual(env.requests, [{ audio: true, video: false }])
  assert.equal(started, false)
  assert.equal(env.recorders[0].timeslice, 1000)
  env.advance(5000)
  env.recorders[0].begin()
  const recording = await pending
  assert.equal(recording.elapsed, 0, 'permission and encoder startup must not count as recorded duration')
  env.advance(2500)
  assert.equal(recording.elapsed, 2.5)
  env.recorders[0].data(new Blob())
  const stopped = recording.stop()
  assert.equal(env.track.readyState, 'ended', 'stop releases the device before waiting for encoded output')
  assert.equal(stopped, recording.finished)
  assert.equal(recording.stop(), stopped)
  env.advance(9000)
  assert.equal(recording.elapsed, 2.5)
  const audio = await stopped
  assert.equal(await audio.blob.text(), 'encoded microphone audio')
  assert.equal(audio.blob.type, 'audio/webm;codecs=opus')
  assert.match(audio.name, /^录音-.*\.webm$/)
  assert.equal(env.track.stops, 1)
  assert.equal(env.recorders[0].stops, 1)
})

test('an explicit microphone source uses an exact constraint, never the system fallback', async t => {
  const env = environment(t), recording = await env.start({ deviceId: 'usb-microphone' })
  assert.deepEqual(env.requests, [{ audio: { deviceId: { exact: 'usb-microphone' } }, video: false }])
  assert.ok((await recording.stop()).blob.size > 0)
})

test('a missing selected source reports a disconnected microphone without retrying another input', async t => {
  const env = environment(t, { permission: async () => { throw new DOMException('deviceId unavailable', 'OverconstrainedError') } })
  await assert.rejects(startMicrophoneRecording({ deviceId: 'missing-microphone' }), { name: 'OverconstrainedError' })
  assert.equal(env.requests.length, 1)
  assert.equal(env.recorders.length, 0)
  assert.match(microphoneRecordingErrorMessage(new DOMException('', 'OverconstrainedError')), /所选麦克风已断开/)
})

test('system default source does not lock recording to an input device', async t => {
  const env = environment(t), recording = await env.start({ deviceId: '' })
  assert.deepEqual(env.requests, [{ audio: true, video: false }])
  await recording.stop()
})

test('listing microphones filters aliases, cameras and duplicate IDs without accessing any input', async t => {
  const env = environment(t, { devices: [
    { kind: 'videoinput', deviceId: 'camera', label: 'Camera' },
    { kind: 'audioinput', deviceId: 'default', label: 'Default - USB Microphone' },
    { kind: 'audioinput', deviceId: 'communications', label: 'Communication - USB Microphone' },
    { kind: 'audioinput', deviceId: 'usb', label: 'USB Microphone' },
    { kind: 'audioinput', deviceId: 'usb', label: 'USB Microphone' },
    { kind: 'audioinput', deviceId: 'internal', label: 'Built-in Microphone' },
    { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' },
  ] })
  assert.deepEqual(await listBrowserMicrophones(), {
    devices: [{ id: 'usb', name: 'USB Microphone' }, { id: 'internal', name: 'Built-in Microphone' }],
    permissionRequired: false,
  })
  assert.equal(env.requests.length, 0)
  assert.equal(env.recorders.length, 0)
})

test('hidden microphone labels request an explicit authorization action without opening a device', async t => {
  const env = environment(t, { devices: [{ kind: 'audioinput', deviceId: '', label: '' }] })
  assert.deepEqual(await listBrowserMicrophones(), { devices: [], permissionRequired: true })
  assert.equal(env.requests.length, 0)
})

test('explicit label authorization immediately releases the microphone without starting an encoder', async t => {
  const env = environment(t)
  await authorizeBrowserMicrophones()
  assert.equal(env.track.stops, 1)
  assert.equal(env.recorders.length, 0)
  assert.deepEqual(env.requests, [{ audio: true, video: false }])
})

test('canceling label authorization releases a stream granted after the picker closed', async t => {
  const permission = deferred(), abort = new AbortController()
  const env = environment(t, { permission: () => permission.promise })
  const pending = authorizeBrowserMicrophones(abort.signal)
  abort.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  permission.resolve(env.stream)
  await settle()
  assert.equal(env.track.stops, 1)
  assert.equal(env.recorders.length, 0)
})

test('source preferences remain separate for editor and capture device ID namespaces', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), values = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage })
  assert.deepEqual(readMicrophonePreference('editor'), { deviceId: '', name: '' })
  writeMicrophonePreference('editor', { deviceId: 'browser-opaque-id', name: 'USB microphone' })
  writeMicrophonePreference('capture-native', { deviceId: 'native-device-id', name: 'USB microphone' })
  assert.deepEqual(readMicrophonePreference('editor'), { deviceId: 'browser-opaque-id', name: 'USB microphone' })
  assert.deepEqual(readMicrophonePreference('capture-native'), { deviceId: 'native-device-id', name: 'USB microphone' })
  values.set('open-media:microphone:editor', '{invalid')
  assert.deepEqual(readMicrophonePreference('editor'), { deviceId: '', name: '' })
})

test('cancel before requesting permission does not open any device', async t => {
  const env = environment(t), abort = new AbortController()
  abort.abort()
  await assert.rejects(startMicrophoneRecording({ signal: abort.signal }), { name: 'AbortError' })
  assert.deepEqual(env.requests, [])
})

test('cancel while waiting for permission rejects immediately and releases a late granted stream', async t => {
  const permission = deferred(), abort = new AbortController()
  const env = environment(t, { permission: () => permission.promise })
  const pending = startMicrophoneRecording({ signal: abort.signal })
  abort.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(env.recorders.length, 0)
  permission.resolve(env.stream)
  await settle()
  assert.equal(env.track.stops, 1)
})

test('a denied permission request reports rejection without starting an encoder', async t => {
  const env = environment(t, { permission: async () => { throw new DOMException('denied', 'NotAllowedError') } })
  await assert.rejects(startMicrophoneRecording(), { name: 'NotAllowedError' })
  assert.equal(env.recorders.length, 0)
})

test('cancel during encoder startup releases capture and rejects the pending start', async t => {
  const env = environment(t), abort = new AbortController()
  const pending = startMicrophoneRecording({ signal: abort.signal })
  await settle()
  abort.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(env.track.readyState, 'ended')
  assert.equal(env.recorders[0].state, 'inactive')
})

test('encoder constructor and start failures release the granted microphone', async t => {
  for (const key of ['constructorError', 'startError']) {
    await t.test(key, async t => {
      const env = environment(t, { [key]: new Error(key) })
      await assert.rejects(startMicrophoneRecording(), { message: key })
      assert.equal(env.track.stops, 1)
    })
  }
})

test('a disconnected microphone automatically finishes and returns its recorded audio', async t => {
  const env = environment(t), recording = await env.start()
  env.advance(800)
  env.track.disconnect()
  const audio = await recording.finished
  assert.ok(audio.blob.size > 0)
  assert.equal(recording.elapsed, 0.8)
  assert.equal(env.recorders[0].stops, 1)
  assert.equal(env.track.stops, 1)
})

test('cancel during recording discards data and releases the microphone', async t => {
  const env = environment(t), recording = await env.start()
  env.recorders[0].data(new Blob(['partial']))
  recording.cancel()
  await assert.rejects(recording.finished, { name: 'AbortError' })
  assert.equal(env.track.stops, 1)
  assert.equal(recording.stop(), recording.finished)
  await settle()
})

test('abort signal remains effective after recording starts', async t => {
  const env = environment(t), abort = new AbortController()
  const recording = await env.start({ signal: abort.signal })
  abort.abort()
  await assert.rejects(recording.finished, { name: 'AbortError' })
  assert.equal(env.track.stops, 1)
})

test('encoder error rejects completion and releases capture even without a caller awaiting finished yet', async t => {
  const env = environment(t), recording = await env.start()
  env.recorders[0].error(new DOMException('device lost', 'NotReadableError'))
  await settle()
  await assert.rejects(recording.finished, { name: 'NotReadableError' })
  assert.equal(env.track.stops, 1)
})

test('empty output is rejected and stop failures release the device', async t => {
  for (const options of [{ empty: true }, { stopError: new Error('cannot stop') }]) {
    await t.test(options.empty ? 'empty output' : 'stop failure', async t => {
      const env = environment(t, options), recording = await env.start()
      await assert.rejects(recording.stop(), options.empty ? /没有录到有效音频/ : /cannot stop/)
      assert.equal(env.track.stops, 1)
    })
  }
})

test('audio mp4 uses an audio filename and preserves its supported format', async t => {
  const env = environment(t, { mime: 'audio/mp4' }), recording = await env.start()
  const audio = await recording.stop()
  assert.equal(audio.blob.type, 'audio/mp4')
  assert.match(audio.name, /\.m4a$/)
  assert.equal(env.recorders[0].settings.audioBitsPerSecond, 128_000)
})

function reportedChunk(text, bytes) {
  const chunk = new Blob([text], { type: 'audio/webm;codecs=opus' })
  // Exercise accounting without allocating hundreds of megabytes in a lifecycle unit test.
  Object.defineProperty(chunk, 'size', { value: bytes })
  return chunk
}

test('the byte target stops normally and preserves boundary and final chunks even beyond 128 MB', async t => {
  const env = environment(t, { finalChunk: reportedChunk('final', 40 * 1024 * 1024) })
  const recording = await env.start()
  env.recorders[0].data(reportedChunk('first', 94 * 1024 * 1024))
  assert.equal(env.recorders[0].stops, 0)
  env.recorders[0].data(reportedChunk('boundary', 2 * 1024 * 1024))
  assert.equal(env.recorders[0].stops, 1)
  const audio = await recording.finished
  assert.equal(await audio.blob.text(), 'firstboundaryfinal')
  assert.equal(env.recorders[0].stops, 1, 'the final chunk must not stop a second time')
  assert.equal(env.track.stops, 1)
})

test('one oversized encoder chunk still yields the complete recording instead of discarding earlier audio', async t => {
  const env = environment(t), recording = await env.start()
  env.recorders[0].data(new Blob(['earlier']))
  env.recorders[0].data(reportedChunk('buffered', 128 * 1024 * 1024 + 1))
  const audio = await recording.finished
  assert.equal(await audio.blob.text(), 'earlierbufferedencoded microphone audio')
  assert.equal(env.recorders[0].stops, 1)
  assert.equal(env.track.stops, 1)
})

test('an already disconnected device is rejected and released before encoder creation', async t => {
  const env = environment(t)
  env.track.readyState = 'ended'
  await assert.rejects(startMicrophoneRecording(), /麦克风已断开/)
  assert.equal(env.track.stops, 1)
  assert.equal(env.recorders.length, 0)
})

test('an unexpected video track is never handed to the microphone encoder', async t => {
  const env = environment(t)
  const video = new Track()
  video.kind = 'video'
  env.stream.getTracks = () => [env.track, video]
  env.stream.getVideoTracks = () => [video]
  await assert.rejects(startMicrophoneRecording(), /意外的视频轨道/)
  assert.equal(env.track.stops, 1)
  assert.equal(video.stops, 1)
  assert.equal(env.recorders.length, 0)
})

test('the duration limit automatically finalizes audio and missing final events time out safely', async t => {
  await t.test('30 minute duration limit', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const env = environment(t), recording = await env.start()
    env.advance(30 * 60 * 1000)
    t.mock.timers.tick(30 * 60 * 1000)
    assert.ok((await recording.finished).blob.size > 0)
    assert.equal(env.track.stops, 1)
    assert.equal(recording.elapsed, 30 * 60)
  })
  await t.test('missing final events', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const env = environment(t, { omitStop: true }), recording = await env.start()
    recording.stop()
    t.mock.timers.tick(10_000)
    await assert.rejects(recording.finished, /保存录音超时/)
    assert.equal(env.track.stops, 1)
  })
})

test('missing start events time out and release capture', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const env = environment(t)
  const pending = startMicrophoneRecording()
  await settle()
  t.mock.timers.tick(10_000)
  await assert.rejects(pending, /启动麦克风录音超时/)
  assert.equal(env.track.stops, 1)
})

test('microphone errors explain permission, missing devices and cancellation', () => {
  assert.match(microphoneRecordingErrorMessage(new DOMException('', 'NotAllowedError')), /麦克风权限/)
  assert.match(microphoneRecordingErrorMessage({ name: 'NotFoundError' }), /没有找到/)
  assert.match(microphoneRecordingErrorMessage(new DOMException('', 'NotReadableError')), /占用/)
  assert.equal(microphoneRecordingErrorMessage(new DOMException('', 'AbortError')), '已取消录音。')
  assert.equal(microphoneRecordingErrorMessage(new Error('具体错误')), '具体错误')
})
