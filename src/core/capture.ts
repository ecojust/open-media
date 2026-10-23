export type CapturePhase = 'recording' | 'paused' | 'stopped'

export interface CapturedRecording {
  blob: Blob
  duration: number
  mime: string
  name: string
}

export interface CaptureRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface CaptureOutputSize {
  width: number
  height: number
}

export interface BrowserCaptureSource {
  type: 'screen' | 'window' | 'tab' | 'unknown'
  label: string
  width: number
  height: number
  outputWidth: number
  outputHeight: number
  region?: CaptureRegion
}

export interface BrowserCaptureSelection {
  region?: CaptureRegion
  outputSize?: CaptureOutputSize
  microphone?: boolean
  audioDevice?: string
}

export interface BrowserCaptureSelectionRequest {
  stream: MediaStream
  source: BrowserCaptureSource
  signal: AbortSignal
}

export interface BrowserCaptureOptions {
  fps: number
  microphone: boolean
  systemAudio: boolean
  audioDevice?: string
  sourceType?: 'screen' | 'window' | 'region'
  region?: CaptureRegion
  outputSize?: CaptureOutputSize
  chooseSource?: (request: BrowserCaptureSelectionRequest) => Promise<BrowserCaptureSelection | null>
  countdown?: number
  interactiveZoom?: boolean
  onPreview?: (stream: MediaStream, source: BrowserCaptureSource) => void
  signal?: AbortSignal
  onCountdown?: (remaining: number) => void
  onFinished?: (recording: CapturedRecording) => void
  onError?: (error: Error) => void
  onPhase?: (phase: CapturePhase) => void
}

function cancelledCapture(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('已取消录制。', 'AbortError')
}

/** Discard device streams that resolve after a pending permission request is cancelled. */
function waitForCapture<T>(pending: Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const aborted = () => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', aborted)
      reject(cancelledCapture(signal))
    }
    pending.then(value => {
      if (settled) { discard?.(value); return }
      settled = true
      signal.removeEventListener('abort', aborted)
      resolve(value)
    }, error => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', aborted)
      reject(error)
    })
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

export interface BrowserCapture {
  readonly stream: MediaStream
  readonly source: BrowserCaptureSource
  readonly phase: CapturePhase
  readonly elapsed: number
  readonly muted: boolean
  readonly audioAvailable: boolean
  readonly microphoneEnabled: boolean
  setMicrophoneEnabled(enabled: boolean): Promise<void>
  zoomAt(x: number, y: number, delta: number): void
  setMuted(muted: boolean): void
  pause(): void
  resume(): void
  stop(): Promise<CapturedRecording>
}

/** Coordinates refer to pixels in the selected screen, before output scaling. */
export function validateCaptureRegion(region: CaptureRegion, width: number, height: number): void {
  if (![region.x, region.y, region.width, region.height].every(Number.isSafeInteger)
    || region.x < 0 || region.y < 0 || region.width < 2 || region.height < 2
    || region.x + region.width > width || region.y + region.height > height) {
    throw new Error(`录制区域超出所选屏幕范围，请在 ${width} × ${height} 像素内设置位置和尺寸。`)
  }
}

/** Preserve the initial aspect ratio and keep every focused crop inside its selection. */
export function zoomCaptureRegion(initial: CaptureRegion, current: CaptureRegion, pointer: { x: number; y: number }, delta: number): CaptureRegion {
  if (![pointer.x, pointer.y, delta].every(Number.isFinite)
    || pointer.x < initial.x || pointer.y < initial.y
    || pointer.x > initial.x + initial.width || pointer.y > initial.y + initial.height) return { ...current }
  const minimumScale = Math.min(1, Math.max(1 / 8, 16 / initial.width, 16 / initial.height))
  const scale = Math.max(minimumScale, Math.min(1, current.width / initial.width * Math.exp(Math.max(-300, Math.min(300, delta)) * 0.002)))
  const width = Math.min(initial.width, Math.max(1, Math.round(initial.width * scale)))
  const height = Math.min(initial.height, Math.max(1, Math.round(initial.height * scale)))
  const anchorX = Math.max(current.x, Math.min(current.x + current.width, pointer.x))
  const anchorY = Math.max(current.y, Math.min(current.y + current.height, pointer.y))
  const x = Math.round(anchorX - (anchorX - current.x) / current.width * width)
  const y = Math.round(anchorY - (anchorY - current.y) / current.height * height)
  return { x: Math.max(initial.x, Math.min(initial.x + initial.width - width, x)), y: Math.max(initial.y, Math.min(initial.y + initial.height - height, y)), width, height }
}

