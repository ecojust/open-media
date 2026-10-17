import type { Clip, MediaAsset } from './types.ts'
import { clipDuration } from './timeline.ts'

function cancelled(): DOMException { return new DOMException('片段试听已取消', 'AbortError') }

// Short audio clips can be held in memory without keeping a streaming decoder
// in the output graph. Long media and pitch-preserving speed changes still use
// the media decoder, so auditioning a large recording never decodes it in full.
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024
const MAX_BUFFERED_SECONDS = 360

/** Playback time belongs to the audio thread; interface frames only observe it. */
export class ClipAudioPlayer {
  private media?: HTMLAudioElement
  private readonly asset: MediaAsset
  private readonly bufferEligible: boolean
  private buffer?: AudioBuffer
  private bufferSource?: AudioBufferSourceNode
  private bufferAttempted = false
  private bufferStarted = 0
  private bufferOffset = 0
  private readonly clip: Clip
  private readonly duration: number
  private readonly callbacks: { ended: () => void; error: (message: string) => void }
  private context?: AudioContext
  private source?: MediaElementAudioSourceNode
  private gain?: GainNode
  private pending?: AbortController
  private boundaryTimer = 0
  private active = false
  private disposed = false
  private completed = false

  constructor(asset: MediaAsset, clip: Clip, callbacks: { ended: () => void; error: (message: string) => void }) {
    this.asset = { ...asset }
    this.bufferEligible = asset.kind === 'audio' && clip.speed === 1 && asset.size > 0 && asset.size <= MAX_BUFFERED_BYTES && asset.duration <= MAX_BUFFERED_SECONDS
    this.clip = { ...clip }
    this.duration = clipDuration(clip)
    this.callbacks = callbacks
  }

  private createMedia(): HTMLAudioElement {
    if (this.media) return this.media
    this.media = document.createElement('audio')
    this.media.crossOrigin = 'anonymous'
    this.media.preload = 'auto'
    this.media.addEventListener('playing', this.onPlaying)
    this.media.addEventListener('waiting', this.onWaiting)
    this.media.addEventListener('ended', this.onEnded)
    this.media.addEventListener('error', this.onError)
    this.media.src = this.asset.url
    return this.media
  }

  get elapsed(): number {
    if (this.completed) return this.duration
    const elapsed = this.buffer
      ? this.bufferOffset + (this.active && this.context ? this.context.currentTime - this.bufferStarted : 0)
      : ((this.media?.currentTime ?? this.clip.trimIn) - this.clip.trimIn) / this.clip.speed
    return Math.max(0, Math.min(this.duration, elapsed))
  }

