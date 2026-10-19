// Executed in the system WKWebView, not a browser emulator. Only native IPC is a fixture.
import type { EditorToolContext } from '../../src/core/editor-tool-service'

declare global {
  interface Window {
    __verification: { pngSha256: string; pngBytes: number }
    __captureRealtimeCanvas: (rect: { x: number; y: number; width: number; height: number }) => Promise<{ pngBase64: string }>
    webkit: { messageHandlers: { proof: { postMessage: (value: unknown) => void } } }
  }
}

const events: Record<string, unknown>[] = []
let realtimeCompositionVerified = false
let nativeFrameArtifactVerified = false
const emit = (stage: string, data: Record<string, unknown> = {}) => {
  const event = { stage, at: Date.now(), ...data }; events.push(event)
  window.webkit.messageHandlers.proof.postMessage({ type: 'progress', ...event })
}
const errorData = (cause: unknown) => cause instanceof Error ? { name: cause.name, message: cause.message, stack: cause.stack } : { message: String(cause) }
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds)
    promise.then(value => { clearTimeout(timer); resolve(value) }, cause => { clearTimeout(timer); reject(cause) })
  })
}

async function browserCapabilities() {
  emit('origin', { href: location.href, origin: location.origin, userAgent: navigator.userAgent, isSecureContext: window.isSecureContext, cryptoSubtleExists: !!globalThis.crypto?.subtle })
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'))
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    assert(hash === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'SHA-256 digest mismatch')
    emit('crypto-sha256', { success: true, hash })
  } catch (cause) { emit('crypto-sha256', { success: false, error: errorData(cause) }) }
  let db: IDBDatabase | undefined
  const name = `open-media-webkit-proof-${Date.now()}`
  try {
    db = await bounded(new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => request.result.createObjectStore('proof')
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    }), 5000, 'IndexedDB open')
    emit('indexeddb-open', { success: true })
    await new Promise<void>((resolve, reject) => {
      const transaction = db!.transaction('proof', 'readwrite')
      transaction.objectStore('proof').put(new Blob(['native-frame-proof'], { type: 'text/plain' }), 'value')
      transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(transaction.error)
    })
    emit('indexeddb-write', { success: true })
    const blob = await new Promise<Blob>((resolve, reject) => {
      const request = db!.transaction('proof').objectStore('proof').get('value')
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    assert(await blob.text() === 'native-frame-proof', 'IndexedDB Blob round trip changed bytes')
    emit('indexeddb-read', { success: true, bytes: blob.size })
  } catch (cause) { emit('indexeddb', { success: false, error: errorData(cause) }) }
  finally { db?.close(); try { indexedDB.deleteDatabase(name) } catch {} }
}

async function observeAssetCanvas(kind: 'video' | 'image') {
  const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90
  const media = kind === 'video' ? document.createElement('video') : new Image()
  media.crossOrigin = 'anonymous'
  if (media instanceof HTMLVideoElement) { media.muted = true; media.preload = 'auto' }
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      media.addEventListener(kind === 'video' ? 'loadeddata' : 'load', () => resolve(), { once: true })
      media.addEventListener('error', () => reject(new Error(`asset ${kind} load failed`)), { once: true })
      media.src = `asset://localhost/${kind === 'video' ? 'source.mp4' : 'frame.png'}`
    }), 8000, `asset ${kind} loading`)
    const context = canvas.getContext('2d')!
    context.drawImage(media, 0, 0, 160, 90)
    const pixel = [...context.getImageData(80, 45, 1, 1).data]
    const blob = await bounded(new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error('Canvas returned no PNG')), 'image/png')
    }), 5000, 'asset Canvas export')
    emit(`asset-${kind}-canvas`, { success: true, pixel, bytes: blob.size })
  } catch (cause) { emit(`asset-${kind}-canvas`, { success: false, error: errorData(cause) }) }
  finally {
    if (media instanceof HTMLVideoElement) { media.pause(); media.removeAttribute('src'); media.load() }
    canvas.width = canvas.height = 1
  }
}

