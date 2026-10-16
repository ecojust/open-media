import type { Clip, MediaAsset, Project, Track } from './types.ts'

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
  if (clip.background && clip.background !== 'transparent') { ctx.fillStyle = clip.background; ctx.fillRect(0, 0, clip.width, clip.height) }
  const fontSize = clip.fontSize || 56
  ctx.font = `${clip.fontWeight || 400} ${fontSize}px ${clip.fontFamily || 'sans-serif'}`
  ctx.fillStyle = clip.color || '#ffffff'
  ctx.textAlign = clip.textAlign || 'center'
  ctx.textBaseline = 'middle'
  const lines: string[] = []
  for (const paragraph of (clip.text || '').split('\n')) {
    let line = ''
    for (const char of paragraph) {
      if (line && ctx.measureText(line + char).width > clip.width - 24) { lines.push(line); line = char } else line += char
    }
    lines.push(line)
  }
  const x = ctx.textAlign === 'left' ? 12 : ctx.textAlign === 'right' ? clip.width - 12 : clip.width / 2
  lines.forEach((line, index) => ctx.fillText(line, x, clip.height / 2 + (index - (lines.length - 1) / 2) * fontSize * 1.35, Math.max(1, clip.width - 24)))

}

type MediaEntry = { key: string; assetId: string; media: HTMLMediaElement | HTMLImageElement; source?: MediaElementAudioSourceNode; gain?: GainNode }

function waitForMedia(media: HTMLMediaElement | HTMLImageElement, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('已取消导出', 'AbortError'))
  if (media instanceof HTMLImageElement && media.complete && media.naturalWidth) return Promise.resolve()
  if (media instanceof HTMLMediaElement && media.readyState >= 2) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const successEvent = media instanceof HTMLImageElement ? 'load' : 'loadeddata'
    const timeout = window.setTimeout(() => done(new Error('素材加载超时，请检查文件是否仍然可用')), 15000)
    const success = () => done()
    const failure = () => done(new Error('无法读取素材，请重新导入该文件'))
    const abort = () => done(new DOMException('已取消导出', 'AbortError'))
    const done = (error?: Error) => {
      window.clearTimeout(timeout)
      media.removeEventListener(successEvent, success)
      media.removeEventListener('error', failure)
      signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve()
    }
    media.addEventListener(successEvent, success, { once: true })
    media.addEventListener('error', failure, { once: true })
    signal?.addEventListener('abort', abort, { once: true })
    if (media instanceof HTMLMediaElement && media.error) failure()
  })
}

