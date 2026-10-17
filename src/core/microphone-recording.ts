import { requestBrowserMicrophone } from './microphone-devices.ts'

export interface RecordedMicrophoneAudio {
  blob: Blob
  name: string
}

export interface MicrophoneRecording {
  /** Seconds since the recorder actually started, frozen as soon as capture stops. */
  readonly elapsed: number
  readonly finished: Promise<RecordedMicrophoneAudio>
  stop(): Promise<RecordedMicrophoneAudio>
  cancel(): void
}

const MAX_RECORDING_MS = 30 * 60 * 1000
// Request finalization at this size; retain every final chunk so the encoded file stays complete.
const RECORDING_STOP_BYTES = 96 * 1024 * 1024
const RECORDER_EVENT_TIMEOUT_MS = 10_000
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']

function cancelled(): DOMException {
  return new DOMException('已取消录音。', 'AbortError')
}

function releaseStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

export function microphoneRecordingErrorMessage(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return '麦克风访问被拒绝，请在系统或浏览器的麦克风权限中允许 Open Media 后重试。'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有找到可用的麦克风，请连接麦克风后重试。'
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') return '所选麦克风已断开或不可用，请重新连接或选择其他麦克风。'
  if (name === 'NotReadableError' || name === 'TrackStartError') return '无法读取麦克风，请检查设备连接、系统权限以及设备是否被其他程序占用。'
  if (name === 'AbortError') return '已取消录音。'
  if (name === 'NotSupportedError') return '当前环境不支持麦克风音频编码，请更新应用或浏览器后重试。'
  return error instanceof Error ? error.message : typeof error === 'string' && error.trim() ? error : '录音失败，请重试。'
}

/** Called only from an explicit recording action. Audio is never connected to speakers. */
export async function startMicrophoneRecording({ signal, deviceId }: { signal?: AbortSignal; deviceId?: string } = {}): Promise<MicrophoneRecording> {
  if (signal?.aborted) throw cancelled()
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('当前环境不支持麦克风录音，请使用桌面版或通过安全连接访问网页。')
  }
  const stream = await requestBrowserMicrophone({ signal, deviceId })
  let recorder: MediaRecorder
  try {
    if (signal?.aborted) throw cancelled()
    if (!stream.getAudioTracks().some(track => track.readyState === 'live')) throw new Error('麦克风已断开，请连接后重试。')
    if (stream.getVideoTracks().length) throw new Error('麦克风来源包含意外的视频轨道，请重新选择音频设备。')
    const mimeType = AUDIO_TYPES.find(type => MediaRecorder.isTypeSupported(type))
    recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 128_000 })
  } catch (error) {
    releaseStream(stream)
    throw error
  }

  let resolveStarted!: () => void
  let rejectStarted!: (error: unknown) => void
  const started = new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject })
  let resolveFinished!: (audio: RecordedMicrophoneAudio) => void
  let rejectFinished!: (error: unknown) => void
  const finished = new Promise<RecordedMicrophoneAudio>((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject })
  // Completion can fail before the caller receives the controller, or after it leaves the workspace.
  void finished.catch(() => {})
  let chunks: Blob[] = []
  let byteLength = 0
  let startedAt: number | undefined
  let endedAt: number | undefined
  let settled = false
  let stopping = false
  let startTimer: ReturnType<typeof setTimeout> | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let limitTimer: ReturnType<typeof setTimeout> | undefined
  let released = false
  const ended = () => { void stop() }
  const release = () => {
    if (released) return
    released = true
    for (const track of stream.getTracks()) track.removeEventListener('ended', ended)
    releaseStream(stream)
  }
  const freeze = () => { endedAt ??= performance.now() }
  const cleanup = () => {
    clearTimeout(startTimer)
    clearTimeout(stopTimer)
    clearTimeout(limitTimer)
    signal?.removeEventListener('abort', abort)
    recorder.removeEventListener('start', onStart)
    recorder.removeEventListener('dataavailable', onData)
    recorder.removeEventListener('stop', onStop)
    recorder.removeEventListener('error', onError)
    release()
  }
  const fail = (error: unknown) => {
    if (settled) return
    settled = true
    freeze()
    cleanup()
    chunks = []
    try { if (recorder.state !== 'inactive') recorder.stop() } catch { /* Device cleanup has already completed. */ }
    rejectStarted(error)
    rejectFinished(error)
  }
  function stop(): Promise<RecordedMicrophoneAudio> {
    if (settled || stopping) return finished
    stopping = true
    freeze()
    clearTimeout(limitTimer)
    stopTimer = setTimeout(() => fail(new Error('保存录音超时，请重新录制。')), RECORDER_EVENT_TIMEOUT_MS)
    try {
      // A device may already have stopped the recorder, with its final events still queued.
      if (recorder.state !== 'inactive') recorder.stop()
      release()
    } catch (error) { fail(error) }
    return finished
  }
  function abort() { fail(cancelled()) }
  function onStart() {
    if (settled || stopping) return
    clearTimeout(startTimer)
    startedAt = performance.now()
    limitTimer = setTimeout(() => { void stop() }, MAX_RECORDING_MS)
    resolveStarted()
  }
  function onData(event: BlobEvent) {
    if (settled || !event.data.size) return
    chunks.push(event.data)
    byteLength += event.data.size
    // Encoders can buffer larger chunks than the requested timeslice. This is a stop target,
    // not a hard memory cap: dropping the boundary or final chunk can make the audio unreadable.
    if (byteLength >= RECORDING_STOP_BYTES) void stop()
  }
  function onStop() {
    if (settled) return
    if (startedAt === undefined || !byteLength) {
      fail(new Error('没有录到有效音频，请检查麦克风并重新录制。'))
      return
    }
    freeze()
    const mime = recorder.mimeType || chunks.find(chunk => chunk.type)?.type || 'audio/webm'
    const blob = new Blob(chunks, { type: mime })
    const extension = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    settled = true
    cleanup()
    chunks = []
    resolveFinished({ blob, name: `录音-${stamp}.${extension}` })
  }
  function onError(event: Event) {
    fail((event as Event & { error?: DOMException }).error ?? new Error('麦克风录音中断，请检查设备后重试。'))
  }
  const controller: MicrophoneRecording = {
    get elapsed() { return startedAt === undefined ? 0 : Math.max(0, ((endedAt ?? performance.now()) - startedAt) / 1000) },
    finished,
    stop,
    cancel: abort,
  }
  recorder.addEventListener('start', onStart)
  recorder.addEventListener('dataavailable', onData)
  recorder.addEventListener('stop', onStop)
  recorder.addEventListener('error', onError)
  for (const track of stream.getAudioTracks()) track.addEventListener('ended', ended, { once: true })
  signal?.addEventListener('abort', abort, { once: true })
  startTimer = setTimeout(() => fail(new Error('启动麦克风录音超时，请重试。')), RECORDER_EVENT_TIMEOUT_MS)
  try {
    if (signal?.aborted) abort()
    else recorder.start(1000)
  } catch (error) { fail(error) }
  await started
  return controller
}
