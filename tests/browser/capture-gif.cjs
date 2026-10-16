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
      return { size: output.blob.size, duration: output.duration, mime: output.mime, bytes: Array.from(new Uint8Array(await output.blob.arrayBuffer())), before, after, stopped, finished, repeated: repeated.blob === output.blob, importedMetadata }
    })
    assert.ok(recording.size > 1000)
    assert.ok(recording.duration >= 0.85 && recording.duration < 1.4)
    assert.equal(recording.before, recording.after)
    assert.equal(recording.stopped, true)
    assert.equal(recording.finished, 1)
    assert.equal(recording.repeated, true)
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