function validateOutputSize(size: CaptureOutputSize): void {
  if (![size.width, size.height].every(Number.isSafeInteger) || size.width < 16 || size.height < 16
    || size.width > 7680 || size.height > 4320 || size.width % 2 !== 0 || size.height % 2 !== 0) {
    throw new Error('输出宽高须为不小于 16 的偶数，最大支持 7680 × 4320 像素。')
  }
}

export function browserCaptureAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== 'undefined'
}

export function recordingFileName(mime: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `录屏-${stamp}.${mime.includes('mp4') ? 'mp4' : 'webm'}`
}

export function captureErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return '未获得录屏或麦克风权限，请允许访问后重试。'
    if (error.name === 'NotFoundError') return '没有找到可用的屏幕或麦克风。'
    if (error.name === 'OverconstrainedError') return '所选麦克风当前不可用，请重新连接设备或选择其他麦克风来源。'
    if (error.name === 'NotReadableError') return '无法读取录制来源，请检查系统权限和设备是否被其他程序占用。'
    if (error.name === 'AbortError') return '已取消录制来源选择。'
  }
  return error instanceof Error ? error.message : typeof error === 'string' && error.trim() ? error : '录制失败，请重试。'
}

/** Obtain screen permission before awaiting other work so the click activation is preserved. */
export async function startBrowserCapture(options: BrowserCaptureOptions): Promise<BrowserCapture> {
  if (!browserCaptureAvailable()) throw new Error('当前环境不支持屏幕采集，请使用桌面录制或支持屏幕共享的浏览器。')
  if (options.signal?.aborted) throw new DOMException('已取消录制。', 'AbortError')
  if (!options.chooseSource) {
    if (options.outputSize) validateOutputSize(options.outputSize)
    if (options.sourceType === 'region' && !options.region) throw new Error('请先设置屏幕录制区域。')
    if (options.sourceType === 'window' && options.region) throw new Error('窗口录制不能使用屏幕区域坐标，请选择屏幕区域录制。')
  }
  const fps = Math.min(60, Math.max(1, Math.round(options.fps || 30)))
  const screenRequest = navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: fps, max: fps }, ...(options.sourceType ? { displaySurface: options.sourceType === 'window' ? 'window' : 'monitor' } : {}) },
    audio: options.systemAudio,
  })
  const releaseStream = (stream: MediaStream) => stream.getTracks().forEach(track => track.stop())
  const screen = await (options.signal ? waitForCapture(screenRequest, options.signal, releaseStream) : screenRequest)
  let microphone: MediaStream | undefined
  let microphoneNodes: MediaStreamAudioSourceNode[] = []
  let microphonePending: AbortController | undefined
  let silence: ConstantSourceNode | undefined
  let context: AudioContext | undefined
  let sourceVideo: HTMLVideoElement | undefined
  let renderTimer: ReturnType<typeof setInterval> | undefined
  let renderFrame: number | undefined
  let paintFinalFrame: (() => void) | undefined
  let transformFailure: Error | undefined
  let onTransformFailure: ((error: Error) => void) | undefined
  let recorder: MediaRecorder
  const ownedTracks = new Set<MediaStreamTrack>(screen.getTracks())
  const preparation = new AbortController()
  const sourceEnded = () => preparation.abort(new Error('屏幕共享已结束，请重新选择录制来源。'))
  screen.getVideoTracks().forEach(track => track.addEventListener('ended', sourceEnded, { once: true }))
  let abortCapture: () => void
  const onAbort = () => { preparation.abort(new DOMException('已取消录制。', 'AbortError')); abortCapture() }
  const stopRendering = () => {
    if (renderTimer !== undefined) { clearInterval(renderTimer); renderTimer = undefined }
    if (renderFrame !== undefined) { sourceVideo?.cancelVideoFrameCallback(renderFrame); renderFrame = undefined }
  }
  const dispose = () => {
    microphonePending?.abort(new DOMException('已取消麦克风请求。', 'AbortError'))
    microphoneNodes.forEach(node => node.disconnect())
    microphoneNodes = []
    silence?.stop()
    silence = undefined
    stopRendering()
    paintFinalFrame = undefined
    if (sourceVideo) { sourceVideo.pause(); sourceVideo.srcObject = null; sourceVideo.remove(); sourceVideo = undefined }
    for (const track of ownedTracks) track.stop()
    void context?.close().catch(() => {})
    screen.getVideoTracks().forEach(track => track.removeEventListener('ended', sourceEnded))
    if (!preparation.signal.aborted) preparation.abort(new DOMException('已取消录制。', 'AbortError'))
    options.signal?.removeEventListener('abort', onAbort)
  }
  abortCapture = dispose
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (options.signal?.aborted) throw new DOMException('已取消录制。', 'AbortError')
    const videoTrack = screen.getVideoTracks().find(track => track.readyState === 'live')
    if (!videoTrack) throw new Error('没有可用的屏幕画面。')
    const settings = videoTrack.getSettings()
    let region = options.region ? { ...options.region } : undefined
    let outputSize = options.outputSize ? { ...options.outputSize } : undefined
    let microphoneSelected = options.microphone
    let audioDeviceSelected = options.audioDevice
    let transformsVideo = !!(region || outputSize || options.interactiveZoom)
    const source: BrowserCaptureSource = {
      type: settings.displaySurface === 'monitor' ? 'screen' : settings.displaySurface === 'window' ? 'window' : settings.displaySurface === 'browser' ? 'tab' : 'unknown',
      label: videoTrack.label || '所选录制来源',
      width: settings.width ?? 0,
      height: settings.height ?? 0,
      outputWidth: settings.width ?? 0,
      outputHeight: settings.height ?? 0,
    }
    const updateSource = () => {
      if (videoTrack.readyState !== 'live') return
      const current = videoTrack.getSettings()
      source.type = current.displaySurface === 'monitor' ? 'screen' : current.displaySurface === 'window' ? 'window' : current.displaySurface === 'browser' ? 'tab' : 'unknown'
      source.label = videoTrack.label || source.label
      source.width = sourceVideo?.videoWidth || current.width || source.width
      source.height = sourceVideo?.videoHeight || current.height || source.height
      if (!transformsVideo) { source.outputWidth = source.width; source.outputHeight = source.height }
    }
    let outputVideoTracks = screen.getVideoTracks()
    if (transformsVideo || options.chooseSource) {
      const video = document.createElement('video')
      sourceVideo = video
      video.muted = true
      video.playsInline = true
      video.srcObject = new MediaStream([videoTrack])
      await new Promise<void>((resolve, reject) => {
        const clear = () => {
          clearTimeout(timer)
          video.removeEventListener('loadeddata', ready)
          video.removeEventListener('error', failed)
          videoTrack.removeEventListener('ended', failed)
          preparation.signal.removeEventListener('abort', aborted)
        }
        const ready = () => { if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2) { clear(); resolve() } }
        const failed = () => { clear(); reject(new Error('无法读取所选录制画面，请重新选择来源。')) }
        const aborted = () => { clear(); reject(cancelledCapture(preparation.signal)) }
        const timer = setTimeout(failed, 15000)
        video.addEventListener('loadeddata', ready)
        video.addEventListener('error', failed)
        videoTrack.addEventListener('ended', failed)
        preparation.signal.addEventListener('abort', aborted, { once: true })
        void video.play().then(ready, failed)
        if (preparation.signal.aborted) aborted()
        else ready()
      })
      if (preparation.signal.aborted) throw cancelledCapture(preparation.signal)
      source.width = video.videoWidth
      source.height = video.videoHeight
      source.outputWidth = source.width
      source.outputHeight = source.height
    }
    if (options.chooseSource) {
      const selected = await waitForCapture(options.chooseSource({ stream: screen, source: { ...source }, signal: preparation.signal }), preparation.signal)
      if (!selected) throw new DOMException('已取消录制来源选择。', 'AbortError')
      region = selected.region ? { ...selected.region } : undefined
      outputSize = selected.outputSize ? { ...selected.outputSize } : undefined
      microphoneSelected = selected.microphone ?? microphoneSelected
      audioDeviceSelected = selected.audioDevice ?? audioDeviceSelected
      transformsVideo = !!(region || outputSize || options.interactiveZoom)
      updateSource()
    }
    if (preparation.signal.aborted) throw cancelledCapture(preparation.signal)
    if (outputSize) validateOutputSize(outputSize)
    if (region && source.type !== 'screen') throw new Error('屏幕区域录制需要选择整个屏幕；当前选择的是窗口、标签页或无法确认的来源，请重新选择。')
    const initialRegion = { ...(region ?? { x: 0, y: 0, width: source.width, height: source.height }) }
    const selectedRegion = !!region
    let activeCrop = { ...initialRegion }
    if (transformsVideo) {
      const video = sourceVideo!
      if (region) { validateCaptureRegion(region, source.width, source.height); source.region = region }
      source.outputWidth = outputSize?.width ?? region?.width ?? source.width
      source.outputHeight = outputSize?.height ?? region?.height ?? source.height
      const canvas = document.createElement('canvas')
      canvas.width = source.outputWidth
      canvas.height = source.outputHeight
      const painter = canvas.getContext('2d', { alpha: false })
      if (!painter) throw new Error('无法创建录制画布，请重试。')
      let lastPaint = 0
      const paint = () => {
        try {
          if (video.readyState < 2) return
          updateSource()
          if (selectedRegion && source.type !== 'screen') throw new Error('录制来源已不再是整个屏幕，已结束区域录制并保留内容。')
          if (region || options.interactiveZoom) validateCaptureRegion(activeCrop, video.videoWidth, video.videoHeight)
          const crop = region || options.interactiveZoom ? activeCrop : { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight }
          const scale = Math.min(canvas.width / crop.width, canvas.height / crop.height)
          const width = crop.width * scale, height = crop.height * scale
          painter.fillStyle = '#000000'
          painter.fillRect(0, 0, canvas.width, canvas.height)
          painter.drawImage(video, crop.x, crop.y, crop.width, crop.height, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
          lastPaint = performance.now()
        } catch (error) {
          transformFailure = error instanceof Error ? error : new Error('录制画面处理失败。')
          stopRendering()
          onTransformFailure?.(transformFailure)
        }
      }
      paint()
      if (transformFailure) throw transformFailure
      const transformed = canvas.captureStream(fps)
      outputVideoTracks = transformed.getVideoTracks()
      outputVideoTracks.forEach(track => ownedTracks.add(track))
      paintFinalFrame = () => {
        const track = outputVideoTracks[0] as CanvasCaptureMediaStreamTrack | undefined
        track?.requestFrame?.()
        paint()
      }
      // Keep timestamps advancing when the source remains still between updates.
      renderTimer = setInterval(() => { if (performance.now() - lastPaint >= 800 / fps) paint() }, 1000 / fps)
      if (typeof video.requestVideoFrameCallback === 'function') {
        const nextFrame = () => {
          renderFrame = undefined
          if (sourceVideo !== video || transformFailure) return
          paint()
          if (!transformFailure) renderFrame = video.requestVideoFrameCallback(nextFrame)
        }
        renderFrame = video.requestVideoFrameCallback(nextFrame)
      }
    } else if (sourceVideo) {
      sourceVideo.pause(); sourceVideo.srcObject = null; sourceVideo.remove(); sourceVideo = undefined
    }
    const requestMicrophone = (signal: AbortSignal) => waitForCapture(navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        ...(audioDeviceSelected && audioDeviceSelected !== 'default' ? { deviceId: { exact: audioDeviceSelected } } : {}),
      },
      video: false,
    }), signal, releaseStream)
    if (microphoneSelected) {
      microphone = await requestMicrophone(preparation.signal)
      microphone.getTracks().forEach(track => ownedTracks.add(track))
    }
    if (preparation.signal.aborted) throw cancelledCapture(preparation.signal)
    const tracks = [...outputVideoTracks]
    const sharedAudioTracks = options.systemAudio ? screen.getAudioTracks() : []
    const audioTracks = () => [...sharedAudioTracks, ...(microphone?.getAudioTracks() ?? [])]
    // Keep one audio track for the entire recording. A zero-amplitude source
    // supplies timestamps while no device is enabled, without requesting one.
    context = new AudioContext()
    const destination = context.createMediaStreamDestination()
    silence = context.createConstantSource()
    silence.offset.value = 0
    silence.connect(destination)
    silence.start()
    for (const track of sharedAudioTracks) context.createMediaStreamSource(new MediaStream([track])).connect(destination)
    const attachMicrophone = (stream: MediaStream) => {
      microphoneNodes.forEach(node => node.disconnect())
      microphoneNodes = []
      try {
        for (const track of stream.getAudioTracks()) {
          const node = context!.createMediaStreamSource(new MediaStream([track]))
          microphoneNodes.push(node)
          node.connect(destination)
        }
      } catch (error) {
        microphoneNodes.forEach(node => node.disconnect())
        microphoneNodes = []
        throw error
      }
    }
    if (microphone) attachMicrophone(microphone)
    destination.stream.getTracks().forEach(track => ownedTracks.add(track))
    tracks.push(...destination.stream.getAudioTracks())
    await context.resume()
    const stream = new MediaStream(tracks)
    options.onPreview?.(stream, { ...source })
    for (let remaining = Math.max(0, Math.min(10, Math.floor(options.countdown ?? 0))); remaining > 0; remaining--) {
      if (preparation.signal.aborted) throw cancelledCapture(preparation.signal)
      options.onCountdown?.(remaining)
      await new Promise<void>((resolve, reject) => {
        const aborted = () => { clearTimeout(timer); reject(cancelledCapture(preparation.signal)) }
        const timer = setTimeout(() => { preparation.signal.removeEventListener('abort', aborted); resolve() }, 1000)
        preparation.signal.addEventListener('abort', aborted, { once: true })
        if (preparation.signal.aborted) aborted()
      })
    }
    options.onCountdown?.(0)
    if (preparation.signal.aborted) throw cancelledCapture(preparation.signal)
    if (transformFailure) throw transformFailure
    if (!screen.getVideoTracks().some(track => track.readyState === 'live')) throw new Error('屏幕共享已结束，请重新选择录制来源。')
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(value => MediaRecorder.isTypeSupported(value))
    recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 8_000_000 })
    let phase: CapturePhase = 'recording'
    const hasStopped = () => phase === 'stopped'
    let muted = false
    const outputAudioTracks = stream.getAudioTracks()
    const microphoneEnabled = () => phase !== 'stopped' && !!microphone?.getAudioTracks().some(track => track.readyState === 'live')
    const audioAvailable = () => phase !== 'stopped' && audioTracks().some(track => track.readyState === 'live')
    let microphoneQueue: Promise<void> = Promise.resolve()
    let microphoneRevision = 0
    let microphoneOperation: { enabled: boolean; promise: Promise<void> } | undefined
    const setMicrophoneEnabled = (enabled: boolean): Promise<void> => {
      if (microphoneOperation?.enabled === enabled) return microphoneOperation.promise
      const revision = ++microphoneRevision
      // An off request also cancels a permission dialog that has not resolved.
      if (!enabled) microphonePending?.abort(new DOMException('已取消麦克风请求。', 'AbortError'))
      const change = microphoneQueue.then(async () => {
        if (revision !== microphoneRevision) return
        if (hasStopped() || preparation.signal.aborted) throw new Error('录制已结束。')
        if (enabled === microphoneEnabled()) return
        if (!enabled) {
          microphoneNodes.forEach(node => node.disconnect())
          microphoneNodes = []
          microphone?.getTracks().forEach(track => { track.stop(); ownedTracks.delete(track) })
          microphone = undefined
          return
        }
        const request = new AbortController()
        microphonePending = request
        const abort = () => request.abort(cancelledCapture(preparation.signal))
        preparation.signal.addEventListener('abort', abort, { once: true })
        try {
          const acquired = await requestMicrophone(request.signal)
          if (hasStopped() || revision !== microphoneRevision || request.signal.aborted) {
            releaseStream(acquired)
            if (hasStopped()) throw new Error('录制已结束。')
            return
          }
          if (!acquired.getAudioTracks().some(track => track.readyState === 'live')) {
            releaseStream(acquired)
            throw new Error('没有可用的麦克风音轨。')
          }
          try { attachMicrophone(acquired) }
          catch (error) { releaseStream(acquired); throw error }
          microphone = acquired
          acquired.getTracks().forEach(track => { track.enabled = !muted; ownedTracks.add(track) })
        } finally {
          preparation.signal.removeEventListener('abort', abort)
          if (microphonePending === request) microphonePending = undefined
        }
      })
      const operation = { enabled, promise: change }
      microphoneOperation = operation
      const clearOperation = () => { if (microphoneOperation === operation) microphoneOperation = undefined }
      void change.then(clearOperation, clearOperation)
      microphoneQueue = change.catch(() => {})
      return change
    }
    let startedAt = performance.now()
    let accumulated = 0
    let bytes = 0
    const chunks: Blob[] = []
    let resolve!: (value: CapturedRecording) => void
    let reject!: (reason: Error) => void
    let settled = false
    const finished = new Promise<CapturedRecording>((yes, no) => { resolve = yes; reject = no })
    // A source may stop without an explicit stop() call. Keep the rejection handled.
    void finished.catch(() => {})
    const elapsed = () => (accumulated + (phase === 'recording' ? performance.now() - startedAt : 0)) / 1000
    const stop = () => {
      if (phase !== 'stopped') {
        updateSource()
        accumulated = elapsed() * 1000
        phase = 'stopped'
        microphonePending?.abort(new DOMException('录制已结束。', 'AbortError'))
        options.onPhase?.(phase)
        if (!transformFailure) paintFinalFrame?.()
        if (recorder.state !== 'inactive') recorder.stop()
      }
      return finished
    }
    abortCapture = () => { void stop(); dispose() }
    onTransformFailure = error => { options.onError?.(error); void stop() }
    recorder.addEventListener('dataavailable', event => {
      if (event.data.size) { chunks.push(event.data); bytes += event.data.size }
      if (bytes > 512 * 1024 * 1024 && phase !== 'stopped') {
        options.onError?.(new Error('本次录制达到 512 MB，已自动结束并保留录制内容。'))
        void stop()
      }
    })
    recorder.addEventListener('error', event => {
      const error = ('error' in event && event.error instanceof Error) ? event.error : new Error('录屏编码失败。')
      options.onError?.(error)
      if (!settled) { settled = true; reject(error) }
      accumulated = elapsed() * 1000
      dispose()
      phase = 'stopped'
      options.onPhase?.(phase)
    })
    recorder.addEventListener('stop', () => {
      const duration = elapsed()
      accumulated = duration * 1000
      phase = 'stopped'
      dispose()
      options.onPhase?.(phase)
      if (settled) return
      settled = true
      const outputMime = recorder.mimeType || chunks[0]?.type || 'video/webm'
      const blob = new Blob(chunks, { type: outputMime })
      chunks.length = 0
      if (!blob.size) { const error = new Error('没有录制到有效画面，请重新录制。'); reject(error); options.onError?.(error); return }
      const result = { blob, duration, mime: outputMime, name: recordingFileName(outputMime) }
      resolve(result)
      options.onFinished?.(result)
    })
    screen.getVideoTracks().forEach(track => track.addEventListener('ended', () => { void stop() }, { once: true }))
    screen.getVideoTracks().forEach(track => track.removeEventListener('ended', sourceEnded))
    recorder.start(1000)
    return {
      stream,
      get source() { updateSource(); return { ...source, ...(source.region ? { region: { ...source.region } } : {}) } },
      get phase() { return phase },
      get elapsed() { return elapsed() },
      get muted() { return muted },
      get audioAvailable() { return audioAvailable() },
      get microphoneEnabled() { return microphoneEnabled() },
      setMicrophoneEnabled,
      zoomAt(x, y, delta) {
        if (!options.interactiveZoom || phase === 'stopped' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return
        activeCrop = zoomCaptureRegion(initialRegion, activeCrop, { x: activeCrop.x + x * activeCrop.width, y: activeCrop.y + y * activeCrop.height }, delta)
        source.region = { ...activeCrop }
        // The frame loop coalesces wheel bursts instead of encoding duplicate timestamps.
      },
      setMuted(value) {
        if (!audioAvailable()) return
        // Disable the mixed output as well as every authorized source. Keep the
        // tracks alive so silent samples preserve timing and can be resumed.
        for (const track of new Set([...audioTracks(), ...outputAudioTracks])) track.enabled = !value
        muted = value
      },
      pause() {
        if (phase !== 'recording') return
        recorder.pause()
        accumulated += performance.now() - startedAt
        phase = 'paused'
        options.onPhase?.(phase)
      },
      resume() {
        if (phase !== 'paused') return
        recorder.resume()
        startedAt = performance.now()
        phase = 'recording'
        options.onPhase?.(phase)
      },
      stop,
    }
  } catch (error) {
    dispose()
    throw error
  }
}
