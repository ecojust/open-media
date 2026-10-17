import { validateImageCrop, type ImageCrop } from './image-crop.ts'
import { encodeIcon, encodeStaticGif, encodeTiff, validateIconSizes } from './image-encoders.ts'
import { drawImageAnnotations, validateImageAnnotations, type ImageAnnotation } from './image-annotations.ts'

export { standardIconSizes, validateIconSizes } from './image-encoders.ts'
export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'bmp' | 'ico' | 'gif' | 'tiff' | 'avif'

export interface ImageFormatOption {
  value: ImageFormat
  label: string
  description: string
  supportsTransparency: boolean
  supportsQuality: boolean
}

export const imageFormatOptions: readonly ImageFormatOption[] = [
  { value: 'png', label: 'PNG', description: '无损图片，保留透明度。', supportsTransparency: true, supportsQuality: false },
  { value: 'jpeg', label: 'JPEG', description: '适合照片，透明区域填充为背景色。', supportsTransparency: false, supportsQuality: true },
  { value: 'webp', label: 'WebP', description: '压缩图片，支持透明度。', supportsTransparency: true, supportsQuality: true },
  { value: 'bmp', label: 'BMP', description: '未压缩位图，透明区域填充为背景色。', supportsTransparency: false, supportsQuality: false },
  { value: 'ico', label: 'ICO 图标', description: '一个文件包含多种尺寸；图像保持比例，空白区域保留透明或填充背景色。', supportsTransparency: true, supportsQuality: false },
  { value: 'gif', label: 'GIF 静态图片', description: '单帧、最多 255 种颜色；透明度低于 50% 的像素透明，其余像素不透明。', supportsTransparency: true, supportsQuality: false },
  { value: 'tiff', label: 'TIFF', description: '无损 RGBA 图片，保留完整透明度；未压缩文件体积较大。', supportsTransparency: true, supportsQuality: false },
  { value: 'avif', label: 'AVIF', description: '高压缩率图片，支持透明度；当前环境支持编码时可用。', supportsTransparency: true, supportsQuality: true },
]

export interface ImageConvertOptions {
  format: ImageFormat
  quality: number
  width?: number
  height?: number
  keepAspect: boolean
  allowUpscale: boolean
  rotation: 0 | 90 | 180 | 270
  flipX: boolean
  flipY: boolean
  background: string
  transparent: boolean
  crop?: ImageCrop
  iconSizes?: number[]
  annotations?: ImageAnnotation[]
}

export interface ImageConversion {
  blob: Blob
  width: number
  height: number
  format: ImageFormat
  previewBlob?: Blob
  iconSizes?: number[]
}

/** Probe the actual encoder, because unsupported MIME types silently fall back to PNG. */
export async function getSupportedImageFormats(): Promise<ImageFormat[]> {
  if (typeof document === 'undefined') return imageFormatOptions.filter(item => ['bmp', 'ico', 'gif', 'tiff'].includes(item.value)).map(item => item.value)
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 2
  const supported = await Promise.all(imageFormatOptions.map(async item => {
    if (!['png', 'jpeg', 'webp', 'avif'].includes(item.value)) return true
    try {
      return await new Promise<boolean>(resolve => canvas.toBlob(blob => resolve(!!blob?.size && blob.type === `image/${item.value}`), `image/${item.value}`, 0.9))
    } catch { return false }
  }))
  return imageFormatOptions.filter((_, index) => supported[index]).map(item => item.value)
}

function encodeCanvas(canvas: HTMLCanvasElement, format: 'png' | 'jpeg' | 'webp' | 'avif', quality: number): Promise<Blob> {
  const mime = `image/${format}`
  return new Promise((resolve, reject) => canvas.toBlob(result => {
    if (!result) reject(new Error('图片编码失败，请减小尺寸后重试。'))
    else if (result.type !== mime) reject(new Error(`当前环境不支持导出 ${format.toUpperCase()}，请选择其他格式。`))
    else resolve(result)
  }, mime, Math.max(0.01, Math.min(1, quality))))
}

export const imageDefaults: ImageConvertOptions = {
  format: 'png', quality: 0.9, keepAspect: true, allowUpscale: false,
  rotation: 0, flipX: false, flipY: false, background: '#ffffff', transparent: true,
}

export function imageDimensions(sourceWidth: number, sourceHeight: number, options: Pick<ImageConvertOptions, 'width' | 'height' | 'keepAspect' | 'allowUpscale' | 'rotation'>): { width: number; height: number; drawWidth: number; drawHeight: number } {
  if (![sourceWidth, sourceHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error('图片尺寸无效。')
  for (const value of [options.width, options.height]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 1 || value > 16384)) throw new Error('目标尺寸须在 1 至 16384 像素之间。')
  }
  let width = options.width ?? sourceWidth
  let height = options.height ?? sourceHeight
  if (options.keepAspect) {
    const ratios = [options.width ? options.width / sourceWidth : Infinity, options.height ? options.height / sourceHeight : Infinity]
    let scale = Math.min(...ratios)
    if (!Number.isFinite(scale)) scale = 1
    if (!options.allowUpscale) scale = Math.min(scale, 1)
    width = sourceWidth * scale
    height = sourceHeight * scale
  } else if (!options.allowUpscale) {
    width = Math.min(width, sourceWidth)
    height = Math.min(height, sourceHeight)
  }
  width = Math.max(1, Math.round(width))
  height = Math.max(1, Math.round(height))
  if (width * height > 40_000_000) throw new Error('目标图片超过 4000 万像素，请减小尺寸。')
  const swapped = options.rotation === 90 || options.rotation === 270
  return { width: swapped ? height : width, height: swapped ? width : height, drawWidth: width, drawHeight: height }
}

