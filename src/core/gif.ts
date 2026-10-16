export interface GifSegment { start: number; end: number }
export type GifQuality = 'fast' | 'balanced' | 'high'
export interface GifOptions {
  width: number
  fps: number
  loop: boolean
  quality: GifQuality
  signal?: AbortSignal
  onProgress?: (progress: number) => void
}

export function gifFrameCount(segment: GifSegment, fps: number): number {
  return Math.max(1, Math.ceil((segment.end - segment.start) * fps - 1e-8))
}

export function validateGifSegments(segments: GifSegment[], duration: number): string | null {
  if (!Number.isFinite(duration) || duration <= 0) return '素材时长无效，请重新导入视频。'
  if (!segments.length) return '请至少添加一个片段。'
  if (segments.length > 100) return '最多支持 100 个片段。'
  for (let index = 0; index < segments.length; index++) {
    const { start, end } = segments[index]!
    if (![start, end].every(Number.isFinite) || start < 0 || end <= start || end > duration + 0.001) return `片段 ${index + 1} 的开始与结束时间应在 0–${duration.toFixed(2)} 秒内，且结束晚于开始。`
  }
  return null
}

const palette = new Uint8Array(256 * 3)
for (let index = 0; index < 256; index++) {
  palette[index * 3] = Math.round(((index >> 5) & 7) * 255 / 7)
  palette[index * 3 + 1] = Math.round(((index >> 2) & 7) * 255 / 7)
  palette[index * 3 + 2] = Math.round((index & 3) * 255 / 3)
}
const bayer = [-7.5, 0.5, -5.5, 2.5, 4.5, -3.5, 6.5, -1.5, -4.5, 3.5, -6.5, 1.5, 7.5, -0.5, 5.5, -2.5]

/** Fixed 256-color palette keeps memory bounded while frames are encoded one by one. */
export function quantizeGifFrame(rgba: Uint8ClampedArray | Uint8Array, width: number, quality: GifQuality = 'balanced'): Uint8Array {
  const indexed = new Uint8Array(rgba.length / 4)
  for (let pixel = 0; pixel < indexed.length; pixel++) {
    const offset = pixel * 4
    const alpha = rgba[offset + 3]! / 255
    const threshold = quality === 'fast' ? 0 : bayer[((Math.floor(pixel / width) & 3) << 2) | (pixel & 3)]! / 16
    const strength = quality === 'high' ? 1 : 0.6
    const r = Math.max(0, Math.min(7, Math.round((rgba[offset]! * alpha + 255 * (1 - alpha)) * 7 / 255 + threshold * strength)))
    const g = Math.max(0, Math.min(7, Math.round((rgba[offset + 1]! * alpha + 255 * (1 - alpha)) * 7 / 255 + threshold * strength)))
    const b = Math.max(0, Math.min(3, Math.round((rgba[offset + 2]! * alpha + 255 * (1 - alpha)) * 3 / 255 + threshold * strength)))
    indexed[pixel] = (r << 5) | (g << 2) | b
  }
  return indexed
}

export function encodeGifIndices(pixels: Uint8Array): Uint8Array {
  const bytes: number[] = []
  let buffer = 0
  let bitCount = 0
  let codeSize = 9
  let next = 258
  const dictionary = new Map<number, number>()
  const write = (code: number) => {
    buffer |= code << bitCount
    bitCount += codeSize
    while (bitCount >= 8) { bytes.push(buffer & 255); buffer >>>= 8; bitCount -= 8 }
  }
  write(256)
  let prefix = pixels[0] ?? 0
  for (let index = 1; index < pixels.length; index++) {
    const suffix = pixels[index]!
    const key = (prefix << 8) | suffix
    const found = dictionary.get(key)
    if (found !== undefined) { prefix = found; continue }
    write(prefix)
    // The decoder adds the previous pair after reading this code.
    if (next === (1 << codeSize) && codeSize < 12) codeSize++
    if (next < 4096) dictionary.set(key, next++)
    else {
      write(256)
      dictionary.clear()
      codeSize = 9
      next = 258
    }
    prefix = suffix
  }
  write(prefix)
  if (next === (1 << codeSize) && codeSize < 12) codeSize++
  write(257)
  if (bitCount) bytes.push(buffer & 255)
  const blocks: number[] = [8]
  for (let offset = 0; offset < bytes.length; offset += 255) {
    const length = Math.min(255, bytes.length - offset)
    blocks.push(length, ...bytes.slice(offset, offset + length))
  }
  blocks.push(0)
  return new Uint8Array(blocks)
}

