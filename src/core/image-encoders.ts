import { encodeGifIndices } from './gif.ts'

type ImagePixels = Uint8ClampedArray | Uint8Array

function validatePixels(pixels: ImagePixels, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 40_000_000 || pixels.length !== width * height * 4) throw new Error('图片像素数据无效或尺寸超过限制。')
}

/** Baseline, little-endian TIFF with one uncompressed RGBA strip and unassociated alpha. */
export function encodeTiff(pixels: ImagePixels, width: number, height: number): Blob {
  validatePixels(pixels, width, height)
  const tagCount = 15
  const bitsOffset = 8 + 2 + tagCount * 12 + 4
  const resolutionOffset = bitsOffset + 8
  const pixelsOffset = resolutionOffset + 16
  const bytes = new Uint8Array(pixelsOffset)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 0x4949, true)
  view.setUint16(2, 42, true)
  view.setUint32(4, 8, true)
  view.setUint16(8, tagCount, true)
  let cursor = 10
  const tag = (id: number, type: number, count: number, value: number) => {
    view.setUint16(cursor, id, true)
    view.setUint16(cursor + 2, type, true)
    view.setUint32(cursor + 4, count, true)
    if (type === 3 && count === 1) view.setUint16(cursor + 8, value, true)
    else view.setUint32(cursor + 8, value, true)
    cursor += 12
  }
  tag(256, 4, 1, width)
  tag(257, 4, 1, height)
  tag(258, 3, 4, bitsOffset)
  tag(259, 3, 1, 1)
  tag(262, 3, 1, 2)
  tag(273, 4, 1, pixelsOffset)
  tag(274, 3, 1, 1)
  tag(277, 3, 1, 4)
  tag(278, 4, 1, height)
  tag(279, 4, 1, pixels.length)
  tag(282, 5, 1, resolutionOffset)
  tag(283, 5, 1, resolutionOffset + 8)
  tag(284, 3, 1, 1)
  tag(296, 3, 1, 2)
  tag(338, 3, 1, 2)
  for (let channel = 0; channel < 4; channel++) view.setUint16(bitsOffset + channel * 2, 8, true)
  for (let axis = 0; axis < 2; axis++) {
    view.setUint32(resolutionOffset + axis * 8, 72, true)
    view.setUint32(resolutionOffset + axis * 8 + 4, 1, true)
  }
  return new Blob([bytes, pixels as BlobPart], { type: 'image/tiff' })
}

interface ColorBin { key: number; count: number; r: number; g: number; b: number }
interface ColorBox { colors: ColorBin[]; channel: 'r' | 'g' | 'b'; score: number; count: number }

function colorBox(colors: ColorBin[]): ColorBox {
  const minimum = { r: 255, g: 255, b: 255 }
  const maximum = { r: 0, g: 0, b: 0 }
  let count = 0
  for (const color of colors) {
    count += color.count
    for (const channel of ['r', 'g', 'b'] as const) {
      minimum[channel] = Math.min(minimum[channel], color[channel])
      maximum[channel] = Math.max(maximum[channel], color[channel])
    }
  }
  let channel: 'r' | 'g' | 'b' = 'r'
  for (const candidate of ['g', 'b'] as const) if (maximum[candidate] - minimum[candidate] > maximum[channel] - minimum[channel]) channel = candidate
  return { colors, channel, count, score: colors.length > 1 ? (maximum[channel] - minimum[channel]) * Math.sqrt(count) : 0 }
}

