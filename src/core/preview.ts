import type { Clip, MediaAsset, Project, Track } from './types.ts'
import { isClipFilterIdentity } from './clip-filters.ts'
import { isChromaKeyEnabled } from './chroma-key.ts'
import { ClipFilterRenderer } from './filter-renderer.ts'
import { CanvasBlurRenderer } from './canvas-blur.ts'
import { audioSourceDistance, audioSourceTime } from './audio-loop.ts'
import { animatedClipAt, drawClipOverlay, playbackSpeedAt } from './visual-animation.ts'
import { transitionBlindRects, transitionVisualAt } from './transitions.ts'

export { clipOpacityAt } from './timeline.ts'
import { clipDuration as previewClipDuration, projectDuration as previewDuration, clipOpacityAt, sourceTimeAt as mediaSourceTime } from './timeline.ts'
export { previewClipDuration, previewDuration, mediaSourceTime }

export function fitRect(sourceWidth: number, sourceHeight: number, width: number, height: number, fit: Clip['fit']): [number, number, number, number, number, number, number, number] {
  if (fit === 'fill' || sourceWidth <= 0 || sourceHeight <= 0) return [0, 0, sourceWidth || width, sourceHeight || height, 0, 0, width, height]
  const scale = fit === 'cover' ? Math.max(width / sourceWidth, height / sourceHeight) : Math.min(width / sourceWidth, height / sourceHeight)
  const drawWidth = sourceWidth * scale
  const drawHeight = sourceHeight * scale
  if (fit === 'contain') return [0, 0, sourceWidth, sourceHeight, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight]
  const cropWidth = width / scale
  const cropHeight = height / scale
  return [(sourceWidth - cropWidth) / 2, (sourceHeight - cropHeight) / 2, cropWidth, cropHeight, 0, 0, width, height]
}

/** Draw subtitle content in local clip coordinates; used by preview and native export rasterization. */
export function drawTextClip(ctx: CanvasRenderingContext2D, clip: Clip): void {
  if (clip.overlay) { drawClipOverlay(ctx, clip); return }
  if (clip.textRole === 'watermark' && clip.background && clip.background !== 'transparent') {
    ctx.fillStyle = clip.background
    ctx.fillRect(0, 0, clip.width, clip.height)
  }
  const fontSize = clip.fontSize || 56
  ctx.font = `${clip.fontWeight || 400} ${fontSize}px ${clip.fontFamily || 'sans-serif'}`
  ctx.textAlign = clip.textAlign || 'center'
  ctx.textBaseline = 'middle'
  const maxWidth = Math.max(1, clip.width - 24)
  const lines: string[] = []
  for (const paragraph of (clip.text || '').split('\n')) {
    let line = ''
    for (const char of paragraph) {
      if (line && ctx.measureText(line + char).width > maxWidth) { lines.push(line); line = char } else line += char
    }
    lines.push(line)
  }
  const x = ctx.textAlign === 'left' ? 12 : ctx.textAlign === 'right' ? clip.width - 12 : clip.width / 2
  const lineHeight = fontSize * 1.35
  const padding = Math.min(12, Math.max(0, (clip.height - fontSize) / 2))
  const firstLineY = clip.textVerticalAlign === 'top' ? padding + fontSize / 2
    : clip.textVerticalAlign === 'bottom' ? clip.height - padding - fontSize / 2 - (lines.length - 1) * lineHeight
      : clip.height / 2 - (lines.length - 1) * lineHeight / 2
  if (clip.textRole !== 'watermark' && clip.background && clip.background !== 'transparent') {
    ctx.fillStyle = clip.background
    const horizontalPadding = Math.min(12, fontSize * 0.2)
    const verticalPadding = Math.min(6, fontSize * 0.12)
    // Measure each painted line, rather than the positioning box. All backgrounds
    // are drawn first so the next line cannot cover a preceding line's descenders.
    lines.forEach((line, index) => {
      if (!line.trim()) return
      const metrics = ctx.measureText(line)
      const scale = metrics.width > maxWidth ? maxWidth / metrics.width : 1
      const advance = metrics.width * scale
      const fallbackLeft = ctx.textAlign === 'left' ? 0 : ctx.textAlign === 'right' ? advance : advance / 2
      const leftBearing = Number.isFinite(metrics.actualBoundingBoxLeft) ? metrics.actualBoundingBoxLeft * scale : fallbackLeft
      const rightBearing = Number.isFinite(metrics.actualBoundingBoxRight) ? metrics.actualBoundingBoxRight * scale : advance - fallbackLeft
      const ascent = Number.isFinite(metrics.actualBoundingBoxAscent) ? metrics.actualBoundingBoxAscent : fontSize / 2
      const descent = Number.isFinite(metrics.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : fontSize / 2
      const y = firstLineY + index * lineHeight
      const left = Math.max(0, x - leftBearing - horizontalPadding)
      const top = Math.max(0, y - ascent - verticalPadding)
      const right = Math.min(clip.width, x + rightBearing + horizontalPadding)
      const bottom = Math.min(clip.height, y + descent + verticalPadding)
      if (right > left && bottom > top) ctx.fillRect(left, top, right - left, bottom - top)
    })
  }
  ctx.fillStyle = clip.color || '#ffffff'
  lines.forEach((line, index) => ctx.fillText(line, x, firstLineY + index * lineHeight, maxWidth))
}

type MediaEntry = {
  key: string
  assetId: string
  media: HTMLMediaElement | HTMLImageElement
  source?: MediaElementAudioSourceNode
  gain?: GainNode
  active?: boolean
  timing?: string
  needsSeek?: boolean
  lastSync?: number
  wantsPlayback?: boolean
  playRequest?: Promise<void>
  playError?: unknown
  playbackGeneration?: number
  volume?: number
}

function waitForPlayback(promise: Promise<unknown>, signal: AbortSignal | undefined, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (error?: unknown) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve()
    }
    const abort = () => done(new DOMException('播放已取消', 'AbortError'))
    const timeout = window.setTimeout(() => done(new Error(message)), 10000)
    signal?.addEventListener('abort', abort, { once: true })
    void promise.then(() => done(), done)
    if (signal?.aborted) abort()
  })
}

