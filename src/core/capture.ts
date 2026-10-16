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

export interface BrowserCaptureOptions {
  fps: number
  microphone: boolean
  systemAudio: boolean
  sourceType?: 'screen' | 'window' | 'region'
  region?: CaptureRegion
  outputSize?: CaptureOutputSize
  countdown?: number
  signal?: AbortSignal
  onCountdown?: (remaining: number) => void
  onFinished?: (recording: CapturedRecording) => void
  onError?: (error: Error) => void
  onPhase?: (phase: CapturePhase) => void
}

export interface BrowserCapture {
  readonly stream: MediaStream
  readonly source: BrowserCaptureSource
  readonly phase: CapturePhase
  readonly elapsed: number
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
    if (error.name === 'NotReadableError') return '无法读取录制来源，请检查系统权限和设备是否被其他程序占用。'
    if (error.name === 'AbortError') return '已取消录制来源选择。'
  }
  return error instanceof Error ? error.message : typeof error === 'string' && error.trim() ? error : '录制失败，请重试。'
}

/** Obtain screen permission before awaiting other work so the click activation is preserved. */
export async function startBrowserCapture(options: BrowserCaptureOptions): Promise<BrowserCapture> {
  if (!browserCaptureAvailable()) throw new Error('当前环境不支持屏幕采集，请使用桌面录制或支持屏幕共享的浏览器。')
  if (options.signal?.aborted) throw new DOMException('已取消录制。', 'AbortError')
  if (options.outputSize) validateOutputSize(options.outputSize)
  if (options.sourceType === 'region' && !options.region) throw new Error('请先设置屏幕录制区域。')
  if (options.sourceType === 'window' && options.region) throw new Error('窗口录制不能使用屏幕区域坐标，请选择屏幕区域录制。')
  const fps = Math.min(60, Math.max(1, Math.round(options.fps || 30)))
  const screen = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: fps, max: fps }, ...(options.sourceType ? { displaySurface: options.sourceType === 'window' ? 'window' : 'monitor' } : {}) },
    audio: options.systemAudio,
  })
  let microphone: MediaStream | undefined
  let context: AudioContext | undefined
  let sourceVideo: HTMLVideoElement | undefined
  let renderTimer: ReturnType<typeof setInterval> | undefined
  let renderFrame: number | undefined
  let paintFinalFrame: (() => void) | undefined
  let transformFailure: Error | undefined
  let onTransformFailure: ((error: Error) => void) | undefined
  let recorder: MediaRecorder
  const ownedTracks = new Set<MediaStreamTrack>(screen.getTracks())
  let abortCapture: () => void
  const onAbort = () => abortCapture()
  const stopRendering = () => {
    if (renderTimer !== undefined) { clearInterval(renderTimer); renderTimer = undefined }
    if (renderFrame !== undefined) { sourceVideo?.cancelVideoFrameCallback(renderFrame); renderFrame = undefined }
  }
  const dispose = () => {
    stopRendering()
    paintFinalFrame = undefined
    if (sourceVideo) { sourceVideo.pause(); sourceVideo.srcObject = null; sourceVideo.remove(); sourceVideo = undefined }
    for (const track of ownedTracks) track.stop()
    void context?.close().catch(() => {})
    options.signal?.removeEventListener('abort', onAbort)
  }
  abortCapture = dispose
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (options.signal?.aborted) throw new DOMException('已取消录制。', 'AbortError')
    const videoTrack = screen.getVideoTracks().find(track => track.readyState === 'live')
    if (!videoTrack) throw new Error('没有可用的屏幕画面。')
    const settings = videoTrack.getSettings()
    const transformsVideo = !!(options.region || options.outputSize)
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
    if (options.region && source.type !== 'screen') throw new Error('屏幕区域录制需要选择整个屏幕；当前选择的是窗口、标签页或无法确认的来源，请重新选择。')
    let outputVideoTracks = screen.getVideoTracks()
    if (transformsVideo) {
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
          options.signal?.removeEventListener('abort', aborted)
        }
        const ready = () => { if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2) { clear(); resolve() } }
        const failed = () => { clear(); reject(new Error('无法读取所选录制画面，请重新选择来源。')) }
        const aborted = () => { clear(); reject(new DOMException('已取消录制。', 'AbortError')) }
        const timer = setTimeout(failed, 15000)
        video.addEventListener('loadeddata', ready)
        video.addEventListener('error', failed)
        videoTrack.addEventListener('ended', failed)
        options.signal?.addEventListener('abort', aborted, { once: true })
        void video.play().then(ready, failed)
        if (options.signal?.aborted) aborted()
        else ready()
      })
      if (options.signal?.aborted) throw new DOMException('已取消录制。', 'AbortError')
      source.width = video.videoWidth
      source.height = video.videoHeight
      const region = options.region ? { ...options.region } : undefined
      if (region) { validateCaptureRegion(region, source.width, source.height); source.region = region }
      source.outputWidth = options.outputSize?.width ?? region?.width ?? source.width
      source.outputHeight = options.outputSize?.height ?? region?.height ?? source.height
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
          if (region && source.type !== 'screen') throw new Error('录制来源已不再是整个屏幕，已结束区域录制并保留内容。')
          if (region) validateCaptureRegion(region, video.videoWidth, video.videoHeight)
          const crop = region ?? { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight }
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
    }
    if (options.microphone) {
      microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      microphone.getTracks().forEach(track => ownedTracks.add(track))
    }
    if (options.signal?.aborted) throw new DOMException('已取消录制。', 'AbortError')
    const tracks = [...outputVideoTracks]
    const audioTracks = [...(options.systemAudio ? screen.getAudioTracks() : []), ...(microphone?.getAudioTracks() ?? [])]
    if (audioTracks.length > 1) {
      context = new AudioContext()
      const destination = context.createMediaStreamDestination()
      for (const track of audioTracks) context.createMediaStreamSource(new MediaStream([track])).connect(destination)
      destination.stream.getTracks().forEach(track => ownedTracks.add(track))
      tracks.push(...destination.stream.getAudioTracks())
      await context.resume()
    } else tracks.push(...audioTracks)
    for (let remaining = Math.max(0, Math.min(10, Math.floor(options.countdown ?? 0))); remaining > 0; remaining--) {
      if (options.signal?.aborted) throw new DOMException('已取消录制。', 'AbortError')
      options.onCountdown?.(remaining)
      await new Promise<void>((resolve, reject) => {
        const aborted = () => { clearTimeout(timer); reject(new DOMException('已取消录制。', 'AbortError')) }
        const timer = setTimeout(() => { options.signal?.removeEventListener('abort', aborted); resolve() }, 1000)
        options.signal?.addEventListener('abort', aborted, { once: true })
      })
    }
    options.onCountdown?.(0)
    if (options.signal?.aborted) throw new DOMException('已取消录制。', 'AbortError')
    if (transformFailure) throw transformFailure
    if (!screen.getVideoTracks().some(track => track.readyState === 'live')) throw new Error('屏幕共享已结束，请重新选择录制来源。')
    const stream = new MediaStream(tracks)
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(value => MediaRecorder.isTypeSupported(value))
    recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 8_000_000 })
    let phase: CapturePhase = 'recording'
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
    recorder.start(1000)
    return {
      stream,
      get source() { updateSource(); return { ...source, ...(source.region ? { region: { ...source.region } } : {}) } },
      get phase() { return phase },
      get elapsed() { return elapsed() },
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
