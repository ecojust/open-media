const assert = require('node:assert/strict')
const { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { chromium } = require('@playwright/test')
const ts = require('typescript')

const root = join(__dirname, '../..')
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const source = ts.transpileModule(readFileSync(join(root, 'src/core/capture.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText

function rms(file, start, end) {
  const bytes = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ss', String(start), '-t', String(end - start), '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'])
  assert.ok(bytes.length > 48000 * (end - start) * 3, 'decoded audio covers the requested interval')
  let energy = 0
  for (let i = 0; i < bytes.length; i += 4) energy += bytes.readFloatLE(i) ** 2
  return Math.sqrt(energy / (bytes.length / 4))
}

async function browserRecording(directory) {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}),
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'] })
  try {
    const page = await browser.newPage()
    await page.route('http://localhost/capture-mute', route => route.fulfill({ body: '<title>录制声音验证</title>', contentType: 'text/html' }))
    await page.goto('http://localhost/capture-mute')
    const result = await page.evaluate(async source => {
      const { startBrowserCapture } = await import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}`)
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const canvas = document.createElement('canvas')
      canvas.width = 160; canvas.height = 90
      const painter = canvas.getContext('2d')
      let frame = 0
      const render = setInterval(() => { painter.fillStyle = frame++ % 2 ? 'red' : 'blue'; painter.fillRect(0, 0, 160, 90) }, 50)
      const screen = canvas.captureStream(20)
      const contexts = []
      const sources = []
      const tone = frequency => {
        const context = new AudioContext()
        const oscillator = context.createOscillator()
        oscillator.frequency.value = frequency
        const gain = context.createGain(); gain.gain.value = 0.1
        const output = context.createMediaStreamDestination()
        oscillator.connect(gain).connect(output); oscillator.start()
        contexts.push(context); sources.push(...output.stream.getAudioTracks())
        return output.stream
      }
      screen.addTrack(tone(440).getAudioTracks()[0])
      let requests = 0
      const microphoneConstraints = []
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => { requests++; return screen } })
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async constraints => { requests++; microphoneConstraints.push(constraints); return tone(660) } })
      const capture = await startBrowserCapture({ fps: 20, microphone: true, systemAudio: true, audioDevice: 'studio-microphone' })
      const initial = { available: capture.audioAvailable, muted: capture.muted }
      await sleep(1200)
      capture.setMuted(true)
      const muteAt = capture.elapsed
      const mutedSources = sources.every(track => !track.enabled)
      const mutedOutput = capture.stream.getAudioTracks().every(track => !track.enabled)
      const videoStillEnabled = capture.stream.getVideoTracks().every(track => track.enabled && track.readyState === 'live')
      await sleep(1000)
      capture.pause()
      const pausedAt = capture.elapsed
      await sleep(200)
      capture.setMuted(false); capture.setMuted(true)
      const paused = { phase: capture.phase, elapsed: capture.elapsed, muted: capture.muted }
      capture.resume()
      await sleep(300)
      const preservedMute = capture.muted && sources.every(track => !track.enabled)
      capture.setMuted(false)
      const unmuteAt = capture.elapsed
      const restored = sources.every(track => track.enabled) && capture.stream.getAudioTracks().every(track => track.enabled)
      await sleep(1200)
      const recorded = await capture.stop()
      const unavailableAfterStop = !capture.audioAvailable
      capture.setMuted(true)
      const noChangeAfterStop = !capture.muted
      clearInterval(render)
      await Promise.all(contexts.map(context => context.close()))
      return { initial, muteAt, unmuteAt, pausedAt, paused, mutedSources, mutedOutput, videoStillEnabled,
        preservedMute, restored, unavailableAfterStop, noChangeAfterStop, requests, microphoneConstraints, duration: recorded.duration,
        bytes: Array.from(new Uint8Array(await recorded.blob.arrayBuffer())) }
    }, source)
    assert.deepEqual(result.initial, { available: true, muted: false })
    for (const name of ['mutedSources', 'mutedOutput', 'videoStillEnabled', 'preservedMute', 'restored', 'unavailableAfterStop', 'noChangeAfterStop']) assert.equal(result[name], true, name)
    assert.deepEqual(result.paused, { phase: 'paused', elapsed: result.pausedAt, muted: true })
    assert.equal(result.requests, 2, 'muting never requests another capture source or microphone permission')
    assert.deepEqual(result.microphoneConstraints, [{ audio: { echoCancellation: true, noiseSuppression: true, deviceId: { exact: 'studio-microphone' } }, video: false }], 'initial capture requests the exact selected microphone')
    const file = join(directory, 'browser.webm')
    writeFileSync(file, Buffer.from(result.bytes))
    const levels = [rms(file, 0.3, 0.7), rms(file, result.muteAt + 0.35, result.muteAt + 0.7), rms(file, result.unmuteAt + 0.35, result.unmuteAt + 0.7)]
    assert.ok(levels[0] > 0.03 && levels[2] > 0.03, JSON.stringify(levels))
    assert.ok(levels[1] < 0.00001, JSON.stringify(levels))
    assert.ok(result.duration >= 3.6 && result.duration < 4.8)
    console.log('PASS actual browser recording: both sources and output mute, decoded silence, resumed audio, preserved pause clock, no new permissions', levels)
    const silentSource = await page.evaluate(async source => {
      const { startBrowserCapture } = await import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}`)
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90
      const painter = canvas.getContext('2d'); painter.fillRect(0, 0, 160, 90)
      const stream = canvas.captureStream(20)
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => stream })
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { throw new Error('Muting must not enable the microphone') } })
      const capture = await startBrowserCapture({ fps: 20, microphone: false, systemAudio: false })
      capture.setMuted(true)
      const state = { available: capture.audioAvailable, muted: capture.muted, phase: capture.phase }
      await new Promise(resolve => setTimeout(resolve, 250))
      await capture.stop()
      return state
    }, source)
    assert.deepEqual(silentSource, { available: false, muted: false, phase: 'recording' })
    console.log('PASS recording without an authorized audio source keeps mute unavailable and never opens a microphone')
    for (const sharedAudio of [false, true]) {
      const dynamic = await page.evaluate(async ({ source, sharedAudio }) => {
        const { startBrowserCapture } = await import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}`)
        const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
        const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90
        const painter = canvas.getContext('2d')
        let frame = 0
        const render = setInterval(() => { painter.fillStyle = frame++ % 2 ? 'green' : 'blue'; painter.fillRect(0, 0, 160, 90) }, 50)
        const screen = canvas.captureStream(20)
        const contexts = []
        const tone = frequency => {
          const context = new AudioContext()
          const oscillator = context.createOscillator(); oscillator.frequency.value = frequency
          const gain = context.createGain(); gain.gain.value = 0.1
          const destination = context.createMediaStreamDestination()
          oscillator.connect(gain).connect(destination); oscillator.start()
          contexts.push(context)
          return destination.stream
        }
        const shared = sharedAudio ? tone(440).getAudioTracks()[0] : undefined
        if (shared) screen.addTrack(shared)
        let microphoneRequests = 0
        const microphoneConstraints = []
        let microphone
        Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => screen })
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async constraints => { microphoneRequests++; microphoneConstraints.push(constraints); return (microphone = tone(660)) } })
        const capture = await startBrowserCapture({ fps: 20, microphone: true, systemAudio: sharedAudio, audioDevice: 'previous-microphone', chooseSource: async () => ({ microphone: false, audioDevice: 'headset-microphone' }) })
        const trackIds = capture.stream.getTracks().map(track => track.id)
        const initial = { enabled: capture.microphoneEnabled, requests: microphoneRequests, available: capture.audioAvailable }
        await sleep(1100)
        capture.pause()
        const pausedAt = capture.elapsed
        await capture.setMicrophoneEnabled(true)
        await sleep(150)
        const paused = { enabled: capture.microphoneEnabled, phase: capture.phase, elapsed: capture.elapsed }
        capture.resume()
        const enableAt = capture.elapsed
        await sleep(1100)
        await capture.setMicrophoneEnabled(false)
        const disableAt = capture.elapsed
        const disabled = { enabled: capture.microphoneEnabled, available: capture.audioAvailable,
          released: microphone.getTracks().every(track => track.readyState === 'ended'), sharedLive: !shared || shared.readyState === 'live' && shared.enabled }
        const unchangedTracks = JSON.stringify(trackIds) === JSON.stringify(capture.stream.getTracks().map(track => track.id))
        await sleep(1100)
        const recording = await capture.stop()
        const ended = screen.getTracks().every(track => track.readyState === 'ended')
        clearInterval(render)
        await Promise.all(contexts.map(context => context.close()))
        return { initial, pausedAt, paused, enableAt, disableAt, disabled, unchangedTracks, ended, requests: microphoneRequests, microphoneConstraints,
          duration: recording.duration, bytes: Array.from(new Uint8Array(await recording.blob.arrayBuffer())) }
      }, { source, sharedAudio })
      assert.deepEqual(dynamic.initial, { enabled: false, requests: 0, available: sharedAudio }, 'picker can disable the initially selected microphone before any request')
      assert.deepEqual(dynamic.paused, { enabled: true, phase: 'paused', elapsed: dynamic.pausedAt }, 'microphone can be enabled while paused without advancing elapsed time')
      assert.deepEqual(dynamic.disabled, { enabled: false, available: sharedAudio, released: true, sharedLive: true }, 'turning off releases the microphone and preserves shared audio')
      assert.equal(dynamic.requests, 1)
      assert.deepEqual(dynamic.microphoneConstraints, [{ audio: { echoCancellation: true, noiseSuppression: true, deviceId: { exact: 'headset-microphone' } }, video: false }], 'picker source overrides the previous device and is retained when enabling the microphone later')
      assert.equal(dynamic.unchangedTracks, true, 'dynamic microphone never changes encoder tracks')
      assert.equal(dynamic.ended, true)
      assert.ok(dynamic.duration > 3.1 && dynamic.duration < 4.2)
      const file = join(directory, `dynamic-${sharedAudio ? 'shared' : 'silent'}.webm`)
      writeFileSync(file, Buffer.from(dynamic.bytes))
      const levels = [rms(file, 0.3, 0.7), rms(file, dynamic.enableAt + 0.35, dynamic.enableAt + 0.7), rms(file, dynamic.disableAt + 0.35, dynamic.disableAt + 0.7)]
      if (sharedAudio) {
        assert.ok(levels[0] > 0.03 && levels[2] > 0.03, JSON.stringify(levels))
        assert.ok(Math.abs(levels[0] - levels[2]) < 0.015, 'shared audio level remains stable after microphone removal')
        assert.ok(levels[1] > levels[0] * 1.25, JSON.stringify(levels))
      } else {
        assert.ok(levels[0] < 0.00001 && levels[2] < 0.00001, JSON.stringify(levels))
        assert.ok(levels[1] > 0.03, JSON.stringify(levels))
      }
      const frames = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file], { encoding: 'utf8' })).frames
      assert.ok(frames.length > 45, 'encoded video continues across microphone changes')
      for (let i = 1; i < frames.length; i++) assert.ok(Number(frames[i].best_effort_timestamp_time) - Number(frames[i - 1].best_effort_timestamp_time) < 0.35, 'video has no microphone-related gap')
      console.log(`PASS actual dynamic microphone recording (${sharedAudio ? 'shared audio preserved' : 'initial silence'}): picker override, paused enable, released device, stable encoder track`, levels)
    }
    const sourceSelection = await page.evaluate(async source => {
      const { startBrowserCapture, captureErrorMessage } = await import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}`)
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const screens = []
      const requests = []
      const microphones = []
      const context = new AudioContext()
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
        const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90
        canvas.getContext('2d').fillRect(0, 0, 160, 90)
        const stream = canvas.captureStream(20); screens.push(stream); return stream
      } })
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async constraints => {
        requests.push(constraints)
        if (constraints.audio.deviceId?.exact === 'disconnected-microphone') throw new DOMException('Missing selected input', 'OverconstrainedError')
        const stream = context.createMediaStreamDestination().stream; microphones.push(stream); return stream
      } })
      try {
        let initialError
        try { await startBrowserCapture({ fps: 20, microphone: true, systemAudio: false, audioDevice: 'disconnected-microphone' }) }
        catch (error) { initialError = { name: error.name, message: captureErrorMessage(error) } }
        const initial = { error: initialError, requests: requests.length, screenReleased: screens[0].getTracks().every(track => track.readyState === 'ended') }
        const capture = await startBrowserCapture({ fps: 20, microphone: false, systemAudio: false, audioDevice: 'disconnected-microphone' })
        let laterError
        try { await capture.setMicrophoneEnabled(true) } catch (error) { laterError = { name: error.name, message: captureErrorMessage(error) } }
        const later = { error: laterError, requests: requests.length, microphoneEnabled: capture.microphoneEnabled, phase: capture.phase }
        await sleep(250)
        const retained = await capture.stop()
        const defaultCapture = await startBrowserCapture({ fps: 20, microphone: false, systemAudio: false, audioDevice: 'previous-microphone', chooseSource: async () => ({ microphone: true, audioDevice: '' }) })
        await sleep(100)
        await defaultCapture.setMicrophoneEnabled(false)
        await defaultCapture.setMicrophoneEnabled(true)
        await sleep(150)
        const defaultRecording = await defaultCapture.stop()
        return { initial, later, requests, retainedBytes: retained.blob.size, defaultBytes: defaultRecording.blob.size,
          released: [...screens, ...microphones].every(stream => stream.getTracks().every(track => track.readyState === 'ended')) }
      } finally { await context.close() }
    }, source)
    assert.equal(sourceSelection.initial.error.name, 'OverconstrainedError')
    assert.match(sourceSelection.initial.error.message, /所选麦克风当前不可用/)
    assert.equal(sourceSelection.initial.requests, 1, 'unavailable selected source does not fall back to any other input')
    assert.equal(sourceSelection.initial.screenReleased, true, 'failed preparation releases the screen')
    assert.equal(sourceSelection.later.error.name, 'OverconstrainedError')
    assert.equal(sourceSelection.later.requests, 2, 'later enabling also makes only one exact-source request')
    assert.equal(sourceSelection.later.microphoneEnabled, false)
    assert.equal(sourceSelection.later.phase, 'recording', 'unavailable microphone leaves the current silent video usable')
    assert.deepEqual(sourceSelection.requests.map(value => value.audio.deviceId), [{ exact: 'disconnected-microphone' }, { exact: 'disconnected-microphone' }, undefined, undefined])
    assert.ok(sourceSelection.retainedBytes > 0 && sourceSelection.defaultBytes > 0)
    assert.equal(sourceSelection.released, true)
    console.log('PASS disconnected selected microphone never falls back; explicit system default overrides remembered source and survives off/on; failure preserves silent recording')
    const lifecycle = await page.evaluate(async source => {
      const { startBrowserCapture } = await import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}`)
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90
      const painter = canvas.getContext('2d'); let frame = 0
      const render = setInterval(() => { painter.fillStyle = frame++ % 2 ? 'red' : 'blue'; painter.fillRect(0, 0, 160, 90) }, 50)
      const screen = canvas.captureStream(20)
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => screen })
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { throw new DOMException('Denied', 'NotAllowedError') } })
      const capture = await startBrowserCapture({ fps: 20, microphone: false, systemAudio: false })
      const denied = await capture.setMicrophoneEnabled(true).then(() => '', error => error.name)
      const afterDenied = { enabled: capture.microphoneEnabled, available: capture.audioAvailable, phase: capture.phase }
      const context = new AudioContext()
      const lateStreams = []
      const deferred = () => { const destination = context.createMediaStreamDestination(); lateStreams.push(destination.stream); return destination.stream }
      let grant
      let requests = 0
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => { requests++; return new Promise(resolve => { grant = resolve }) } })
      const pendingOff = capture.setMicrophoneEnabled(true).then(() => 'resolved', error => error.name)
      await sleep(30)
      await capture.setMicrophoneEnabled(false)
      const offCancelled = await pendingOff
      grant(deferred())
      await sleep(30)
      const afterOff = { enabled: capture.microphoneEnabled, phase: capture.phase, released: lateStreams[0].getTracks().every(track => track.readyState === 'ended') }
      // A cancelled request does not poison the queue: a later enable can succeed.
      const retry = capture.setMicrophoneEnabled(true)
      await sleep(30)
      const duplicate = capture.setMicrophoneEnabled(true)
      const reusedRequest = retry === duplicate
      grant(deferred()); await Promise.all([retry, duplicate])
      const afterRetry = capture.microphoneEnabled
      await capture.setMicrophoneEnabled(false)
      const pendingStop = capture.setMicrophoneEnabled(true).then(() => 'resolved', error => error.name)
      await sleep(100)
      const recording = await capture.stop()
      const stopCancelled = await pendingStop
      grant(deferred())
      await sleep(30)
      const afterStop = { enabled: capture.microphoneEnabled, available: capture.audioAvailable, phase: capture.phase,
        released: lateStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')) }
      clearInterval(render); await context.close()
      return { denied, afterDenied, offCancelled, afterOff, afterRetry, reusedRequest, stopCancelled, afterStop, requests, recordedBytes: recording.blob.size }
    }, source)
    assert.equal(lifecycle.denied, 'NotAllowedError')
    assert.deepEqual(lifecycle.afterDenied, { enabled: false, available: false, phase: 'recording' })
    assert.equal(lifecycle.offCancelled, 'AbortError')
    assert.deepEqual(lifecycle.afterOff, { enabled: false, phase: 'recording', released: true })
    assert.equal(lifecycle.afterRetry, true)
    assert.equal(lifecycle.reusedRequest, true, 'repeated enable reuses the pending permission request')
    assert.equal(lifecycle.stopCancelled, 'AbortError')
    assert.deepEqual(lifecycle.afterStop, { enabled: false, available: false, phase: 'stopped', released: true })
    assert.equal(lifecycle.requests, 3)
    assert.ok(lifecycle.recordedBytes > 0)
    console.log('PASS denied microphone leaves video recording alive; off/stop cancel pending requests and release late devices; retry succeeds')
  } finally { await browser.close() }
}

async function encoderCommands(directory) {
  const file = join(directory, 'encoder.mkv')
  const child = spawn('ffmpeg', ['-hide_banner', '-y', '-loglevel', 'warning',
    '-re', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10',
    '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '6', '-af', 'volume@capture_volume=1', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', file], { stdio: ['pipe', 'ignore', 'pipe'] })
  let logs = ''
  child.stderr.on('data', data => { logs += data })
  const finished = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(logs))) })
  void finished.catch(() => {})
  try {
    await wait(2000); child.stdin.write('cvolume@capture_volume -1 volume 0\n')
    await wait(2000); child.stdin.write('cvolume@capture_volume -1 volume 1\n')
    await finished
    const levels = [rms(file, 0.5, 1), rms(file, 2.8, 3.3), rms(file, 4.8, 5.3)]
    assert.ok(levels[0] > 0.03 && levels[2] > 0.03, JSON.stringify(levels))
    assert.ok(levels[1] < 0.00001, JSON.stringify(levels))
    const frames = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file], { encoding: 'utf8' })).frames
    assert.equal(frames.length, 60, 'muting preserves all six seconds of video')
    for (let i = 1; i < frames.length; i++) assert.ok(Math.abs(Number(frames[i].best_effort_timestamp_time) - Number(frames[i - 1].best_effort_timestamp_time) - 0.1) < 0.005)
    console.log('PASS actual encoder stdin commands: decoded audio -> silence -> audio, continuous video timestamps', levels)
  } finally { if (child.exitCode === null) child.kill('SIGKILL') }
}

async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'open-media-capture-mute-'))
  try { await browserRecording(directory); await encoderCommands(directory) }
  finally { rmSync(directory, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