async function verifyRealtimeComposition() {
  emit('realtime-start')
  const { TimelinePreview } = await import('../../src/core/preview')
  const { createProject, createClip, createTextClip, createTrack } = await import('../../src/core/project')
  const { addTransition } = await import('../../src/core/transitions')
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
  document.body.append(canvas)
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  emit('realtime-capabilities', { canvasFilter: 'filter' in context, requestVideoFrameCallback: 'requestVideoFrameCallback' in HTMLVideoElement.prototype })
  let project = createProject('WebKit realtime composition', { width: 320, height: 180, fps: 25, background: '#102030' })
  const source = { id: 'live-source', name: 'source.mp4', kind: 'video' as const, nativePath: '/fixture/source.mp4', url: 'asset://localhost/source.mp4?realtime=1', duration: 6, width: 160, height: 90, size: 4096, mime: 'video/mp4' }
  const watermark = { id: 'live-watermark', name: 'frame.png', kind: 'image' as const, nativePath: '/fixture/frame.png', url: 'asset://localhost/frame.png?realtime=1', duration: 6, width: 160, height: 90, size: window.__verification.pngBytes, mime: 'image/png' }
  project.assets = [source, watermark]
  project.tracks.find(track => track.kind === 'video')!.clips = [
    createClip(source, project, { id: 'before-cut', trimOut: 3, volume: 0 }),
    createClip(source, project, { id: 'after-cut', start: 3, trimIn: 3, trimOut: 6, volume: 0 }),
  ]
  project.tracks.find(track => track.kind === 'text')!.clips = [createTextClip(project, {
    id: 'moving-text', textRole: 'watermark', text: 'WM', trimOut: 6,
    x: 80, y: 20, width: 60, height: 50, fontSize: 20, color: '#ffffff', background: '#00ff00',
    keyframes: { x: [{ time: 0, value: 80 }, { time: 2, value: 180 }], opacity: [{ time: 0, value: 1 }, { time: 2, value: .5 }] },
  })]
  const images = createTrack('video', 'Image watermark')
  images.clips = [createClip(watermark, project, { id: 'image-watermark', trimOut: 6, x: 260, y: 20, width: 40, height: 40, fit: 'fill', opacity: .5 })]
  project.tracks.unshift(images)
  project = addTransition(project, 3, 'fade', 1, project.tracks.find(track => track.clips.some(clip => clip.id === 'before-cut'))!.id)

  // Observe real media elements without changing their loading or playback behavior.
  const videos: HTMLVideoElement[] = []
  const createElement = document.createElement
  document.createElement = ((name: string, options?: ElementCreationOptions) => {
    const element = createElement.call(document, name, options)
    if (element instanceof HTMLVideoElement) videos.push(element)
    return element
  }) as typeof document.createElement
  const errors: string[] = []
  const preview = new TimelinePreview(canvas, project, message => { errors.push(message); emit('realtime-render-error', { message }) })
  const abort = new AbortController()
  let frame = 0, segmentGeneration = 0
  const samples: { label: string; time: number; sourceTime: number; motionHash: number; watermarkTime?: number; watermarkHash?: number }[] = []
  let filteredSource = false, keyedWatermark = false
  let canvasReadbackAllowed = true
  const snapshotCanvas = document.createElement('canvas'); snapshotCanvas.width = canvas.width; snapshotCanvas.height = canvas.height
  const readPixels = async () => {
    if (canvasReadbackAllowed) {
      try { return context.getImageData(0, 0, canvas.width, canvas.height) }
      catch (cause) {
        if (!(cause instanceof DOMException) || cause.name !== 'SecurityError') throw cause
        canvasReadbackAllowed = false
        emit('realtime-canvas-readback-restricted', { error: errorData(cause), fallback: 'WKWebView.takeSnapshot of the visible test canvas' })
      }
    }
    const bounds = canvas.getBoundingClientRect()
    const snapshot = await bounded(window.__captureRealtimeCanvas({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }), 5000, 'visible canvas snapshot')
    const image = new Image()
    await bounded(new Promise<void>((resolve, reject) => {
      image.onload = () => resolve(); image.onerror = () => reject(new Error('WKWebView canvas snapshot PNG could not be decoded'))
      image.src = `data:image/png;base64,${snapshot.pngBase64}`
    }), 5000, 'snapshot PNG decoding')
    const clean = snapshotCanvas.getContext('2d', { willReadFrequently: true })!
    clean.clearRect(0, 0, canvas.width, canvas.height)
    clean.drawImage(image, 0, 0, canvas.width, canvas.height)
    return clean.getImageData(0, 0, canvas.width, canvas.height)
  }
  const near = (actual: number[], expected: number[], label: string, tolerance = 9) => assert(actual.slice(0, 3).every((value, index) => Math.abs(value - expected[index]!) <= tolerance), `${label}: actual=${actual}, expected=${expected}`)
  const sample = async (label: string, time: number) => {
    const media = videos.filter(video => video.getAttribute('src')).map(video => ({ source: video.currentSrc || video.src, currentTime: video.currentTime, paused: video.paused, seeking: video.seeking, readyState: video.readyState, width: video.videoWidth }))
    const readbackStarted = performance.now()
    const pixels = await readPixels()
    const readbackMilliseconds = performance.now() - readbackStarted
    const pixel = (x: number, y: number) => [...pixels.data.slice((Math.floor(y) * canvas.width + Math.floor(x)) * 4, (Math.floor(y) * canvas.width + Math.floor(x)) * 4 + 4)]
    // The upper source band is a fixed encoded color; the lower band has real motion.
    // Expectations are independent of the renderer's keyframe/transition helpers.
    const visibility = time >= 2.5 && time < 3.5 ? Math.min(1, Math.abs(time - 3) * 2) : 1
    const background = [16, 32, 48], original = filteredSource ? [74, 74, 74] : [200, 40, 40]
    const underlying = original.map((value, index) => value * visibility + background[index]! * (1 - visibility))
    const x = 80 + Math.min(time, 2) * 50, opacity = 1 - Math.min(time, 2) * .25
    const videoPixel = pixel(10, 10), textPixel = pixel(x + 4, 24), imagePixel = pixel(270, 24)
    const expectedText = underlying.map((value, index) => value * (1 - opacity) + [0, 255, 0][index]! * opacity)
    const expectedImage = underlying.map((value, index) => value * .5 + [255, 0, 0][index]! * .5)
    let glyphPixels = 0
    for (let dy = 24; dy < 66; dy++) for (let dx = Math.floor(x) + 4; dx < Math.floor(x) + 56; dx++) {
      const color = pixel(dx, dy)
      if (color[0]! > expectedText[0]! + 45 && color[2]! > expectedText[2]! + 45) glyphPixels++
    }
    let motionHash = 2166136261
    for (const value of pixels.data.subarray(110 * 320 * 4)) motionHash = Math.imul(motionHash ^ value, 16777619) >>> 0
    let greenPixels = 0, darkForegroundPixels = 0, colorfulForegroundPixels = 0, watermarkHash = 2166136261
    if (keyedWatermark) for (let dy = 10; dy < 46; dy++) for (let dx = 10; dx < 74; dx++) {
      const [red, green, blue] = pixel(dx, dy) as [number, number, number, number]
      for (const value of [red, green, blue]) watermarkHash = Math.imul(watermarkHash ^ value, 16777619) >>> 0
      if (green > 100 && green > red + 60 && green > blue + 60) greenPixels++
      if (red < 60 && green < 60 && blue < 80) darkForegroundPixels++
      if (blue > 110 && (green > 100 || red > 100)) colorfulForegroundPixels++
    }
    const active = media.find(video => video.source.includes('/source.mp4') && !video.paused && video.readyState >= 2 && video.width > 0)
    const activeWatermark = media.find(video => video.source.includes('/loading-dots.mp4') && !video.paused && video.readyState >= 2 && video.width > 0)
    emit('realtime-sample', { label, time, pixelReadback: canvasReadbackAllowed ? 'canvas' : 'WKWebView.takeSnapshot', readbackMilliseconds, videoPixel, expectedVideo: underlying, textPixel, expectedText, imagePixel, expectedImage, glyphPixels, motionHash, filteredSource, keyedWatermark, greenPixels, darkForegroundPixels, colorfulForegroundPixels, watermarkHash, media })
    assert(errors.length === 0, `Realtime renderer reported errors: ${errors.join('; ')}`)
    near(videoPixel, underlying, `${label}: video and transition`)
    near(textPixel, expectedText, `${label}: moving text background and opacity`)
    near(imagePixel, expectedImage, `${label}: image watermark alpha`)
    assert(glyphPixels >= 8, `${label}: actual text glyphs are absent (${glyphPixels} pixels)`)
    if (keyedWatermark) {
      near(pixel(14, 14), underlying, `${label}: green background must reveal the source video`)
      assert(greenPixels <= 2, `${label}: ${greenPixels} green-screen pixels remain visible`)
      assert(darkForegroundPixels >= 30 && colorfulForegroundPixels >= 10, `${label}: keyed animated watermark foreground disappeared`)
      assert(activeWatermark && Math.abs(activeWatermark.currentTime - time) < .4, `${label}: video watermark did not follow the live timeline`)
    }
    assert(active && Math.abs(active.currentTime - time) < .4, `${label}: decoded video did not follow the live timeline`)
    samples.push({ label, time, sourceTime: active!.currentTime, motionHash, ...(keyedWatermark ? { watermarkTime: activeWatermark!.currentTime, watermarkHash } : {}) })
  }
  const playThrough = (start: number, checkpoints: { label: string; time: number }[]) => {
    const generation = ++segmentGeneration
    return bounded(new Promise<void>((resolve, reject) => {
      const started = performance.now()
      let index = 0
      const tick = async () => {
        try {
          if (generation !== segmentGeneration) return
          abort.signal.throwIfAborted()
          const time = start + (performance.now() - started) / 1000
          preview.render(time, true)
          const checkpoint = checkpoints[index]!
          if (time >= checkpoint.time) {
            assert(time - checkpoint.time < .2, `${checkpoint.label}: RAF missed the sampling window`)
            await sample(checkpoint.label, time)
            if (generation !== segmentGeneration) return
            abort.signal.throwIfAborted()
            index++
          }
          if (index === checkpoints.length) resolve()
          else frame = requestAnimationFrame(tick)
        } catch (cause) { reject(cause) }
      }
      frame = requestAnimationFrame(tick)
    }), 12000, 'realtime playback samples').finally(() => {
      if (generation === segmentGeneration) segmentGeneration++
      cancelAnimationFrame(frame)
    })
  }
  try {
    // Match VideoEditor startup; prepare() would change lazy loading to export mode.
    await bounded(preview.enableAudio(true, abort.signal), 10000, 'realtime audio startup')
    await bounded(preview.playReady(0, abort.signal), 18000, 'realtime video startup')
    await playThrough(0, [
      { label: 'initial-composite', time: .25 }, { label: 'moved-text', time: 1.5 },
      { label: 'fade-out', time: 2.75 }, { label: 'fade-in', time: 3.25 },
      { label: 'after-cut', time: 3.8 },
    ])
    assert(samples[1]!.sourceTime - samples[0]!.sourceTime > 1, 'Video playback time did not advance independently of RAF')
    assert(samples[0]!.motionHash !== samples[1]!.motionHash, 'The actual video motion region remained frozen')
    // An explicit playing seek uses the same synchronous path as VideoEditor.seek.
    preview.seek(4.5, true)
    await playThrough(4.5, [{ label: 'forward-seek', time: 4.95 }])
    preview.seek(.2, true)
    await playThrough(.2, [{ label: 'backward-seek', time: .7 }])
    preview.seek(2.5, true)
    await playThrough(2.5, [{ label: 'transition-after-seek', time: 2.75 }])
    emit('realtime-basic-complete', { success: true, sampleCount: samples.length })
    // Both use actual asset:// video, exercising WebGL texture upload and CPU
    // readback. Snapshot fallback validates the visible result only; renderer
    // errors and absent effect layers remain failures.
    const effectFailures: string[] = []
    const { DEFAULT_CLIP_FILTERS } = await import('../../src/core/clip-filters')
    for (const effect of ['color-filter', 'chroma-watermark'] as const) {
      errors.length = 0
      filteredSource = effect === 'color-filter'; keyedWatermark = effect === 'chroma-watermark'
      const effectProject = structuredClone(project)
      if (filteredSource) {
        for (const track of effectProject.tracks) for (const clip of track.clips) {
          if (clip.assetId === source.id) clip.filters = { ...DEFAULT_CLIP_FILTERS, saturation: 0 }
        }
      } else {
        const dots = { id: 'chroma-dots', name: 'loading-dots.mp4', kind: 'video' as const, nativePath: '/fixture/loading-dots.mp4', url: 'asset://localhost/loading-dots.mp4?realtime=1', duration: 4, width: 640, height: 360, size: 19345, mime: 'video/mp4' }
        effectProject.assets.push(dots)
        const layer = createTrack('video', 'Chroma video watermark')
        layer.clips = [createClip(dots, effectProject, { id: 'chroma-watermark', x: 10, y: 10, width: 64, height: 36, trimOut: 4, volume: 0, chromaKey: { enabled: true, color: '#00ff00', similarity: .18, blend: .08, spillSuppression: true } })]
        effectProject.tracks.unshift(layer)
      }
      try {
        preview.setProject(effectProject)
        await bounded(preview.playReady(.2, abort.signal), 18000, `${effect} video startup`)
        await playThrough(.2, [{ label: effect, time: .7 }, ...(keyedWatermark ? [{ label: 'chroma-watermark-motion', time: 1.4 }] : [])])
        if (keyedWatermark) {
          const before = samples.at(-2)!, after = samples.at(-1)!
          assert(after.watermarkTime! - before.watermarkTime! > .5, 'The actual video watermark clock remained frozen')
          assert(after.watermarkHash !== before.watermarkHash, 'The keyed video watermark pixels remained frozen')
        }
        emit('realtime-effect-complete', { effect, success: true })
      } catch (cause) {
        const error = errorData(cause)
        effectFailures.push(`${effect}: ${error.message}`)
        emit('realtime-effect-failed', { effect, error, rendererErrors: [...errors] })
      }
    }
    assert(effectFailures.length === 0, effectFailures.join('; '))
    realtimeCompositionVerified = true
    emit('realtime-complete', { success: true, sampleCount: samples.length, errors, lazyLoading: true, canvasReadbackAllowed })
  } finally {
    cancelAnimationFrame(frame)
    abort.abort()
    preview.dispose()
    document.createElement = createElement
    canvas.remove()
    canvas.width = canvas.height = 1
    snapshotCanvas.width = snapshotCanvas.height = 1
  }
}