/** Preserve small palettes exactly; larger images use a bounded, image-specific palette. */
function staticGifPalette(pixels: ImagePixels) {
  const counts = new Uint32Array(32768)
  const sums = new Float64Array(32768 * 3)
  let exact: Map<number, number> | undefined = new Map()
  let transparent = false
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3]! < 128) { transparent = true; continue }
    const r = pixels[offset]!, g = pixels[offset + 1]!, b = pixels[offset + 2]!
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    counts[key]++
    sums[key * 3] += r
    sums[key * 3 + 1] += g
    sums[key * 3 + 2] += b
    if (exact) {
      const rgb = (r << 16) | (g << 8) | b
      if (!exact.has(rgb)) exact.set(rgb, exact.size + 1)
      if (exact.size > 255) exact = undefined
    }
  }
  const palette = new Uint8Array(256 * 3)
  const lookup = new Uint8Array(32768)
  if (exact) {
    for (const [rgb, index] of exact) {
      palette[index * 3] = rgb >> 16
      palette[index * 3 + 1] = (rgb >> 8) & 255
      palette[index * 3 + 2] = rgb & 255
    }
  } else {
    const colors: ColorBin[] = []
    for (let key = 0; key < counts.length; key++) {
      const count = counts[key]!
      if (count) colors.push({ key, count, r: sums[key * 3]! / count, g: sums[key * 3 + 1]! / count, b: sums[key * 3 + 2]! / count })
    }
    const boxes = [colorBox(colors)]
    while (boxes.length < 255) {
      let split = 0
      for (let index = 1; index < boxes.length; index++) if (boxes[index]!.score > boxes[split]!.score) split = index
      const box = boxes[split]!
      if (box.score <= 0) break
      box.colors.sort((a, b) => a[box.channel] - b[box.channel])
      let accumulated = 0, midpoint = 0
      for (; midpoint < box.colors.length - 1; midpoint++) {
        accumulated += box.colors[midpoint]!.count
        if (accumulated >= box.count / 2) { midpoint++; break }
      }
      midpoint = Math.max(1, Math.min(box.colors.length - 1, midpoint))
      boxes.splice(split, 1, colorBox(box.colors.slice(0, midpoint)), colorBox(box.colors.slice(midpoint)))
    }
    boxes.forEach((box, index) => {
      const value = index + 1
      let r = 0, g = 0, b = 0
      for (const color of box.colors) {
        lookup[color.key] = value
        r += color.r * color.count
        g += color.g * color.count
        b += color.b * color.count
      }
      palette[value * 3] = Math.round(r / box.count)
      palette[value * 3 + 1] = Math.round(g / box.count)
      palette[value * 3 + 2] = Math.round(b / box.count)
    })
  }
  const indexed = new Uint8Array(pixels.length / 4)
  for (let pixel = 0; pixel < indexed.length; pixel++) {
    const offset = pixel * 4
    if (pixels[offset + 3]! < 128) continue
    const r = pixels[offset]!, g = pixels[offset + 1]!, b = pixels[offset + 2]!
    indexed[pixel] = exact ? exact.get((r << 16) | (g << 8) | b)! : lookup[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)]!
  }
  return { palette, indexed, transparent }
}

/** A single GIF frame. Alpha below 50% is transparent; other pixels are opaque. */
export function encodeStaticGif(pixels: ImagePixels, width: number, height: number): Blob {
  validatePixels(pixels, width, height)
  const { palette, indexed, transparent } = staticGifPalette(pixels)
  return new Blob([
    new Uint8Array([71, 73, 70, 56, 57, 97, width & 255, width >> 8, height & 255, height >> 8, 0xf7, 0, 0]),
    palette,
    new Uint8Array([0x21, 0xf9, 4, transparent ? 5 : 4, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0]),
    encodeGifIndices(indexed) as BlobPart,
    new Uint8Array([0x3b]),
  ], { type: 'image/gif' })
}

export const standardIconSizes = [16, 32, 48, 64, 128, 256] as const

export function validateIconSizes(sizes: readonly number[] = standardIconSizes): number[] {
  if (!sizes.length || sizes.length > standardIconSizes.length || sizes.some(size => !standardIconSizes.includes(size as typeof standardIconSizes[number]))) throw new Error('请选择 16、32、48、64、128 或 256 像素的图标尺寸。')
  return [...new Set(sizes)].sort((a, b) => a - b)
}

export interface IconImage { size: number; blob: Blob }

/** ICO directory entries point to independently encoded square PNG images. */
export async function encodeIcon(images: IconImage[]): Promise<Blob> {
  const sizes = validateIconSizes(images.map(image => image.size))
  if (sizes.length !== images.length) throw new Error('图标不能包含重复尺寸。')
  const entries = [...images].sort((a, b) => a.size - b.size)
  const data = await Promise.all(entries.map(entry => entry.blob.arrayBuffer()))
  const header = new Uint8Array(6 + entries.length * 16)
  const view = new DataView(header.buffer)
  view.setUint16(2, 1, true)
  view.setUint16(4, entries.length, true)
  let offset = header.length
  entries.forEach((entry, index) => {
    const png = new DataView(data[index]!)
    if (png.byteLength < 33 || png.getUint32(0) !== 0x89504e47 || png.getUint32(4) !== 0x0d0a1a0a || png.getUint32(12) !== 0x49484452 || png.getUint32(16) !== entry.size || png.getUint32(20) !== entry.size) throw new Error('图标图像必须为对应尺寸的有效 PNG。')
    const cursor = 6 + index * 16
    view.setUint8(cursor, entry.size === 256 ? 0 : entry.size)
    view.setUint8(cursor + 1, entry.size === 256 ? 0 : entry.size)
    view.setUint16(cursor + 4, 1, true)
    view.setUint16(cursor + 6, 32, true)
    view.setUint32(cursor + 8, png.byteLength, true)
    view.setUint32(cursor + 12, offset, true)
    offset += png.byteLength
  })
  return new Blob([header, ...data], { type: 'image/x-icon' })
}
