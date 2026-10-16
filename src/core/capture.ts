export type CapturePhase = 'recording' | 'paused' | 'stopped'

export interface CapturedRecording {
  blob: Blob
  duration: number
  mime: string
  name: string
}

export interface BrowserCaptureOptions {
  fps: number
  microphone: boolean
  systemAudio: boolean
  countdown?: number
  signal?: AbortSignal
  onCountdown?: (remaining: number) => void
  onFinished?: (recording: CapturedRecording) => void
  onError?: (error: Error) => void
  onPhase?: (phase: CapturePhase) => void
}

export interface BrowserCapture {
  readonly stream: MediaStream
  readonly phase: CapturePhase
  readonly elapsed: number
  pause(): void
  resume(): void
  stop(): Promise<CapturedRecording>
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
  const fps = Math.min(60, Math.max(1, Math.round(options.fps || 30)))
  const screen = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: fps, max: fps } },
    audio: options.systemAudio,
  })
  let microphone: MediaStream | undefined
  let context: AudioContext | undefined
  let recorder: MediaRecorder
  const ownedTracks = new Set<MediaStreamTrack>(screen.getTracks())
  const dispose = () => {
    for (const track of ownedTracks) track.stop()
    void context?.close().catch(() => {})
    options.signal?.removeEventListener('abort', dispose)
  }
  options.signal?.addEventListener('abort', dispose, { once: true })
  try {
    if (options.signal?.aborted) throw new DOMException('已取消录制。', 'AbortError')
    if (!screen.getVideoTracks().some(track => track.readyState === 'live')) throw new Error('没有可用的屏幕画面。')
    if (options.microphone) {
      microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      microphone.getTracks().forEach(track => ownedTracks.add(track))
    }
    if (options.signal?.aborted) throw new DOMException('已取消录制。', 'AbortError')
    const tracks = [...screen.getVideoTracks()]
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
        accumulated = elapsed() * 1000
        phase = 'stopped'
        options.onPhase?.(phase)
        if (recorder.state !== 'inactive') recorder.stop()
      }
      return finished
    }
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
