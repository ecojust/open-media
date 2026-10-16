import type { Clip, MediaAsset } from './types.ts'
import { clipDuration } from './timeline.ts'

function cancelled(): DOMException { return new DOMException('片段试听已取消', 'AbortError') }

/** The media decoder owns playback time; interface frames only observe it. */
export class ClipAudioPlayer {
  private readonly media: HTMLAudioElement
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
    this.clip = { ...clip }
    this.duration = clipDuration(clip)
    this.callbacks = callbacks
    this.media = document.createElement('audio')
    this.media.crossOrigin = 'anonymous'
    this.media.preload = 'auto'
    this.media.addEventListener('playing', this.onPlaying)
    this.media.addEventListener('waiting', this.onWaiting)
    this.media.addEventListener('ended', this.onEnded)
    this.media.addEventListener('error', this.onError)
    this.media.src = asset.url
  }

  get elapsed(): number {
    return this.completed ? this.duration : Math.max(0, Math.min(this.duration, (this.media.currentTime - this.clip.trimIn) / this.clip.speed))
  }

  private waitForReady(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => done(new Error('音频加载超时，请检查文件是否仍然可用')), 15000)
      const ready = () => {
        if (this.media.readyState >= 2 && !this.media.seeking) done()
      }
      const failure = () => done(new Error('无法读取音频，请重新导入该文件'))
      const abort = () => done(cancelled())
      const done = (error?: Error) => {
        window.clearTimeout(timer)
        for (const event of ['loadeddata', 'canplay', 'seeked']) this.media.removeEventListener(event, ready)
        this.media.removeEventListener('error', failure)
        signal.removeEventListener('abort', abort)
        error ? reject(error) : resolve()
      }
      for (const event of ['loadeddata', 'canplay', 'seeked']) this.media.addEventListener(event, ready)
      this.media.addEventListener('error', failure)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else if (this.media.error) failure()
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

  private onPlaying = (): void => {
    if (!this.active || this.disposed || !this.context || !this.gain) return
    const elapsed = this.elapsed
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
    this.scheduleBoundary()
  }

  private scheduleBoundary(): void {
    window.clearTimeout(this.boundaryTimer)
    this.boundaryTimer = window.setTimeout(() => {
      if (!this.active || this.disposed) return
      if (this.media.currentTime >= this.clip.trimOut - 0.002 || this.media.ended) this.finish()
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
        this.source = this.context.createMediaElementSource(this.media)
        this.gain = this.context.createGain()
        this.gain.gain.value = 0
        this.source.connect(this.gain)
        this.gain.connect(this.context.destination)
      }
      if (this.context.state === 'suspended') await this.context.resume()
      check()
      await this.waitForReady(pending.signal)
      check()
      if (this.media.playbackRate !== this.clip.speed) this.media.playbackRate = this.clip.speed
      const target = this.clip.trimIn + Math.max(0, Math.min(this.duration, elapsed)) * this.clip.speed
      if (Number.isFinite(this.media.duration) && target >= this.media.duration) throw new Error('音频裁剪位置超出素材时长')
      if (Math.abs(this.media.currentTime - target) > 0.002) {
        this.media.currentTime = target
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
        void this.media.play().then(() => done(), done)
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
    this.active = false
    this.pending?.abort()
    this.pending = undefined
    this.silence()
    if (!this.media.paused) this.media.pause()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pause()
    this.media.removeEventListener('playing', this.onPlaying)
    this.media.removeEventListener('waiting', this.onWaiting)
    this.media.removeEventListener('ended', this.onEnded)
    this.media.removeEventListener('error', this.onError)
    this.media.removeAttribute('src')
    this.media.load()
    this.source?.disconnect()
    this.gain?.disconnect()
    void this.context?.close().catch(() => {})
  }
}
