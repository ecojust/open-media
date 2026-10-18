// Executed in the system WKWebView, not a browser emulator. Only native IPC is a fixture.
import type { EditorToolContext } from '../../src/core/editor-tool-service'

declare global {
  interface Window {
    __verification: { pngSha256: string; pngBytes: number }
    webkit: { messageHandlers: { proof: { postMessage: (value: unknown) => void } } }
  }
}

const events: Record<string, unknown>[] = []
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

async function run() {
  await browserCapabilities()
  // Security behavior can vary with the OS version. Record it without assuming failure.
  await observeAssetCanvas('image'); await observeAssetCanvas('video')
  emit('import-start')
  const { timelineFrame } = await import('../../src/core/editor-preview-tools')
  const { createProject, createClip } = await import('../../src/core/project')
  const { base64Blob, storeToolArtifact, getToolArtifact, readToolArtifact } = await import('../../src/core/tool-artifacts')
  emit('import-complete')
  const project = createProject('WebKit native frame regression', { width: 160, height: 90, fps: 25 })
  const asset = { id: 'source', name: 'source.mp4', kind: 'video' as const, nativePath: '/fixture/source.mp4', url: 'asset://localhost/source.mp4', duration: 1, width: 160, height: 90, size: 4096, mime: 'video/mp4' }
  project.assets = [asset]; project.tracks.find(track => track.kind === 'video')!.clips = [createClip(asset, project)]
  const context: EditorToolContext = { project, revision: 1, blobs: new Map(), source: 'mcp', signal: new AbortController().signal, onProgress: update => emit('production-progress', update) }
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
  return { passed: true, evidence: 'Actual system WKWebView with production frontend modules and fixture native IPC; this does not verify native FFmpeg composition.', events }
}

void run().then(result => window.webkit.messageHandlers.proof.postMessage({ type: 'result', ...result }), cause => {
  window.webkit.messageHandlers.proof.postMessage({ type: 'result', passed: false, error: errorData(cause), events })
})