/** One media element per clip allows the same source to appear in overlapping layers. */
export class TimelinePreview {
  private project: Project
  private entries = new Map<string, MediaEntry>()
  private context: CanvasRenderingContext2D
  private audioContext?: AudioContext
  private destination?: MediaStreamAudioDestinationNode
  private monitorAudio = true
  private disposed = false
  private lastTime = 0
  private playing = false
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
    this.project = project
    const valid = new Set<string>()
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        const asset = project.assets.find(item => item.id === clip.assetId)
        if (!asset) continue
        valid.add(clip.id)
        const key = `${asset.id}:${asset.url}`
        const previous = this.entries.get(clip.id)
        if (previous?.key === key) continue
        if (previous) this.removeEntry(previous)
        const media = this.createMedia(asset)
        const entry: MediaEntry = { key, assetId: asset.id, media }
        this.entries.set(clip.id, entry)
        if (this.audioContext) this.connectAudio(entry)
      }
    }
    for (const [id, entry] of this.entries) {
      if (!valid.has(id)) { this.removeEntry(entry); this.entries.delete(id) }
    }
    this.render(this.lastTime, this.playing)
  }

  private createMedia(asset: MediaAsset): HTMLMediaElement | HTMLImageElement {
    if (asset.kind === 'image') {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      image.onload = () => { if (!this.disposed) this.render(this.lastTime, this.playing) }
      image.onerror = () => this.report(asset.id, `无法预览“${asset.name}”，请重新导入素材`)
      image.src = asset.url
      return image
    }
    const media = document.createElement(asset.kind === 'video' ? 'video' : 'audio')
    media.crossOrigin = 'anonymous'
    media.preload = 'auto'
    if (media instanceof HTMLVideoElement) media.playsInline = true
    media.src = asset.url
    media.addEventListener('loadeddata', () => { if (!this.disposed) this.render(this.lastTime, this.playing) })
    media.addEventListener('seeked', () => { if (!this.disposed && !this.playing) this.draw() })
    media.addEventListener('error', () => this.report(asset.id, `无法预览“${asset.name}”，请重新导入素材`))
    return media
  }

  private report(key: string, message: string): void {
    if (this.reported.has(key)) return
    this.reported.add(key)
    this.onError?.(message)
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    await Promise.all([...this.entries.values()].map(entry => waitForMedia(entry.media, signal)))
  }

  async enableAudio(monitor = true): Promise<MediaStream> {
    this.monitorAudio = monitor
    if (!this.audioContext) {
      this.audioContext = new AudioContext()
      this.destination = this.audioContext.createMediaStreamDestination()
      for (const entry of this.entries.values()) this.connectAudio(entry)
    }
    if (this.audioContext.state === 'suspended') await this.audioContext.resume()
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

  render(time: number, playing = false): void {
    if (this.disposed) return
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
        const sourceTime = mediaSourceTime(clip, time)
        if (media.readyState >= 1 && Math.abs(media.currentTime - sourceTime) > (playing ? 0.18 : 0.015)) {
          try { media.currentTime = Math.min(sourceTime, Number.isFinite(media.duration) ? Math.max(0, media.duration - 0.001) : sourceTime) } catch { /* Metadata can arrive while a source is being replaced. */ }
        }
        try { media.playbackRate = clip.speed } catch { this.report(`speed:${clip.id}`, '当前浏览器无法预览此播放速度，请调整速度或使用导出结果') }
        const fade = clipOpacityAt({ ...clip, opacity: 1 }, time)
        const volume = track.muted ? 0 : clip.volume * fade
        if (entry.gain) { entry.gain.gain.value = volume; media.volume = 1; media.muted = false }
        else { media.volume = Math.min(1, volume); media.muted = volume <= 0 }
        if (playing && media.paused) media.play().catch(() => this.report(`play:${clip.id}`, '素材播放受到浏览器限制，请点击播放重试'))
        if (!playing && !media.paused) media.pause()
      }
    }
    for (const [id, entry] of this.entries) {
      if (entry.media instanceof HTMLMediaElement && !active.has(id)) {
        entry.media.pause()
        if (entry.gain) entry.gain.gain.value = 0
      }
    }
    this.draw()
  }

  async playReady(time: number): Promise<void> {
    this.render(time, true)
    await Promise.all(this.project.tracks.flatMap(track => track.clips.filter(clip => time >= clip.start && time < clip.start + previewClipDuration(clip)).map(clip => this.entries.get(clip.id)?.media).filter((media): media is HTMLMediaElement => media instanceof HTMLMediaElement).map(media => media.play())))
  }

  async seekReady(time: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('已取消导出', 'AbortError')
    this.render(time, false)
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
    ctx.globalAlpha = clipOpacityAt(clip, this.lastTime)
    ctx.translate(clip.x + clip.width / 2, clip.y + clip.height / 2)
    ctx.rotate(clip.rotation * Math.PI / 180)
    ctx.translate(-clip.width / 2, -clip.height / 2)
    ctx.beginPath()
    ctx.rect(0, 0, clip.width, clip.height)
    ctx.clip()
    if (track.kind === 'text' || clip.text !== undefined) {
      drawTextClip(ctx, clip)
    } else if (track.kind !== 'audio') {
      const media = this.entries.get(clip.id)?.media
      const imageReady = media instanceof HTMLImageElement && media.complete && media.naturalWidth > 0
      const videoReady = media instanceof HTMLVideoElement && media.readyState >= 2 && media.videoWidth > 0
      if (media && (imageReady || videoReady)) {
        const sourceWidth = media instanceof HTMLImageElement ? media.naturalWidth : (media as HTMLVideoElement).videoWidth
        const sourceHeight = media instanceof HTMLImageElement ? media.naturalHeight : (media as HTMLVideoElement).videoHeight
        ctx.drawImage(media as CanvasImageSource, ...fitRect(sourceWidth, sourceHeight, clip.width, clip.height, clip.fit))
      }
    }
    ctx.restore()
  }

  pause(): void { this.render(this.lastTime, false) }

  private removeEntry(entry: MediaEntry): void {
    entry.source?.disconnect()
    entry.gain?.disconnect()
    if (entry.media instanceof HTMLMediaElement) { entry.media.pause(); entry.media.removeAttribute('src'); entry.media.load() }
    else { entry.media.onload = null; entry.media.onerror = null; entry.media.src = '' }
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) this.removeEntry(entry)
    this.entries.clear()
    void this.audioContext?.close()
  }
}