function waitForMedia(media: HTMLMediaElement | HTMLImageElement, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('已取消导出', 'AbortError'))
  if (media instanceof HTMLImageElement && media.complete && media.naturalWidth) return Promise.resolve()
  if (media instanceof HTMLMediaElement && media.readyState >= 2) return Promise.resolve()
  return new Promise((resolve, reject) => {
    // A seek may drop readyState without firing loadeddata again when it completes.
    const successEvents = media instanceof HTMLImageElement ? ['load'] : ['loadeddata', 'canplay', 'seeked']
    const timeout = window.setTimeout(() => done(new Error('素材加载超时，请检查文件是否仍然可用')), 15000)
    const success = () => {
      if (media instanceof HTMLImageElement ? media.complete && media.naturalWidth > 0 : media.readyState >= 2) done()
    }
    const failure = () => done(new Error('无法读取素材，请重新导入该文件'))
    const abort = () => done(new DOMException('已取消导出', 'AbortError'))
    const done = (error?: Error) => {
      window.clearTimeout(timeout)
      for (const event of successEvents) media.removeEventListener(event, success)
      media.removeEventListener('error', failure)
      signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve()
    }
    for (const event of successEvents) media.addEventListener(event, success)
    media.addEventListener('error', failure, { once: true })
    signal?.addEventListener('abort', abort, { once: true })
    if (media instanceof HTMLMediaElement && media.error) failure()
    else success()
  })
}

/** One media element per clip allows the same source to appear in overlapping layers. */
export class TimelinePreview {
  private project: Project
  private entries = new Map<string, MediaEntry>()
  private assets = new Map<string, MediaAsset>()
  private liveMedia = new WeakSet<HTMLMediaElement | HTMLImageElement>()
  private preloadAll = false
  private filterRenderer?: ClipFilterRenderer
  private blurCanvas?: HTMLCanvasElement
  private blurRenderer?: CanvasBlurRenderer
  private transitionCanvas?: HTMLCanvasElement
  private context: CanvasRenderingContext2D
  private audioContext?: AudioContext
  private destination?: MediaStreamAudioDestinationNode
  private monitorAudio = true
  private disposed = false
  private readyVideoFrames = new Map<HTMLVideoElement, number>()
  private lastTime = 0
  private playing = false
  private playbackGeneration = 0
  private reported = new Set<string>()
  private canvas: HTMLCanvasElement
  private onError?: (message: string) => void