export class GifEncoder {
  readonly width: number
  readonly height: number
  private chunks: Uint8Array[] = []
  private frames = 0
  private closed = false
  constructor(width: number, height: number, loop = true) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) throw new Error('GIF 尺寸应在 1–4096 像素之间。')
    this.width = width
    this.height = height
    this.chunks.push(new Uint8Array([71, 73, 70, 56, 57, 97, width & 255, width >> 8, height & 255, height >> 8, 0xf7, 0, 0]), palette)
    if (loop) this.chunks.push(new Uint8Array([0x21, 0xff, 11, 78, 69, 84, 83, 67, 65, 80, 69, 50, 46, 48, 3, 1, 0, 0, 0]))
  }
  addFrame(rgba: Uint8ClampedArray | Uint8Array, delaySeconds: number, quality: GifQuality = 'balanced'): void {
    if (this.closed) throw new Error('GIF 编码已结束。')
    if (rgba.length !== this.width * this.height * 4) throw new Error('帧尺寸与 GIF 尺寸不一致。')
    const delay = Math.max(2, Math.min(65535, Math.round(delaySeconds * 100)))
    this.chunks.push(new Uint8Array([0x21, 0xf9, 4, 4, delay & 255, delay >> 8, 0, 0, 0x2c, 0, 0, 0, 0, this.width & 255, this.width >> 8, this.height & 255, this.height >> 8, 0]))
    this.chunks.push(encodeGifIndices(quantizeGifFrame(rgba, this.width, quality)))
    this.frames++
  }
  finish(): Blob {
    if (this.closed || !this.frames) throw new Error('GIF 没有可导出的帧。')
    this.closed = true
    this.chunks.push(new Uint8Array([0x3b]))
    const blob = new Blob(this.chunks as BlobPart[], { type: 'image/gif' })
    this.chunks = []
    return blob
  }
  dispose(): void { this.chunks = []; this.closed = true }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('已取消导出。', 'AbortError')
}

async function seekFrame(video: HTMLVideoElement, position: number, signal?: AbortSignal): Promise<void> {
  checkAbort(signal)
  if (Math.abs(video.currentTime - position) < 0.0001 && video.readyState >= 2) return
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error('视频帧读取超时，请缩短片段后重试。')), 15_000)
    const cleanup = () => { clearTimeout(timeout); video.removeEventListener('seeked', ready); video.removeEventListener('error', failed); signal?.removeEventListener('abort', aborted) }
    const finish = (error?: Error) => { cleanup(); error ? reject(error) : resolve() }
    const ready = () => finish()
    const failed = () => finish(new Error('无法解码此视频，请在桌面端导出。'))
    const aborted = () => finish(new DOMException('已取消导出。', 'AbortError'))
    video.addEventListener('seeked', ready, { once: true })
    video.addEventListener('error', failed, { once: true })
    signal?.addEventListener('abort', aborted, { once: true })
    video.currentTime = position
  })
}

export async function createVideoGif(url: string, duration: number, segments: GifSegment[], options: GifOptions): Promise<Blob> {
  const invalid = validateGifSegments(segments, duration)
  if (invalid) throw new Error(invalid)
  if (!Number.isFinite(options.fps) || options.fps < 1 || options.fps > 30 || !Number.isFinite(options.width) || options.width < 32 || options.width > 1920) throw new Error('帧率需为 1–30，宽度需为 32–1920 像素。')
  checkAbort(options.signal)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  let encoder: GifEncoder | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => done(new Error('视频加载超时。')), 20_000)
      const cleanup = () => { clearTimeout(timeout); video.removeEventListener('loadeddata', ready); video.removeEventListener('error', failed); options.signal?.removeEventListener('abort', aborted) }
      const done = (error?: Error) => { cleanup(); error ? reject(error) : resolve() }
      const ready = () => done()
      const failed = () => done(new Error('浏览器无法解码此视频，请在桌面端导出。'))
      const aborted = () => done(new DOMException('已取消导出。', 'AbortError'))
      video.addEventListener('loadeddata', ready, { once: true })
      video.addEventListener('error', failed, { once: true })
      options.signal?.addEventListener('abort', aborted, { once: true })
      video.src = url
    })
    const width = Math.min(Math.round(options.width), video.videoWidth)
    const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth))
    const totalFrames = segments.reduce((sum, segment) => sum + gifFrameCount(segment, options.fps), 0)
    if (totalFrames > 1800 || totalFrames * width * height > 180_000_000) throw new Error('当前片段超出浏览器导出容量，请降低宽度、帧率或缩短片段，也可使用桌面端导出。')
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('无法创建图像画布。')
    encoder = new GifEncoder(width, height, options.loop)
    let completed = 0
    let elapsed = 0
    let encodedDelay = 0
    for (const segment of segments) {
      const frames = gifFrameCount(segment, options.fps)
      for (let frame = 0; frame < frames; frame++) {
        checkAbort(options.signal)
        const position = segment.start + frame / options.fps
        await seekFrame(video, Math.min(position, Math.max(0, duration - 0.001)), options.signal)
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, width, height)
        context.drawImage(video, 0, 0, width, height)
        elapsed += Math.min(1 / options.fps, segment.end - position)
        const centiseconds = Math.max(2, Math.round(elapsed * 100) - encodedDelay)
        encodedDelay += centiseconds
        encoder.addFrame(context.getImageData(0, 0, width, height).data, centiseconds / 100, options.quality)
        options.onProgress?.(++completed / totalFrames)
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    }
    checkAbort(options.signal)
    return encoder.finish()
  } finally {
    encoder?.dispose()
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
}
