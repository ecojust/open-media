const MAX_DIMENSION = 2048
const MAX_PIXELS = 1_048_576
const FALLBACK_SIGMA = 2

/** Small radii retain detail; larger radii can be sampled at a lower resolution. */
export function canvasBlurSize(width: number, height: number, radius: number, fallback: boolean): [number, number] {
  if (![width, height].every(value => Number.isFinite(value) && value > 0) || !Number.isFinite(radius) || radius < 0) throw new Error('模糊画面尺寸或半径无效。')
  const scale = Math.min(1, MAX_DIMENSION / width, MAX_DIMENSION / height, Math.sqrt(MAX_PIXELS / (width * height)), fallback && radius > FALLBACK_SIGMA ? FALLBACK_SIGMA / radius : 1)
  return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))]
}

type Sample = { offset: number; weight: number }
function gaussianSamples(sigma: number, dimension: number): Sample[] {
  if (sigma < 0.05) return [{ offset: 0, weight: 1 }]
  // Extremely thin sources round up to a single pixel. Only the center sample
  // remains visible; integrate the truncated Gaussian without a huge kernel.
  if (dimension === 1 && sigma > 2) return [{ offset: 0, weight: 1 / (Math.sqrt(2 * Math.PI) * sigma * 0.9973002039367398) }]
  const extent = Math.ceil(3 * sigma)
  // Usually sigma <= 2. A one-pixel axis can be larger after rounding the
  // downsampled dimensions; its invisible taps still belong in the normalization.
  let total = 0
  for (let offset = -extent; offset <= extent; offset++) total += Math.exp(-offset * offset / (2 * sigma * sigma))
  const visible = Math.min(extent, dimension - 1), samples: Sample[] = [{ offset: 0, weight: 1 / total }]
  // Linear sampling combines adjacent taps exactly, halving both draw calls and
  // the rounding accumulated by an eight-bit Canvas backing store.
  for (let offset = 1; offset <= visible; offset += 2) {
    const first = Math.exp(-offset * offset / (2 * sigma * sigma)) / total
    const second = offset < visible ? Math.exp(-((offset + 1) ** 2) / (2 * sigma * sigma)) / total : 0
    const weight = first + second, position = offset + second / weight
    samples.push({ offset: -position, weight }, { offset: position, weight })
  }
  return samples
}

/** Consume the returned canvas immediately: both bounded buffers are reused. */
export class CanvasBlurRenderer {
  private first = document.createElement('canvas')
  private second = document.createElement('canvas')
  private firstContext = this.first.getContext('2d')!
  private secondContext = this.second.getContext('2d')!
  private nativeBlur?: boolean
  private sampleKey = ''
  private horizontal: Sample[] = []
  private vertical: Sample[] = []
  private disposed = false

  constructor() {
    if (!this.firstContext || !this.secondContext) throw new Error('当前环境无法渲染模糊效果。')
  }

  private supportsNativeBlur(): boolean {
    if (this.nativeBlur !== undefined) return this.nativeBlur
    const context = this.firstContext
    this.nativeBlur = false
    if (!('filter' in context)) return false
    this.first.width = this.first.height = 7
    try {
      context.filter = 'blur(1px)'
      context.fillStyle = '#fff'
      context.fillRect(3, 3, 1, 1)
      const pixels = context.getImageData(2, 3, 2, 1).data
      this.nativeBlur = pixels[3]! > 0 && pixels[7]! > 0 && pixels[7]! < 255
    } catch { /* Unsupported filters use the Canvas2D convolution below. */ }
    finally { context.filter = 'none' }
    return this.nativeBlur
  }

  private prepare(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, width: number, height: number): void {
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.globalAlpha = 1
    context.globalCompositeOperation = 'source-over'
    context.clearRect(0, 0, width, height)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
  }

  private convolve(source: HTMLCanvasElement, target: CanvasRenderingContext2D, samples: Sample[], horizontal: boolean): void {
    // Add weighted premultiplied RGBA, including transparent pixels beyond the
    // canvas edges. No source pixels are read into JavaScript or sent to WebGL.
    target.globalCompositeOperation = 'lighter'
    for (const sample of samples) {
      target.globalAlpha = sample.weight
      target.drawImage(source, horizontal ? sample.offset : 0, horizontal ? 0 : sample.offset)
    }
    target.globalAlpha = 1
    target.globalCompositeOperation = 'source-over'
  }

  render(source: HTMLCanvasElement, radius: number): HTMLCanvasElement {
    if (this.disposed) throw new Error('模糊渲染器已关闭。')
    if (!Number.isFinite(radius) || radius < 0) throw new Error('模糊半径无效。')
    if (radius === 0) return source
    const native = this.supportsNativeBlur()
    const [width, height] = canvasBlurSize(source.width, source.height, radius, !native)
    this.prepare(this.first, this.firstContext, width, height)
    if (native) {
      this.firstContext.filter = `blur(${radius * Math.min(width / source.width, height / source.height)}px)`
      try { this.firstContext.drawImage(source, 0, 0, width, height) }
      finally { this.firstContext.filter = 'none' }
      return this.first
    }
    this.firstContext.drawImage(source, 0, 0, width, height)
    const key = `${width}:${height}:${radius * width / source.width}:${radius * height / source.height}`
    if (key !== this.sampleKey) {
      this.horizontal = gaussianSamples(radius * width / source.width, width)
      this.vertical = gaussianSamples(radius * height / source.height, height)
      this.sampleKey = key
    }
    this.prepare(this.second, this.secondContext, width, height)
    this.convolve(this.first, this.secondContext, this.horizontal, true)
    this.prepare(this.first, this.firstContext, width, height)
    this.convolve(this.second, this.firstContext, this.vertical, false)
    return this.first
  }

  dispose(): void {
    this.disposed = true
    this.first.width = this.first.height = this.second.width = this.second.height = 1
    this.horizontal = this.vertical = []
  }
}