  constructor(canvas: HTMLCanvasElement, project: Project, onError?: (message: string) => void) {
    this.canvas = canvas
    this.onError = onError
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前环境不支持画面预览')
    this.context = context
    this.project = project
    this.setProject(project)
  }

  setProject(project: Project): void {
    this.playbackGeneration++
    this.project = project
    this.assets = new Map(project.assets.map(asset => [asset.id, asset]))
    const valid = new Map<string, string>()
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        const asset = clip.assetId ? this.assets.get(clip.assetId) : undefined
        if (!asset) continue
        valid.set(clip.id, `${asset.id}:${asset.url}`)
      }
    }
    for (const [id, entry] of this.entries) {
      if (valid.get(id) !== entry.key) { this.removeEntry(entry); this.entries.delete(id) }
    }
    this.render(this.lastTime, this.playing)
  }

  private ensureEntries(time: number): Set<string> {
    const wanted: Clip[] = [], upcoming: Clip[] = []
    for (const track of this.project.tracks) for (const clip of track.clips) {
      if (!clip.assetId || !this.assets.has(clip.assetId)) continue
      if (this.preloadAll || time >= clip.start && time < clip.start + previewClipDuration(clip)) wanted.push(clip)
      else if (clip.start > time && clip.start <= time + 2) upcoming.push(clip)
    }
    // 预览只保留当前片段和最多四个即将开始的片段，避免长时间线累积解码器。
    upcoming.sort((left, right) => left.start - right.start)
    wanted.push(...upcoming.slice(0, 4))
    const ids = new Set<string>()
    for (const clip of wanted) {
      ids.add(clip.id)
      if (this.entries.has(clip.id)) continue
      const asset = this.assets.get(clip.assetId!)!
      const entry: MediaEntry = { key: `${asset.id}:${asset.url}`, assetId: asset.id, media: this.createMedia(asset) }
      this.entries.set(clip.id, entry)
      if (this.audioContext) this.connectAudio(entry)
    }
    return ids
  }

  private activeEntries(time: number): MediaEntry[] {
    return this.project.tracks.flatMap(track => track.clips
      .filter(clip => time >= clip.start && time < clip.start + previewClipDuration(clip))
      .map(clip => this.entries.get(clip.id))).filter((entry): entry is MediaEntry => Boolean(entry))
  }

  private createMedia(asset: MediaAsset): HTMLMediaElement | HTMLImageElement {
    if (asset.kind === 'image') {
      const image = new Image()
      this.liveMedia.add(image)
      image.crossOrigin = 'anonymous'
      image.onload = () => { if (!this.disposed && this.liveMedia.has(image)) this.render(this.lastTime, this.playing) }
      image.onerror = () => { if (this.liveMedia.has(image)) this.report(asset.id, `无法预览“${asset.name}”，请重新导入素材`) }
      image.src = asset.url
      return image
    }
    const media = document.createElement(asset.kind === 'video' ? 'video' : 'audio')
    this.liveMedia.add(media)
    media.crossOrigin = 'anonymous'
    media.preload = 'auto'
    if (media instanceof HTMLVideoElement) media.playsInline = true
    media.addEventListener('loadeddata', () => {
      if (this.disposed || !this.liveMedia.has(media)) return
      this.render(this.lastTime, this.playing)
    })
    media.addEventListener('seeked', () => { if (!this.disposed && this.liveMedia.has(media) && !this.playing) this.draw() })
    media.addEventListener('error', () => { if (this.liveMedia.has(media)) this.report(asset.id, `无法预览“${asset.name}”，请重新导入素材`) })
    // Loaded data can precede presentation of the first decoded video frame.
    // A one-shot frame callback also refreshes the resting, paused preview.
    if (media instanceof HTMLVideoElement && typeof media.requestVideoFrameCallback === 'function') {
      const request = media.requestVideoFrameCallback(() => {
        this.readyVideoFrames.delete(media)
        if (!this.disposed && this.liveMedia.has(media)) this.render(this.lastTime, this.playing)
      })
      this.readyVideoFrames.set(media, request)
    }
    media.src = asset.url
    return media
  }

  private report(key: string, message: string): void {
    if (this.reported.has(key)) return
    this.reported.add(key)
    this.onError?.(message)
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.disposed) throw new DOMException('已取消导出', 'AbortError')
    // 完整导出会提前检查所有素材，交互预览则按播放位置加载。
    this.preloadAll = true
    this.render(this.lastTime, this.playing)
    await Promise.all([...this.entries.values()].map(entry => waitForMedia(entry.media, signal)))
  }

  async enableAudio(monitor = true, signal?: AbortSignal): Promise<MediaStream> {
    if (signal?.aborted || this.disposed) throw new DOMException('播放已取消', 'AbortError')
    this.monitorAudio = monitor
    if (!this.audioContext) {
      this.audioContext = new AudioContext()
      this.destination = this.audioContext.createMediaStreamDestination()
      for (const entry of this.entries.values()) this.connectAudio(entry)
    }
    // Input capture may leave the output context in an interrupted state.
    if (this.audioContext.state !== 'running') {
      await waitForPlayback(this.audioContext.resume(), signal, '音频输出未能恢复，请再次点击播放')
    }
    if (signal?.aborted || this.disposed) throw new DOMException('播放已取消', 'AbortError')
    return this.destination!.stream
  }

  private connectAudio(entry: MediaEntry): void {
    if (!(entry.media instanceof HTMLMediaElement) || !this.audioContext || entry.source) return
    entry.source = this.audioContext.createMediaElementSource(entry.media)
    entry.gain = this.audioContext.createGain()
    entry.gain.gain.value = 0
    entry.source.connect(entry.gain)
    entry.gain.connect(this.destination!)
    if (this.monitorAudio) entry.gain.connect(this.audioContext.destination)
  }

  private startEntry(entry: MediaEntry, clipId: string): void {
    const media = entry.media as HTMLMediaElement
    entry.wantsPlayback = true
    if (!media.paused || media.ended || entry.playRequest || entry.playError) return
    const generation = (entry.playbackGeneration || 0) + 1
    entry.playbackGeneration = generation
    const request = media.play().catch(error => {
      // A pause, seek or removed clip can legitimately cancel an outstanding start.
      if (this.disposed || !entry.wantsPlayback || entry.playbackGeneration !== generation || error?.name === 'AbortError') return
      entry.playError = error
      this.report(`play:${clipId}`, '素材播放受到浏览器限制，请点击播放重试')
      throw error
    }).finally(() => {
      if (entry.playRequest === request) entry.playRequest = undefined
    })
    entry.playRequest = request
    // render is synchronous; playReady also awaits the same request for export/startup.
    void request.catch(() => {})
  }

  private stopEntry(entry: MediaEntry): void {
    const hadPlayback = entry.wantsPlayback || Boolean(entry.playRequest)
    entry.wantsPlayback = false
    entry.playbackGeneration = (entry.playbackGeneration || 0) + 1
    entry.playError = undefined
    entry.playRequest = undefined
    if (entry.media instanceof HTMLMediaElement && (!entry.media.paused || hadPlayback)) entry.media.pause()
  }

  /** Explicit user seeks are independent of the continuous playback drift guard. */
  seek(time: number, playing = this.playing): void {
    this.playbackGeneration++
    this.render(time, playing, true)
  }

  private continueSplitVideo(time: number, now: number): void {
    for (const track of this.project.tracks) {
      if (track.kind !== 'video') continue
      for (const clip of track.clips) {
        if (time < clip.start || time >= clip.start + previewClipDuration(clip)) continue
        const waiting = this.entries.get(clip.id)
        if (!waiting || waiting.active || !(waiting.media instanceof HTMLVideoElement)) continue
        const previous = track.clips.find(candidate => {
          if (candidate.id === clip.id || candidate.assetId !== clip.assetId || candidate.speed !== clip.speed || candidate.speedRamp || clip.speedRamp || candidate.freezeFrame || clip.freezeFrame) return false
          if (Math.abs(candidate.start + previewClipDuration(candidate) - clip.start) > 1e-8 || Math.abs(candidate.trimOut - clip.trimIn) > 1e-8) return false
          const entry = this.entries.get(candidate.id)
          return entry?.active && entry.key === waiting.key && entry.media instanceof HTMLVideoElement
            && !entry.media.seeking && entry.media.readyState >= 2
        })
        if (!previous) continue
        // Adjacent slices still describe one continuous decoder timeline. Keep
        // its already-presented frame and audio instead of seeking a new element
        // on the first frame after the cut. Overlapping clips remain independent.
        const continuing = this.entries.get(previous.id)!
        this.entries.set(clip.id, continuing)
        this.entries.set(previous.id, waiting)
        waiting.active = false
        continuing.timing = `${clip.start}:${clip.trimIn}:${clip.trimOut}:${clip.speed}:${JSON.stringify(clip.speedRamp)}:${JSON.stringify(clip.freezeFrame)}`
        continuing.needsSeek = false
        continuing.lastSync = now
      }
    }
  }

  render(time: number, playing = false, forceSeek = false): void {
    if (this.disposed) return
    const wasPlaying = this.playing
    const now = performance.now()
    const resident = this.ensureEntries(time)
    if (!forceSeek && time >= this.lastTime) this.continueSplitVideo(time, now)
    this.lastTime = Math.max(0, time)
    this.playing = playing
    const active = new Set<string>()
    for (const track of this.project.tracks) {
      for (const clip of track.clips) {
        const entry = this.entries.get(clip.id)
        if (!entry || !(entry.media instanceof HTMLMediaElement)) continue
        const media = entry.media
        if (time < clip.start || time >= clip.start + previewClipDuration(clip)) continue
        active.add(clip.id)
        const timing = `${clip.start}:${clip.trimIn}:${clip.trimOut}:${clip.speed}:${JSON.stringify(clip.speedRamp)}:${JSON.stringify(clip.freezeFrame)}`
        if (forceSeek || !entry.active || (playing && !wasPlaying) || entry.timing !== timing) {
          entry.needsSeek = true
          entry.lastSync = now
          entry.playError = undefined
        }
        entry.active = true
        entry.timing = timing
        const asset = clip.assetId ? this.assets.get(clip.assetId) : undefined
        const sourceDuration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : asset?.duration || 0
        const loops = track.kind === 'audio' && clip.trimOut > sourceDuration + 1e-6
        if (media.loop !== loops) media.loop = loops
        const unwrappedSourceTime = mediaSourceTime(clip, time)
        const sourceTime = loops ? audioSourceTime(unwrappedSourceTime, sourceDuration) : unwrappedSourceTime
        // Reassigning rate/volume on every paint can restart native audio processing.
        const rate = playbackSpeedAt(clip, time)
        if (media.preservesPitch !== (clip.speedRamp?.preservePitch !== false)) media.preservesPitch = clip.speedRamp?.preservePitch !== false
        if (media.playbackRate !== rate) {
          try { media.playbackRate = rate } catch { this.report(`speed:${clip.id}`, '当前浏览器无法预览此播放速度，请调整速度或使用导出结果') }
        }
        const canCorrectDrift = playing && !media.paused && !media.seeking && media.readyState >= 3 && !entry.playRequest && now - (entry.lastSync || 0) >= 1000
        const drift = loops ? audioSourceDistance(media.currentTime, sourceTime, sourceDuration) : Math.abs(media.currentTime - sourceTime)
        const drifted = drift > Math.max(0.25 * rate, 0.08)
        if (media.readyState >= 1 && (!media.seeking || forceSeek) && (entry.needsSeek || !playing || (canCorrectDrift && drifted))) {
          const target = Math.min(sourceTime, Number.isFinite(media.duration) ? Math.max(0, media.duration - 0.001) : sourceTime)
          try {
            if (Math.abs(media.currentTime - target) > 0.015) media.currentTime = target
            entry.needsSeek = false
            entry.lastSync = now
          } catch { /* Metadata can arrive while a source is being replaced. */ }
        }
        const fade = clipOpacityAt({ ...clip, opacity: 1 }, time)
        const volume = track.muted || clip.freezeFrame ? 0 : animatedClipAt(clip, time).volume * fade
        if (entry.gain) {
          if (entry.volume !== volume) { entry.gain.gain.value = volume; entry.volume = volume }
          if (media.volume !== 1) media.volume = 1
          if (media.muted) media.muted = false
        } else {
          if (media.volume !== Math.min(1, volume)) media.volume = Math.min(1, volume)
          if (media.muted !== (volume <= 0)) media.muted = volume <= 0
        }
        if (playing && !clip.freezeFrame) this.startEntry(entry, clip.id)
        else if (entry.wantsPlayback || !media.paused) this.stopEntry(entry)
      }
    }
    for (const [id, entry] of this.entries) {
      // 相邻分割片段先交接连续的解码器，再释放离开预加载范围的旧位置。
      if (!resident.has(id)) { this.removeEntry(entry); this.entries.delete(id); continue }
      if (entry.media instanceof HTMLMediaElement && !active.has(id)) {
        entry.active = false
        if (entry.wantsPlayback || !entry.media.paused) this.stopEntry(entry)
        if (entry.gain && entry.volume !== 0) { entry.gain.gain.value = 0; entry.volume = 0 }
      }
    }
    this.draw()
  }

  async playReady(time: number, signal?: AbortSignal): Promise<void> {
    const generation = ++this.playbackGeneration
    await this.waitForSeek(time, signal)
    if (this.disposed || generation !== this.playbackGeneration) throw new DOMException('播放已取消', 'AbortError')
    if (signal?.aborted) throw new DOMException('已取消播放', 'AbortError')
    this.render(time, true)
    const entries = this.activeEntries(time)
    try {
      await waitForPlayback(Promise.all(entries.map(entry => entry.playRequest)), signal, '素材播放启动超时，请再次点击播放')
    } catch (cause) {
      if (generation === this.playbackGeneration) this.pause()
      throw cause
    }
    if (this.disposed || generation !== this.playbackGeneration) throw new DOMException('播放已取消', 'AbortError')
  }

  async seekReady(time: number, signal?: AbortSignal): Promise<void> {
    this.playbackGeneration++
    await this.waitForSeek(time, signal)
  }

  private async waitForSeek(time: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('已取消导出', 'AbortError')
    const generation = this.playbackGeneration
    this.render(time, false, true)
    await Promise.all(this.activeEntries(time).map(entry => waitForMedia(entry.media, signal)))
    if (this.disposed || generation !== this.playbackGeneration) throw new DOMException('播放已取消', 'AbortError')
    this.render(time, false, true)
    await Promise.all([...this.entries.values()].filter(entry => entry.media instanceof HTMLMediaElement && entry.media.seeking).map(entry => new Promise<void>((resolve, reject) => {
      const media = entry.media as HTMLMediaElement
      const timeout = window.setTimeout(() => { cleanup(); reject(new Error('素材定位超时')) }, 10000)
      const finish = () => { cleanup(); resolve() }
      const abort = () => { cleanup(); reject(new DOMException('已取消导出', 'AbortError')) }
      const cleanup = () => { window.clearTimeout(timeout); media.removeEventListener('seeked', finish); signal?.removeEventListener('abort', abort) }
      media.addEventListener('seeked', finish, { once: true })
      signal?.addEventListener('abort', abort, { once: true })
    })))
    this.draw()
  }

  private draw(): void {
    const { context: ctx, project, canvas } = this
    ctx.save()
    ctx.setTransform(canvas.width / project.width, 0, 0, canvas.height / project.height, 0, 0)
    ctx.globalAlpha = 1
    ctx.fillStyle = project.background
    ctx.fillRect(0, 0, project.width, project.height)
    for (const track of [...project.tracks].reverse()) {
      if (track.kind === 'transition') continue
      for (const clip of track.clips) {
        if (this.lastTime < clip.start || this.lastTime >= clip.start + previewClipDuration(clip)) continue
        this.drawClip(clip, track)
      }
    }
    ctx.restore()
  }

  private drawClip(clip: Clip, track: Track): void {
    const ctx = this.context
    ctx.save()
    const animated = animatedClipAt(clip, this.lastTime)
    ctx.globalAlpha = clipOpacityAt(animated, this.lastTime)
    ctx.translate(animated.x + animated.width / 2, animated.y + animated.height / 2)
    ctx.rotate(animated.rotation * Math.PI / 180)
    ctx.scale(animated.width / clip.width, animated.height / clip.height)
    ctx.translate(-clip.width / 2, -clip.height / 2)
    ctx.beginPath()
    ctx.rect(0, 0, clip.width, clip.height)
    ctx.clip()
    const transition = track.kind === 'video' ? transitionVisualAt(this.project, clip.id, this.lastTime) : undefined
    if (transition) {
      if (!(transition.color && ['fade', 'flash-white'].includes(transition.effect))) ctx.globalAlpha *= transition.opacity
      ctx.beginPath()
      if (transition.aperture && transition.visibility <= 0) {
        ctx.rect(0, 0, 0, 0)
      } else if (transition.aperture && transition.visibility < 1) {
        if (transition.aperture === 'circle') ctx.arc(clip.width / 2, clip.height / 2, Math.hypot(clip.width, clip.height) / 2 * transition.visibility, 0, Math.PI * 2)
        else if (transition.aperture === 'radial') {
          ctx.moveTo(clip.width / 2, clip.height / 2)
          ctx.arc(clip.width / 2, clip.height / 2, Math.hypot(clip.width, clip.height) / 2, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * transition.visibility)
          ctx.closePath()
        } else if (transition.aperture === 'diagonal') {
          ctx.moveTo(0, 0); ctx.lineTo(clip.width * 2 * transition.visibility, 0); ctx.lineTo(0, clip.height * 2 * transition.visibility); ctx.closePath()
        } else if (transition.aperture === 'diamond') {
          const x = clip.width / 2, y = clip.height / 2, dx = clip.width * transition.visibility, dy = clip.height * transition.visibility
          ctx.moveTo(x, y - dy); ctx.lineTo(x + dx, y); ctx.lineTo(x, y + dy); ctx.lineTo(x - dx, y); ctx.closePath()
        } else for (const strip of transitionBlindRects(transition.visibility)) ctx.rect(0, strip.y * clip.height, clip.width, strip.height * clip.height)
      } else ctx.rect(transition.mask.x * clip.width, transition.mask.y * clip.height, transition.mask.width * clip.width, transition.mask.height * clip.height)
      ctx.clip()
      ctx.translate(transition.translateX * clip.width, transition.translateY * clip.height)
      ctx.translate(clip.width / 2, clip.height / 2)
      ctx.scale(transition.scale, transition.scale)
      ctx.translate(-clip.width / 2, -clip.height / 2)
    }
    if (clip.overlay?.kind === 'blur') {
      const snapshot = this.blurCanvas ??= document.createElement('canvas')
      if (snapshot.width !== this.canvas.width || snapshot.height !== this.canvas.height) { snapshot.width = this.canvas.width; snapshot.height = this.canvas.height }
      const source = snapshot.getContext('2d')!
      source.clearRect(0, 0, snapshot.width, snapshot.height); source.drawImage(this.canvas, 0, 0)
      // Read the already-composited background in project coordinates. The clip
      // transform and clipping region constrain only where the blur is painted.
      const scaleX = this.canvas.width / this.project.width, scaleY = this.canvas.height / this.project.height
      ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0)
      const blurred = (this.blurRenderer ??= new CanvasBlurRenderer()).render(snapshot, clip.overlay.blurRadius * Math.max(scaleX, scaleY))
      ctx.drawImage(blurred, 0, 0, blurred.width, blurred.height, 0, 0, this.project.width, this.project.height)
    } else if (track.kind === 'text' || clip.text !== undefined) {
      drawTextClip(ctx, clip)
    } else if (track.kind !== 'audio') {
      const media = this.entries.get(clip.id)?.media
      const imageReady = media instanceof HTMLImageElement && media.complete && media.naturalWidth > 0
      const videoReady = media instanceof HTMLVideoElement && media.readyState >= 2 && media.videoWidth > 0
      if (media && (imageReady || videoReady)) {
        const sourceWidth = media instanceof HTMLImageElement ? media.naturalWidth : (media as HTMLVideoElement).videoWidth
        const sourceHeight = media instanceof HTMLImageElement ? media.naturalHeight : (media as HTMLVideoElement).videoHeight
        let source: CanvasImageSource = media as CanvasImageSource
        let width = sourceWidth, height = sourceHeight
        if (!isClipFilterIdentity(clip.filters) || isChromaKeyEnabled(clip.chromaKey)) {
          this.filterRenderer ??= new ClipFilterRenderer()
          const rect = fitRect(sourceWidth, sourceHeight, clip.width, clip.height, clip.fit)
          const canvasScale = Math.max(this.canvas.width / this.project.width, this.canvas.height / this.project.height)
          const scale = Math.min(1, Math.max(rect[6] / rect[2], rect[7] / rect[3]) * canvasScale)
          try {
            const filtered = this.filterRenderer.render(source, sourceWidth, sourceHeight, Math.max(1, Math.ceil(sourceWidth * scale)), Math.max(1, Math.ceil(sourceHeight * scale)), clip.filters, clip.chromaKey)
            source = filtered
            width = filtered.width
            height = filtered.height
          } catch (cause) {
            this.report(`filter:${clip.id}`, `无法绘制片段画面效果：${cause instanceof Error ? cause.message : String(cause)}`)
            ctx.restore()
            return
          }
        }
        const crop = clip.crop ?? { x: 0, y: 0, width: 1, height: 1 }
        const rect = fitRect(width * crop.width, height * crop.height, clip.width, clip.height, clip.fit)
        rect[0] += width * crop.x; rect[1] += height * crop.y
        if (transition && ((transition.blur && transition.blurStrength) || (transition.color && ['fade', 'flash-white'].includes(transition.effect)))) {
          const layer = this.transitionCanvas ??= document.createElement('canvas')
          const canvasScale = Math.max(this.canvas.width / this.project.width, this.canvas.height / this.project.height) * Math.max(animated.width / clip.width, animated.height / clip.height)
          const factor = Math.min(1, canvasScale, 2048 / Math.max(clip.width, clip.height)), w = Math.max(1, Math.ceil(clip.width * factor)), h = Math.max(1, Math.ceil(clip.height * factor))
          if (layer.width !== w || layer.height !== h) { layer.width = w; layer.height = h }
          const original = layer.getContext('2d')!
          original.setTransform(1, 0, 0, 1, 0, 0); original.clearRect(0, 0, w, h); original.save(); original.scale(factor, factor)
          if (transition.color && ['fade', 'flash-white'].includes(transition.effect)) { original.fillStyle = transition.color; original.fillRect(0, 0, clip.width, clip.height); original.globalAlpha = transition.opacity }
          original.drawImage(source, ...rect); original.restore()
          if (transition.blur && transition.blurStrength) {
            const blurred = (this.blurRenderer ??= new CanvasBlurRenderer()).render(layer, transition.blur * factor)
            // Interpolate premultiplied RGBA before applying clip opacity once.
            original.save(); original.globalCompositeOperation = 'destination-in'; original.globalAlpha = 1 - transition.blurStrength; original.fillStyle = '#fff'; original.fillRect(0, 0, w, h)
            original.globalCompositeOperation = 'lighter'; original.globalAlpha = transition.blurStrength; original.drawImage(blurred, 0, 0, blurred.width, blurred.height, 0, 0, w, h); original.restore()
          }
          ctx.drawImage(layer, 0, 0, w, h, 0, 0, clip.width, clip.height)
        } else ctx.drawImage(source, ...rect)
      }
    }
    ctx.restore()
  }

  pause(): void { this.playbackGeneration++; this.render(this.lastTime, false) }

  private removeEntry(entry: MediaEntry): void {
    this.liveMedia.delete(entry.media)
    if (entry.media instanceof HTMLVideoElement) {
      const request = this.readyVideoFrames.get(entry.media)
      if (request !== undefined) entry.media.cancelVideoFrameCallback(request)
      this.readyVideoFrames.delete(entry.media)
    }
    this.stopEntry(entry)
    entry.source?.disconnect()
    entry.gain?.disconnect()
    if (entry.media instanceof HTMLMediaElement) { entry.media.pause(); entry.media.removeAttribute('src'); entry.media.load() }
    else { entry.media.onload = null; entry.media.onerror = null; entry.media.src = '' }
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) this.removeEntry(entry)
    this.entries.clear()
    this.filterRenderer?.dispose()
    this.filterRenderer = undefined
    this.blurRenderer?.dispose()
    this.blurRenderer = undefined
    if (this.transitionCanvas) this.transitionCanvas.width = this.transitionCanvas.height = 1
    this.transitionCanvas = undefined
    if (this.blurCanvas) { this.blurCanvas.width = this.blurCanvas.height = 1; this.blurCanvas = undefined }
    void this.audioContext?.close().catch(() => {})
  }
}
