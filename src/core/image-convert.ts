export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'bmp'

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
}

export interface ImageConversion {
  blob: Blob
  width: number
  height: number
  format: ImageFormat
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
  const ownedUrl = typeof source !== 'string'
  const url = ownedUrl ? URL.createObjectURL(source) : source
  const image = new Image()
  image.decoding = 'async'
  image.crossOrigin = 'anonymous'
  image.src = url
  try {
    await image.decode()
    signal?.throwIfAborted()
    const dimensions = imageDimensions(image.naturalWidth, image.naturalHeight, options)
    const canvas = document.createElement('canvas')
    canvas.width = dimensions.width
    canvas.height = dimensions.height
    const context = canvas.getContext('2d', { willReadFrequently: options.format === 'bmp' })
    if (!context) throw new Error('当前环境无法创建图片画布。')
    if (!options.transparent || options.format === 'jpeg' || options.format === 'bmp') {
      context.fillStyle = options.background || '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
    }
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.translate(canvas.width / 2, canvas.height / 2)
    context.rotate(options.rotation * Math.PI / 180)
    context.scale(options.flipX ? -1 : 1, options.flipY ? -1 : 1)
    context.drawImage(image, -dimensions.drawWidth / 2, -dimensions.drawHeight / 2, dimensions.drawWidth, dimensions.drawHeight)
    signal?.throwIfAborted()
    let blob: Blob
    if (options.format === 'bmp') {
      blob = encodeBitmap(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
    } else {
      const mime = `image/${options.format}`
      blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => {
        if (!result) reject(new Error('图片编码失败，请减小尺寸后重试。'))
        else if (result.type !== mime) reject(new Error(`当前环境不支持导出 ${options.format.toUpperCase()}，请选择其他格式。`))
        else resolve(result)
      }, mime, Math.max(0.01, Math.min(1, options.quality))))
    }
    signal?.throwIfAborted()
    return { blob, width: canvas.width, height: canvas.height, format: options.format }
  } finally {
    if (ownedUrl) URL.revokeObjectURL(url)
  }
}

export function convertedImageName(name: string, format: ImageFormat): string {
  const stem = name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || '图片'
  return `${stem}.${format === 'jpeg' ? 'jpg' : format}`
}