  private waitForReady(signal: AbortSignal): Promise<void> {
    const media = this.createMedia()
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => done(new Error('音频加载超时，请检查文件是否仍然可用')), 15000)
      const ready = () => {
        if (media.readyState >= 2 && !media.seeking) done()
      }
      const failure = () => done(new Error('无法读取音频，请重新导入该文件'))
      const abort = () => done(cancelled())
      const done = (error?: Error) => {
        window.clearTimeout(timer)
        for (const event of ['loadeddata', 'canplay', 'seeked']) media.removeEventListener(event, ready)
        media.removeEventListener('error', failure)
        signal.removeEventListener('abort', abort)
        error ? reject(error) : resolve()
      }
      for (const event of ['loadeddata', 'canplay', 'seeked']) media.addEventListener(event, ready)
      media.addEventListener('error', failure)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else if (media.error) failure()
      else ready()
    })
  }

  private silence(): void {
    window.clearTimeout(this.boundaryTimer)
    if (!this.context || !this.gain) return
    this.gain.gain.cancelScheduledValues(this.context.currentTime)
    this.gain.gain.setValueAtTime(0, this.context.currentTime)
  }

  private volumeAt(elapsed: number): number {
    return this.clip.volume * Math.max(0, Math.min(1,
      this.clip.fadeIn > 0 ? elapsed / this.clip.fadeIn : 1,
      this.clip.fadeOut > 0 ? (this.duration - elapsed) / this.clip.fadeOut : 1))
  }

  private scheduleEnvelope(elapsed: number): void {
    if (!this.context || !this.gain) return
    if (elapsed >= this.duration) { this.finish(); return }
    const now = this.context.currentTime
    const parameter = this.gain.gain
    parameter.cancelScheduledValues(now)
    parameter.setValueAtTime(this.volumeAt(elapsed), now)
    // Schedule the piecewise-linear envelope once on the audio thread. Even a
    // busy interface cannot interrupt playback or let sound pass the trim end.
    const points = [this.clip.fadeIn, this.duration - this.clip.fadeOut, this.duration]
    if (this.clip.fadeIn > 0 && this.clip.fadeOut > 0) points.push(this.duration * this.clip.fadeIn / (this.clip.fadeIn + this.clip.fadeOut))
    for (const point of [...new Set(points)].filter(point => point > elapsed && point <= this.duration).sort((a, b) => a - b)) {
      parameter.linearRampToValueAtTime(this.volumeAt(point), now + point - elapsed)
    }
    parameter.setValueAtTime(0, now + this.duration - elapsed)
  }

  private onPlaying = (): void => {
    if (!this.active || this.disposed) return
    this.scheduleEnvelope(this.elapsed)
    this.scheduleBoundary()
  }

  private scheduleBoundary(): void {
    window.clearTimeout(this.boundaryTimer)
    this.boundaryTimer = window.setTimeout(() => {
      if (!this.active || this.disposed) return
      if (this.media && (this.media.currentTime >= this.clip.trimOut - 0.002 || this.media.ended)) this.finish()
      else this.scheduleBoundary()
    }, Math.max(10, (this.duration - this.elapsed) * 1000))
  }

  private onWaiting = (): void => { if (this.active) this.silence() }
  private onEnded = (): void => { if (this.active) this.finish() }
  private onError = (): void => {
    if (!this.active || this.disposed) return
    this.pause()
    this.callbacks.error('无法读取音频，请重新导入该文件')
  }

  private finish(): void {
    this.pause()
    this.completed = true
    this.callbacks.ended()
  }

  private async prepareBuffer(signal: AbortSignal): Promise<void> {
    if (!this.bufferEligible || this.bufferAttempted) return
    let timedOut = false
    const timeout = window.setTimeout(() => {
      if (!signal.aborted) { timedOut = true; this.pending?.abort() }
    }, 15000)
    try {
      // Finish reading before playback. In particular, generated voice WAVs must
      // not depend on repeated native URL range requests while sound is playing.
      const response = await fetch(this.asset.url, { signal })
      if (!response.ok) throw new Error('无法读取音频，请重新导入该文件')
      if (Number(response.headers.get('content-length')) > MAX_BUFFERED_BYTES) {
        await response.body?.cancel()
        this.bufferAttempted = true
        return
      }
      // Do not trust project metadata or a missing Content-Length to bound RAM.
      const reader = response.body?.getReader()
      if (!reader) { this.bufferAttempted = true; return }
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (signal.aborted || this.disposed) throw cancelled()
          if (done) break
          length += value.byteLength
          if (length > MAX_BUFFERED_BYTES) {
            await reader.cancel()
            this.bufferAttempted = true
            return
          }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const bytes = new Uint8Array(length)
      let cursor = 0
      for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.byteLength }
      chunks.length = 0
      try {
        const decoded = await this.context!.decodeAudioData(bytes.buffer)
        if (signal.aborted || this.disposed) throw cancelled()
        if (decoded.duration <= MAX_BUFFERED_SECONDS && decoded.numberOfChannels <= 2) this.buffer = decoded
        this.bufferAttempted = true
      } catch (error) {
        if (signal.aborted || this.disposed) throw cancelled()
        // A supported media container need not also support decodeAudioData.
        // Keep the existing decoder available for those imported audio formats.
        this.bufferAttempted = true
      }
    } catch (error) {
      if (timedOut) throw new Error('音频加载超时，请检查文件是否仍然可用')
      if (signal.aborted || this.disposed) throw cancelled()
      // Some native media protocols are playable but do not support fetch.
      // Preserve that playback path if full-file loading is unavailable.
      this.bufferAttempted = true
    } finally { window.clearTimeout(timeout) }
  }

  private startBuffer(elapsed: number): void {
    const context = this.context!, buffer = this.buffer!
    this.bufferOffset = Math.max(0, Math.min(this.duration, elapsed))
    if (this.bufferOffset >= this.duration) { this.finish(); return }
    const offset = this.clip.trimIn + this.bufferOffset
    if (offset >= buffer.duration) throw new Error('音频裁剪位置超出素材时长')
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain!)
    source.onended = () => { if (this.active && this.bufferSource === source) this.finish() }
    this.bufferSource = source
    this.bufferStarted = context.currentTime
    this.active = true
    this.scheduleEnvelope(this.bufferOffset)
    source.start(this.bufferStarted, offset, this.duration - this.bufferOffset)
  }

  async play(elapsed: number, signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw cancelled()
    this.pause()
    this.completed = false
    const pending = new AbortController()
    this.pending = pending
    const abort = () => { if (this.pending === pending) this.pause() }
    signal?.addEventListener('abort', abort, { once: true })
    const check = () => {
      if (this.disposed || pending.signal.aborted || signal?.aborted || this.pending !== pending) throw cancelled()
    }
    try {
      check()
      if (!this.context) {
        this.context = new AudioContext()
        this.gain = this.context.createGain()
        this.gain.gain.value = 0
        this.gain.connect(this.context.destination)
      }
      if (this.context.state === 'suspended') await this.context.resume()
      check()
      await this.prepareBuffer(pending.signal)
      check()
      if (this.buffer) { this.startBuffer(elapsed); return }
      const media = this.createMedia()
      if (!this.source) {
        this.source = this.context.createMediaElementSource(media)
        this.source.connect(this.gain!)
      }
      await this.waitForReady(pending.signal)
      check()
      if (media.playbackRate !== this.clip.speed) media.playbackRate = this.clip.speed
      const target = this.clip.trimIn + Math.max(0, Math.min(this.duration, elapsed)) * this.clip.speed
      if (Number.isFinite(media.duration) && target >= media.duration) throw new Error('音频裁剪位置超出素材时长')
      if (Math.abs(media.currentTime - target) > 0.002) {
        media.currentTime = target
        await this.waitForReady(pending.signal)
        check()
      }
      this.active = true
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const done = (error?: unknown) => {
          if (settled) return
          settled = true
          window.clearTimeout(timer)
          pending.signal.removeEventListener('abort', stop)
          error ? reject(error) : resolve()
        }
        const stop = () => done(cancelled())
        pending.signal.addEventListener('abort', stop, { once: true })
        const timer = window.setTimeout(() => done(new Error('音频播放超时，请重新试听')), 15000)
        void media.play().then(() => done(), done)
      })
      check()
    } catch (cause) {
      if (this.pending === pending) this.pause()
      throw cause
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.pending === pending) this.pending = undefined
    }
  }

  pause(): void {
    if (this.buffer && this.active) this.bufferOffset = this.elapsed
    this.active = false
    if (this.bufferSource) {
      this.bufferSource.onended = null
      this.bufferSource.stop()
      this.bufferSource.disconnect()
      this.bufferSource = undefined
    }
    this.pending?.abort()
    this.pending = undefined
    this.silence()
    if (this.media && !this.media.paused) this.media.pause()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pause()
    this.media?.removeEventListener('playing', this.onPlaying)
    this.media?.removeEventListener('waiting', this.onWaiting)
    this.media?.removeEventListener('ended', this.onEnded)
    this.media?.removeEventListener('error', this.onError)
    this.media?.removeAttribute('src')
    this.media?.load()
    this.buffer = undefined
    this.source?.disconnect()
    this.gain?.disconnect()
    void this.context?.close().catch(() => {})
  }
}
