const assert = require('node:assert/strict')
const { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync, execFileSync } = require('node:child_process')
const { chromium } = require('@playwright/test')
const ts = require('typescript')

const root = join(__dirname, '../..')
const source = name => ts.transpileModule(readFileSync(join(root, `src/core/${name}.ts`), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const decoder = spawnSync('ffprobe', ['-version']).status === 0

async function run() {
  const directory = mkdtempSync(join(tmpdir(), 'open-media-capture-'))
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'] })
  try {
    const page = await browser.newPage()
    await page.route('http://localhost/media-test', route => route.fulfill({ body: '<!doctype html><title>Media test</title>', contentType: 'text/html' }))
    await page.goto('http://localhost/media-test')
    await page.evaluate(async modules => {
      window.capture = await import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(modules.capture)))}`)
      window.gif = await import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(modules.gif)))}`)
      window.mediaImport = await import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(modules.mediaImport)))}`)
      window.createSource = () => {
        const canvas = document.createElement('canvas')
        canvas.width = 320; canvas.height = 180
        const context = canvas.getContext('2d')
        let frame = 0
        const paint = () => { context.fillStyle = frame++ % 2 ? '#ff0000' : '#0000ff'; context.fillRect(0, 0, 320, 180); context.fillStyle = '#ffffff'; context.fillRect(frame % 100, 50, 24, 24) }
        paint()
        const timer = setInterval(paint, 65)
        const stream = canvas.captureStream(15)
        window.streams = [stream]
        window.audioContexts = []
        const makeAudio = () => {
          const context = new AudioContext()
          const oscillator = context.createOscillator()
          const destination = context.createMediaStreamDestination()
          oscillator.connect(destination); oscillator.start()
          window.audioContexts.push(context)
          window.streams.push(destination.stream)
          return destination.stream
        }
        const screenAudio = makeAudio()
        stream.addTrack(screenAudio.getAudioTracks()[0])
        window.screenStream = stream
        window.cleanupSource = () => { clearInterval(timer); window.streams.flatMap(item => item.getTracks()).forEach(track => track.stop()); window.audioContexts.forEach(context => context.close()) }
        Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => stream })
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => makeAudio() })
      }
      window.createPatternSource = (width, height, surface) => {
        const canvas = document.createElement('canvas')
        canvas.width = width; canvas.height = height
        const context = canvas.getContext('2d')
        const paint = () => {
          context.fillStyle = '#ff0000'; context.fillRect(0, 0, canvas.width / 2, canvas.height)
          context.fillStyle = '#0000ff'; context.fillRect(canvas.width / 2, 0, canvas.width / 2, canvas.height)
        }
        paint()
        const timer = setInterval(paint, 50)
        const stream = canvas.captureStream(20)
        const track = stream.getVideoTracks()[0]
        const settings = track.getSettings.bind(track)
        Object.defineProperty(track, 'getSettings', { configurable: true, value: () => ({ ...settings(), displaySurface: surface }) })
        window.screenStream = stream
        window.resizePatternSource = (nextWidth, nextHeight) => { canvas.width = nextWidth; canvas.height = nextHeight; paint() }
        window.lastDisplayConstraints = undefined
        Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: constraints => { window.lastDisplayConstraints = constraints; return Promise.resolve(stream) } })
        window.cleanupSource = () => { clearInterval(timer); stream.getTracks().forEach(track => track.stop()) }
      }
      window.createdCaptureVideos = []
      const createElement = document.createElement.bind(document)
      document.createElement = (tag, ...args) => {
        const element = createElement(tag, ...args)
        if (tag === 'video') window.createdCaptureVideos.push(element)
        return element
      }
    }, { capture: source('capture'), gif: source('gif'), mediaImport: source('media-import') })

    const recording = await page.evaluate(async () => {
      window.createSource()
      let finished = 0
      const capture = await window.capture.startBrowserCapture({ fps: 15, microphone: true, systemAudio: true, onFinished: () => finished++ })
      await new Promise(resolve => setTimeout(resolve, 500))
      capture.pause()
      const before = capture.elapsed
      await new Promise(resolve => setTimeout(resolve, 250))
      const after = capture.elapsed
      capture.resume()
      await new Promise(resolve => setTimeout(resolve, 500))
      const output = await capture.stop()
      const repeated = await capture.stop()
      const stopped = window.streams.flatMap(item => item.getTracks()).every(track => track.readyState === 'ended')
      window.savedBlob = output.blob
      window.savedDuration = output.duration
      const imported = await window.mediaImport.importMediaFile(new File([output.blob], output.name, { type: output.mime }))
      const importedMetadata = { width: imported.width, height: imported.height, duration: imported.duration }
      window.mediaImport.revokeMediaAsset(imported)
      window.cleanupSource()
      return { size: output.blob.size, duration: output.duration, mime: output.mime, bytes: Array.from(new Uint8Array(await output.blob.arrayBuffer())), before, after, stopped, finished, repeated: repeated.blob === output.blob, importedMetadata, originalVideoTrack: capture.stream.getVideoTracks()[0] === window.screenStream.getVideoTracks()[0] }
    })
    assert.ok(recording.size > 1000)
    assert.ok(recording.duration >= 0.85 && recording.duration < 1.4)
    assert.equal(recording.before, recording.after)
    assert.equal(recording.stopped, true)
    assert.equal(recording.finished, 1)
    assert.equal(recording.repeated, true)
    assert.equal(recording.originalVideoTrack, true, 'original-size recording preserves the selected source stream')
    assert.equal(recording.importedMetadata.width, 320)
    assert.equal(recording.importedMetadata.height, 180)
    assert.ok(Number.isFinite(recording.importedMetadata.duration) && recording.importedMetadata.duration > 0.5)
    if (decoder) {
      const file = join(directory, 'capture.webm')
      writeFileSync(file, Buffer.from(recording.bytes))
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }))
      assert.ok(probe.streams.some(stream => stream.codec_type === 'video' && stream.width === 320 && stream.height === 180))
      assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'))
    }
    console.log('PASS real recording, mixed audio, pause clock, stop idempotency and released tracks')

    const ended = await page.evaluate(async () => {
      window.createSource()
      let finished, failed
      const promise = new Promise((resolve, reject) => { finished = resolve; failed = reject })
      const capture = await window.capture.startBrowserCapture({ fps: 15, microphone: false, systemAudio: false, onFinished: finished, onError: failed })
      await new Promise(resolve => setTimeout(resolve, 1000))
      window.screenStream.getVideoTracks()[0].dispatchEvent(new Event('ended'))
      const output = await Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Source stop did not finalize within 10 seconds')), 10000))])
      const stopped = window.screenStream.getTracks().every(track => track.readyState === 'ended')
      window.cleanupSource()
      return { phase: capture.phase, stopped, size: output.blob.size }
    })
    assert.equal(ended.phase, 'stopped'); assert.equal(ended.stopped, true); assert.ok(ended.size > 0)
    console.log('PASS external source stop finalizes recording')

    const cleanup = await page.evaluate(async () => {
      window.createSource()
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { throw new DOMException('denied', 'NotAllowedError') } })
      let denied = false
      try { await window.capture.startBrowserCapture({ fps: 15, microphone: true, systemAudio: false }) } catch (error) { denied = error.name === 'NotAllowedError' }
      const deniedStopped = window.screenStream.getTracks().every(track => track.readyState === 'ended')
      window.cleanupSource()
      window.createSource()
      const abort = new AbortController()
      setTimeout(() => abort.abort(), 80)
      let cancelled = false
      try { await window.capture.startBrowserCapture({ fps: 15, microphone: false, systemAudio: false, countdown: 3, signal: abort.signal }) } catch (error) { cancelled = error.name === 'AbortError' }
      const cancelledStopped = window.screenStream.getTracks().every(track => track.readyState === 'ended')
      window.cleanupSource()
      return { denied, deniedStopped, cancelled, cancelledStopped }
    })
    assert.deepEqual(cleanup, { denied: true, deniedStopped: true, cancelled: true, cancelledStopped: true })
    console.log('PASS denied microphone and cancelled countdown release screen capture')

    const selected = await page.evaluate(async () => {
      window.createPatternSource(320, 180, 'monitor')
      const OriginalRecorder = window.MediaRecorder
      let encoders = 0, microphoneRequests = 0, countdowns = 0
      window.MediaRecorder = class extends OriginalRecorder { constructor(...args) { super(...args); encoders++ } }
      const audioContext = new AudioContext()
      const oscillator = audioContext.createOscillator()
      const destination = audioContext.createMediaStreamDestination()
      oscillator.connect(destination); oscillator.start()
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { microphoneRequests++; return destination.stream } })
      let select, request, ready
      const opened = new Promise(resolve => { ready = resolve })
      try {
        const pending = window.capture.startBrowserCapture({
          fps: 20, microphone: true, systemAudio: false, sourceType: 'region',
          onCountdown: () => countdowns++,
          chooseSource: context => { request = context; ready(); return new Promise(resolve => { select = resolve }) },
        })
        const requestedSynchronously = !!window.lastDisplayConstraints
        await opened
        await new Promise(resolve => setTimeout(resolve, 350))
        const waiting = { encoders, microphoneRequests, countdowns, sameStream: request.stream === window.screenStream, live: request.stream.getVideoTracks()[0].readyState === 'live', source: request.source }
        select({ region: { x: 160, y: 0, width: 160, height: 180 }, outputSize: { width: 160, height: 180 } })
        const capture = await pending
        await new Promise(resolve => setTimeout(resolve, 500))
        const recording = await capture.stop()
        return { requestedSynchronously, waiting, encoders, microphoneRequests, duration: recording.duration, source: capture.source, bytes: Array.from(new Uint8Array(await recording.blob.arrayBuffer())), stopped: window.screenStream.getTracks().every(track => track.readyState === 'ended') && destination.stream.getTracks().every(track => track.readyState === 'ended'), videoReleased: window.createdCaptureVideos.every(video => video.srcObject === null && video.paused) }
      } finally { window.MediaRecorder = OriginalRecorder; window.cleanupSource(); await audioContext.close() }
    })
    assert.equal(selected.requestedSynchronously, true)
    assert.equal(selected.waiting.encoders, 0); assert.equal(selected.waiting.microphoneRequests, 0); assert.equal(selected.waiting.countdowns, 0)
    assert.equal(selected.waiting.sameStream, true); assert.equal(selected.waiting.live, true)
    assert.equal(selected.waiting.source.type, 'screen'); assert.equal(selected.waiting.source.width, 320); assert.equal(selected.waiting.source.height, 180)
    assert.equal(selected.encoders, 1); assert.equal(selected.microphoneRequests, 1)
    assert.ok(selected.duration >= 0.4 && selected.duration < 0.75, 'choosing the area is excluded from recorded time')
    assert.deepEqual(selected.source.region, { x: 160, y: 0, width: 160, height: 180 })
    assert.equal(selected.stopped, true); assert.equal(selected.videoReleased, true)
    if (decoder) {
      const file = join(directory, 'selected-area.webm')
      writeFileSync(file, Buffer.from(selected.bytes))
      const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' })).streams
      assert.ok(streams.some(stream => stream.codec_type === 'video' && stream.width === 160 && stream.height === 180))
      assert.ok(streams.some(stream => stream.codec_type === 'audio'))
      const pixels = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
      for (const offset of [0, (90 * 160 + 80) * 3, (179 * 160 + 159) * 3]) assert.ok(pixels[offset + 2] > 220 && pixels[offset] < 25 && pixels[offset + 1] < 25, 'confirmed area is the blue half of the actual source')
    }
    console.log('PASS interactive selection waits for confirmation before microphone, countdown and encoding; confirmed crop produces real video')

    const selectionCancelled = await page.evaluate(async () => {
      const results = []
      for (const action of ['abort', 'ended', 'cancel', 'invalid-output', 'invalid-region', 'window-region']) {
        window.createPatternSource(320, 180, action === 'window-region' ? 'window' : 'monitor')
        const OriginalRecorder = window.MediaRecorder
        let encoders = 0, microphoneRequests = 0, request, choose, ready
        window.MediaRecorder = class extends OriginalRecorder { constructor(...args) { super(...args); encoders++ } }
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { microphoneRequests++; throw new Error('Microphone must wait for valid confirmation') } })
        const abort = new AbortController()
        const opened = new Promise(resolve => { ready = resolve })
        try {
          const pending = window.capture.startBrowserCapture({ fps: 20, microphone: true, systemAudio: false, signal: abort.signal, chooseSource: context => { request = context; ready(); return new Promise(resolve => { choose = resolve }) } })
          const failed = pending.then(() => ({ unexpected: true }), error => ({ name: error.name, message: error.message }))
          await opened
          if (action === 'abort') abort.abort()
          else if (action === 'ended') window.screenStream.getVideoTracks()[0].dispatchEvent(new Event('ended'))
          else if (action === 'invalid-output') choose({ outputSize: { width: 63, height: 64 } })
          else if (action === 'invalid-region') choose({ region: { x: 319, y: 0, width: 160, height: 90 } })
          else if (action === 'window-region') choose({ region: { x: 0, y: 0, width: 160, height: 90 } })
          else choose(null)
          const error = await Promise.race([failed, new Promise((_, reject) => setTimeout(() => reject(new Error('Pending area selection did not cancel within 1 second')), 1000))])
          choose({ outputSize: { width: 160, height: 90 } })
          await new Promise(resolve => setTimeout(resolve, 10))
          results.push({ action, ...error, encoders, microphoneRequests, aborted: request.signal.aborted, stopped: window.screenStream.getTracks().every(track => track.readyState === 'ended'), videoReleased: window.createdCaptureVideos.every(video => video.srcObject === null && video.paused) })
        } finally { window.MediaRecorder = OriginalRecorder; window.cleanupSource() }
      }
      return results
    })
    for (const item of selectionCancelled) {
      assert.equal(item.encoders, 0); assert.equal(item.microphoneRequests, 0); assert.equal(item.aborted, true); assert.equal(item.stopped, true); assert.equal(item.videoReleased, true)
      if (['abort', 'cancel'].includes(item.action)) assert.equal(item.name, 'AbortError')
      else if (item.action === 'ended') assert.match(item.message, /屏幕共享已结束/)
      else if (item.action === 'invalid-output') assert.match(item.message, /偶数/)
      else if (item.action === 'invalid-region') assert.match(item.message, /超出所选屏幕范围/)
      else assert.match(item.message, /需要选择整个屏幕/)
    }
    console.log('PASS cancelled or ended area selection closes promptly and releases capture without creating an encoder or microphone')

    const latePermission = await page.evaluate(async () => {
      window.createPatternSource(320, 180, 'monitor')
      let grant, opened = false
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: () => new Promise(resolve => { grant = resolve }) })
      const abort = new AbortController()
      const pending = window.capture.startBrowserCapture({ fps: 20, microphone: false, systemAudio: false, signal: abort.signal, chooseSource: async () => { opened = true; return {} } })
      const failed = pending.then(() => false, error => error.name === 'AbortError')
      abort.abort()
      const cancelled = await Promise.race([failed, new Promise((_, reject) => setTimeout(() => reject(new Error('Pending source permission did not cancel within 1 second')), 1000))])
      grant(window.screenStream)
      await new Promise(resolve => setTimeout(resolve, 10))
      const stopped = window.screenStream.getTracks().every(track => track.readyState === 'ended')
      window.cleanupSource()
      return { cancelled, opened, stopped }
    })
    assert.deepEqual(latePermission, { cancelled: true, opened: false, stopped: true })
    console.log('PASS cancelling before system source permission resolves also releases any late stream')

    const transformed = await page.evaluate(async () => {
      const cases = [
        { width: 320, height: 180, surface: 'monitor', options: { sourceType: 'region', region: { x: 160, y: 0, width: 160, height: 180 }, outputSize: { width: 160, height: 180 } } },
        { width: 320, height: 180, surface: 'window', options: { sourceType: 'window', outputSize: { width: 128, height: 128 } } },
        { width: 180, height: 320, surface: 'monitor', options: { sourceType: 'screen', outputSize: { width: 160, height: 90 } } },
      ]
      const results = []
      for (const item of cases) {
        window.createPatternSource(item.width, item.height, item.surface)
        const pending = window.capture.startBrowserCapture({ fps: 20, microphone: false, systemAudio: false, ...item.options })
        const requestedSynchronously = !!window.lastDisplayConstraints
        const capture = await pending
        await new Promise(resolve => setTimeout(resolve, 650))
        const output = await capture.stop()
        results.push({ source: capture.source, requestedSynchronously, constraints: window.lastDisplayConstraints, bytes: Array.from(new Uint8Array(await output.blob.arrayBuffer())), sourceStopped: window.screenStream.getTracks().every(track => track.readyState === 'ended'), outputStopped: capture.stream.getTracks().every(track => track.readyState === 'ended'), videoReleased: window.createdCaptureVideos.every(video => video.srcObject === null && video.paused) })
        window.cleanupSource()
      }
      return results
    })
    for (let index = 0; index < transformed.length; index++) {
      const item = transformed[index]
      assert.equal(item.requestedSynchronously, true, 'screen selection retains click activation')
      assert.equal(item.sourceStopped, true); assert.equal(item.outputStopped, true); assert.equal(item.videoReleased, true)
      assert.equal(item.constraints.video.displaySurface, index === 1 ? 'window' : 'monitor')
      assert.equal(item.source.type, index === 1 ? 'window' : 'screen')
      if (decoder) {
        const file = join(directory, `transformed-${index}.webm`)
        writeFileSync(file, Buffer.from(item.bytes))
        const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' })).streams[0]
        assert.equal(probe.width, item.source.outputWidth); assert.equal(probe.height, item.source.outputHeight)
        const pixels = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
        const pixel = (x, y) => [...pixels.subarray((y * probe.width + x) * 3, (y * probe.width + x) * 3 + 3)]
        const blue = color => color[2] > 220 && color[0] < 25 && color[1] < 25
        const red = color => color[0] > 220 && color[1] < 25 && color[2] < 25
        const black = color => color.every(value => value < 15)
        if (index === 0) {
          assert.ok(blue(pixel(2, 2)) && blue(pixel(80, 90)) && blue(pixel(157, 177)), 'crop contains only selected blue half, with no red outline burned into output')
          assert.deepEqual(item.source.region, { x: 160, y: 0, width: 160, height: 180 })
        } else if (index === 1) {
          assert.ok(black(pixel(64, 4)) && black(pixel(64, 124)), 'wide source preserves aspect with top and bottom padding')
          assert.ok(red(pixel(20, 64)) && blue(pixel(108, 64)))
        } else {
          assert.ok(black(pixel(4, 45)) && black(pixel(156, 45)), 'portrait source preserves aspect with side padding')
          assert.ok(red(pixel(65, 45)) && blue(pixel(95, 45)))
        }
      }
    }
    console.log('PASS actual window selection metadata, cropped pixels, portrait scaling, fixed output sizes and transform cleanup')

    const resized = await page.evaluate(async () => {
      const results = []
      for (const outputSize of [undefined, { width: 128, height: 128 }]) {
        window.createPatternSource(320, 180, 'window')
        const capture = await window.capture.startBrowserCapture({ fps: 20, microphone: false, systemAudio: false, sourceType: 'window', outputSize })
        const initial = capture.source
        await new Promise(resolve => setTimeout(resolve, 200))
        window.resizePatternSource(180, 320)
        let current
        const deadline = performance.now() + 2000
        do { await new Promise(resolve => setTimeout(resolve, 50)); current = capture.source } while ((current.width !== 180 || current.height !== 320) && performance.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 250))
        const output = await capture.stop()
        results.push({ initial, current, bytes: Array.from(new Uint8Array(await output.blob.arrayBuffer())), stopped: capture.stream.getTracks().every(track => track.readyState === 'ended') && window.screenStream.getTracks().every(track => track.readyState === 'ended'), videoReleased: window.createdCaptureVideos.every(video => video.srcObject === null && video.paused) })
        window.cleanupSource()
      }
      return results
    })
    for (let index = 0; index < resized.length; index++) {
      const item = resized[index]
      assert.equal(item.initial.width, 320); assert.equal(item.initial.height, 180)
      assert.equal(item.current.width, 180); assert.equal(item.current.height, 320)
      assert.equal(item.current.outputWidth, index ? 128 : 180); assert.equal(item.current.outputHeight, index ? 128 : 320)
      assert.equal(item.stopped, true); assert.equal(item.videoReleased, true)
      if (decoder && index) {
        const file = join(directory, 'resized-fixed.webm')
        writeFileSync(file, Buffer.from(item.bytes))
        const frames = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=width,height', '-of', 'json', file], { encoding: 'utf8' })).frames
        assert.ok(frames.length > 4)
        assert.ok(frames.every(frame => frame.width === 128 && frame.height === 128), 'window resize preserves the selected output dimensions in every encoded frame')
      }
    }
    console.log('PASS live source dimensions follow window resizing while fixed-size recording remains stable')

    const still = await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 320; canvas.height = 180
      const context = canvas.getContext('2d')
      const stream = canvas.captureStream(0)
      const track = stream.getVideoTracks()[0]
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: () => Promise.resolve(stream) })
      setTimeout(() => { context.fillStyle = '#0000ff'; context.fillRect(0, 0, 320, 180); track.requestFrame() }, 100)
      const capture = await window.capture.startBrowserCapture({ fps: 20, microphone: false, systemAudio: false, outputSize: { width: 160, height: 90 } })
      await new Promise(resolve => setTimeout(resolve, 1000))
      capture.pause()
      const pausedAt = capture.elapsed
      await new Promise(resolve => setTimeout(resolve, 600))
      const afterPause = capture.elapsed
      capture.resume()
      await new Promise(resolve => setTimeout(resolve, 2000))
      const output = await capture.stop()
      return { bytes: Array.from(new Uint8Array(await output.blob.arrayBuffer())), duration: output.duration, pausedAt, afterPause, stopped: stream.getTracks().every(track => track.readyState === 'ended') && capture.stream.getTracks().every(track => track.readyState === 'ended'), videoReleased: window.createdCaptureVideos.every(video => video.srcObject === null && video.paused) }
    })
    assert.ok(still.duration > 2.85 && still.duration < 3.2)
    assert.equal(still.pausedAt, still.afterPause)
    assert.equal(still.stopped, true); assert.equal(still.videoReleased, true)
    if (decoder) {
      const file = join(directory, 'still-recording.webm')
      writeFileSync(file, Buffer.from(still.bytes))
      const packets = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'json', file], { encoding: 'utf8' })).packets
      const ending = Math.max(...packets.map(packet => Number(packet.pts_time)))
      assert.ok(packets.length > 30, 'a completely static source still produces regular output frames')
      assert.ok(ending > still.duration - 0.2 && ending < still.duration + 0.15, `static ending ${ending} must follow recording time ${still.duration}, excluding the pause`)
    }
    console.log('PASS static source keeps its complete recorded duration and excludes paused time')

    const rejected = await page.evaluate(async () => {
      const results = []
      for (const item of [
        { surface: 'window', region: { x: 0, y: 0, width: 160, height: 90 } },
        { surface: 'browser', region: { x: 0, y: 0, width: 160, height: 90 } },
        { surface: undefined, region: { x: 0, y: 0, width: 160, height: 90 } },
        { surface: 'monitor', region: { x: 300, y: 0, width: 160, height: 90 } },
        { surface: 'monitor', region: { x: -1, y: 0, width: 160, height: 90 } },
      ]) {
        window.createPatternSource(320, 180, item.surface)
        let error
        try { await window.capture.startBrowserCapture({ fps: 20, microphone: false, systemAudio: false, sourceType: 'region', region: item.region }) }
        catch (reason) { error = reason.message }
        results.push({ error, stopped: window.screenStream.getTracks().every(track => track.readyState === 'ended') })
        window.cleanupSource()
      }
      window.createPatternSource(320, 180, 'monitor')
      const abort = new AbortController()
      setTimeout(() => abort.abort(), 150)
      let cancelled = false
      try { await window.capture.startBrowserCapture({ fps: 20, microphone: false, systemAudio: false, outputSize: { width: 160, height: 90 }, countdown: 3, signal: abort.signal }) }
      catch (reason) { cancelled = reason.name === 'AbortError' }
      const cancelledStopped = window.screenStream.getTracks().every(track => track.readyState === 'ended')
      const videosReleased = window.createdCaptureVideos.every(video => video.srcObject === null && video.paused)
      window.cleanupSource()
      return { results, cancelled, cancelledStopped, videosReleased }
    })
    assert.ok(rejected.results.slice(0, 3).every(item => /需要选择整个屏幕/.test(item.error) && item.stopped))
    assert.ok(rejected.results.slice(3).every(item => /超出所选屏幕范围/.test(item.error) && item.stopped))
    assert.equal(rejected.cancelled, true); assert.equal(rejected.cancelledStopped, true); assert.equal(rejected.videosReleased, true)
    console.log('PASS mismatched screen selection and out-of-bounds regions fail safely; cancelling transformed capture releases resources')

    const gif = await page.evaluate(async () => {
      const url = URL.createObjectURL(window.savedBlob)
      try {
        const progress = []
        const blob = await window.gif.createVideoGif(url, window.savedDuration, [{ start: 0.5, end: 0.8 }, { start: 0.1, end: 0.4 }], { width: 160, fps: 10, loop: true, quality: 'fast', onProgress: value => progress.push(value) })
        return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), progress }
      } finally { URL.revokeObjectURL(url) }
    })
    assert.equal(gif.progress.at(-1), 1)
    assert.ok(gif.progress.every((value, index, values) => !index || value > values[index - 1]))
    if (decoder) {
      const file = join(directory, 'segments.gif')
      writeFileSync(file, Buffer.from(gif.bytes))
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }))
      assert.equal(probe.streams[0].width, 160); assert.equal(probe.streams[0].height, 90)
      assert.equal(Number(probe.streams[0].nb_read_frames), 6)
      assert.ok(Math.abs(Number(probe.streams[0].duration) - 0.6) < 0.01)
    }
    console.log('PASS real video frame seeking, reordered segments and valid animated GIF output')

    const cancelled = await page.evaluate(async () => {
      const url = URL.createObjectURL(window.savedBlob)
      const abort = new AbortController()
      try {
        await window.gif.createVideoGif(url, window.savedDuration, [{ start: 0, end: 0.9 }], { width: 160, fps: 24, loop: false, quality: 'balanced', signal: abort.signal, onProgress: () => abort.abort() })
        return false
      } catch (error) { return error.name === 'AbortError' }
      finally { URL.revokeObjectURL(url) }
    })
    assert.equal(cancelled, true)
    console.log('PASS cancellation interrupts GIF conversion')
  } finally { await browser.close(); rmSync(directory, { recursive: true, force: true }) }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