async function run() {
  await browserCapabilities()
  // Security behavior can vary with the OS version. Record it without assuming failure.
  await observeAssetCanvas('image'); await observeAssetCanvas('video')
  // Retain native artifact evidence even when the separate live renderer fails.
  let realtimeError: ReturnType<typeof errorData> | undefined
  try { await verifyRealtimeComposition() }
  catch (cause) { realtimeError = errorData(cause); emit('realtime-failed', { error: realtimeError }) }
  emit('import-start')
  const { timelineFrame } = await import('../../src/core/editor-preview-tools')
  const { createProject, createClip } = await import('../../src/core/project')
  const { base64Blob, storeToolArtifact, getToolArtifact, readToolArtifact } = await import('../../src/core/tool-artifacts')
  emit('import-complete')
  const project = createProject('WebKit native frame regression', { width: 160, height: 90, fps: 25 })
  const asset = { id: 'source', name: 'source.mp4', kind: 'video' as const, nativePath: '/fixture/source.mp4', url: 'asset://localhost/source.mp4', duration: 1, width: 160, height: 90, size: 4096, mime: 'video/mp4' }
  project.assets = [asset]; project.tracks.find(track => track.kind === 'video')!.clips = [createClip(asset, project)]
  const context: EditorToolContext = { project, revision: 1, blobs: new Map(), source: 'mcp', signal: new AbortController().signal, onProgress: update => emit('production-progress', { ...update }) }
  emit('run-start')
  const frame = await bounded(timelineFrame(context, .2, 160), 30000, 'production timelineFrame')
  emit('run-complete', { artifactId: frame.artifactId, width: frame.width, height: frame.height, bytes: frame.bytes, sha256: frame.sha256 })
  assert(frame.width === 160 && frame.height === 90, 'Native frame dimensions were lost')
  assert(frame.bytes === window.__verification.pngBytes, 'Native PNG bytes changed')
  assert(frame.sha256 === window.__verification.pngSha256, 'Native PNG SHA-256 mismatch')
  emit('cache-save-start')
  const copied = await bounded(storeToolArtifact(base64Blob(frame.base64, 'image/png'), 'WebKit PNG copy.png', context.signal), 10000, 'production artifact save')
  assert(copied.sha256 === frame.sha256 && copied.bytes === frame.bytes, 'Saving IPC PNG changed its hash or size')
  emit('cache-save-complete', { artifactId: copied.artifactId, bytes: copied.bytes, sha256: copied.sha256 })
  emit('cache-read-start')
  const stored = await bounded(getToolArtifact(frame.artifactId), 10000, 'production artifact read')
  assert(stored.blob.type === 'image/png' && stored.blob.size === frame.bytes, 'Stored PNG metadata mismatch')
  let offset = 0, encoded = '', chunks = 0
  for (;;) {
    const chunk = await readToolArtifact(frame.artifactId, offset, 31)
    encoded += atob(chunk.data); chunks++; offset = chunk.nextOffset
    if (chunk.done) break
    assert(chunks < 100000 && chunk.nextOffset > chunk.offset, 'Artifact chunk reader made no progress')
  }
  assert(btoa(encoded) === frame.base64, 'MCP artifact chunks differ from returned PNG')
  assert(stored.metadata.sha256 === frame.sha256, 'Stored SHA-256 changed')
  emit('cache-read-complete', { chunks, bytes: offset })
  nativeFrameArtifactVerified = true
  return { passed: realtimeCompositionVerified, realtimeCompositionVerified, nativeFrameArtifactVerified, realtimeError, evidence: 'Real asset video, animated text, image watermark, transition, playing seeks, color filter and chroma-key video watermark are composited by TimelinePreview in system WKWebView. Restricted canvas readback uses visible WKWebView snapshots. The separate native frame artifact path uses fixture PNG IPC; native FFmpeg composition is not verified.', events }
}

void run().then(result => window.webkit.messageHandlers.proof.postMessage({ type: 'result', ...result }), cause => {
  window.webkit.messageHandlers.proof.postMessage({ type: 'result', passed: false, realtimeCompositionVerified, nativeFrameArtifactVerified, error: errorData(cause), events })
})