/** Encode an opaque, bottom-up 24-bit bitmap with padded pixel rows. */
export function encodeBitmap(pixels: Uint8ClampedArray, width: number, height: number): Blob {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || pixels.length !== width * height * 4) throw new Error('位图像素数据无效。')
  const stride = (width * 3 + 3) & ~3
  const size = 54 + stride * height
  const data = new Uint8Array(size)
  const header = new DataView(data.buffer)
  data[0] = 0x42
  data[1] = 0x4d
  header.setUint32(2, size, true)
  header.setUint32(10, 54, true)
  header.setUint32(14, 40, true)
  header.setInt32(18, width, true)
  header.setInt32(22, height, true)
  header.setUint16(26, 1, true)
  header.setUint16(28, 24, true)
  header.setUint32(34, stride * height, true)
  header.setInt32(38, 2835, true)
  header.setInt32(42, 2835, true)
  for (let y = 0; y < height; y++) {
    let target = 54 + (height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4
      data[target++] = pixels[source + 2]!
      data[target++] = pixels[source + 1]!
      data[target++] = pixels[source]!
    }
  }
  return new Blob([data], { type: 'image/bmp' })
}

export async function convertImage(source: string | Blob, options: ImageConvertOptions, signal?: AbortSignal): Promise<ImageConversion> {
  signal?.throwIfAborted()
  const annotations = validateImageAnnotations(options.annotations)
  const ownedUrl = typeof source !== 'string'
  const url = ownedUrl ? URL.createObjectURL(source) : source
  const image = new Image()
  image.decoding = 'async'
  image.crossOrigin = 'anonymous'
  image.src = url
  try {
    await image.decode()
    signal?.throwIfAborted()
    if (!imageFormatOptions.some(item => item.value === options.format)) throw new Error('不支持这个图片输出格式。')
    const crop = validateImageCrop(options.crop, image.naturalWidth, image.naturalHeight)
    const iconSizes = options.format === 'ico' ? validateIconSizes(options.iconSizes) : undefined
    const iconSize = iconSizes?.at(-1)
    const dimensions = imageDimensions(crop.width, crop.height, iconSize ? { ...options, width: iconSize, height: iconSize, keepAspect: true } : options)
    const canvas = document.createElement('canvas')
    canvas.width = dimensions.width
    canvas.height = dimensions.height
    const context = canvas.getContext('2d', { willReadFrequently: ['bmp', 'gif', 'tiff'].includes(options.format) })
    if (!context) throw new Error('当前环境无法创建图片画布。')
    if (!options.transparent || options.format === 'jpeg' || options.format === 'bmp') {
      context.fillStyle = options.background || '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
    }
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.save()
    context.translate(canvas.width / 2, canvas.height / 2)
    context.rotate(options.rotation * Math.PI / 180)
    context.scale(options.flipX ? -1 : 1, options.flipY ? -1 : 1)
    context.drawImage(image, crop.x, crop.y, crop.width, crop.height, -dimensions.drawWidth / 2, -dimensions.drawHeight / 2, dimensions.drawWidth, dimensions.drawHeight)
    if (annotations.length) {
      context.translate(-dimensions.drawWidth / 2, -dimensions.drawHeight / 2)
      context.scale(dimensions.drawWidth / crop.width, dimensions.drawHeight / crop.height)
      context.translate(-crop.x, -crop.y)
      context.beginPath()
      context.rect(crop.x, crop.y, crop.width, crop.height)
      context.clip()
      drawImageAnnotations(context, annotations)
    }
    context.restore()
    signal?.throwIfAborted()
    let blob: Blob
    let previewBlob: Blob | undefined
    if (options.format === 'bmp') {
      blob = encodeBitmap(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
    } else if (options.format === 'gif') {
      blob = encodeStaticGif(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
    } else if (options.format === 'tiff') {
      blob = encodeTiff(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
      previewBlob = await encodeCanvas(canvas, 'png', 1)
    } else if (iconSizes) {
      const entries = []
      for (const size of iconSizes) {
        signal?.throwIfAborted()
        const icon = document.createElement('canvas')
        icon.width = size
        icon.height = size
        const iconContext = icon.getContext('2d')
        if (!iconContext) throw new Error('当前环境无法创建图标画布。')
        if (!options.transparent) {
          iconContext.fillStyle = options.background || '#ffffff'
          iconContext.fillRect(0, 0, size, size)
        }
        const scale = Math.min(size / canvas.width, size / canvas.height, options.allowUpscale ? Infinity : 1)
        const width = Math.max(1, Math.round(canvas.width * scale))
        const height = Math.max(1, Math.round(canvas.height * scale))
        iconContext.imageSmoothingEnabled = true
        iconContext.imageSmoothingQuality = 'high'
        iconContext.drawImage(canvas, Math.floor((size - width) / 2), Math.floor((size - height) / 2), width, height)
        const png = await encodeCanvas(icon, 'png', 1)
        entries.push({ size, blob: png })
        previewBlob = png
      }
      blob = await encodeIcon(entries)
    } else {
      blob = await encodeCanvas(canvas, options.format as 'png' | 'jpeg' | 'webp' | 'avif', options.quality)
    }
    signal?.throwIfAborted()
    return { blob, width: iconSize ?? canvas.width, height: iconSize ?? canvas.height, format: options.format, ...(previewBlob ? { previewBlob } : {}), ...(iconSizes ? { iconSizes } : {}) }
  } finally {
    if (ownedUrl) URL.revokeObjectURL(url)
  }
}

export function convertedImageName(name: string, format: ImageFormat): string {
  const stem = name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || '图片'
  return `${stem}.${format === 'jpeg' ? 'jpg' : format}`
}
