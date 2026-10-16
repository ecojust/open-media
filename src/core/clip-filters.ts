import type { ClipFilters } from './types.ts'

/** A row-major 3 × 4 affine transform of straight, normalized sRGB. */
export type ColorMatrix = [number, number, number, number, number, number, number, number, number, number, number, number]

export const DEFAULT_CLIP_FILTERS: Readonly<ClipFilters> = Object.freeze({ enabled: true, intensity: 1, brightness: 0, contrast: 1, saturation: 1, temperature: 0, tint: 0, sepia: 0 })
const IDENTITY: ColorMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]
const PARAMETER_RANGES = { intensity: [0, 1], brightness: [-1, 1], contrast: [0, 2], saturation: [0, 2], temperature: [-1, 1], tint: [-1, 1], sepia: [0, 1] } as const
const PARAMETER_NAMES = { intensity: '强度', brightness: '亮度', contrast: '对比度', saturation: '饱和度', temperature: '色温', tint: '色调', sepia: '复古色' } as const

export function validateClipFilters(value: unknown): ClipFilters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('片段滤镜格式无效。')
  const filters = value as Record<string, unknown>
  if (Object.keys(filters).some(key => key !== 'enabled' && !Object.hasOwn(PARAMETER_RANGES, key))) throw new Error('片段滤镜包含不支持的参数。')
  if (typeof filters.enabled !== 'boolean') throw new Error('片段滤镜开关值无效。')
  for (const [key, range] of Object.entries(PARAMETER_RANGES)) {
    const parameter = filters[key]
    if (typeof parameter !== 'number' || !Number.isFinite(parameter) || parameter < range[0] || parameter > range[1]) throw new Error(`片段滤镜${PARAMETER_NAMES[key as keyof typeof PARAMETER_NAMES]}超出允许范围。`)
  }
  return { enabled: filters.enabled, ...Object.fromEntries(Object.keys(PARAMETER_RANGES).map(key => [key, filters[key]])) } as ClipFilters
}

function preset(id: string, name: string, description: string, adjustments: Partial<ClipFilters>) {
  return Object.freeze({ id, name, description, filters: Object.freeze({ ...DEFAULT_CLIP_FILTERS, ...adjustments }) })
}

export const CLIP_FILTER_PRESETS = Object.freeze([
  preset('original', '原色', '保留素材原有色彩', {}),
  preset('vivid', '鲜明', '提高色彩和明暗层次', { contrast: 1.12, saturation: 1.28, brightness: 0.01 }),
  preset('soft', '柔和', '轻柔明亮的低反差', { contrast: 0.86, saturation: 0.88, brightness: 0.025 }),
  preset('warm', '暖色', '柔暖的日常色彩', { temperature: 0.65, saturation: 1.08, brightness: 0.015 }),
  preset('cool', '冷色', '清爽的蓝调画面', { temperature: -0.65, contrast: 1.04, saturation: 0.92 }),
  preset('cinematic', '电影感', '低饱和冷调与深色层次', { contrast: 1.18, saturation: 0.74, temperature: -0.2, tint: -0.08, brightness: -0.015 }),
  preset('faded', '褪色', '抬高暗部、柔化色彩', { contrast: 0.76, saturation: 0.68, brightness: 0.03, temperature: 0.12 }),
  preset('monochrome', '黑白', '移除颜色、保留明暗', { saturation: 0, contrast: 1.08 }),
  preset('high-contrast', '高反差', '突出明暗对比', { contrast: 1.42, saturation: 1.05 }),
  preset('retro', '复古', '柔和棕色与旧照片质感', { sepia: 0.65, saturation: 0.7, contrast: 0.9, temperature: 0.2 }),
  preset('night', '夜景', '压暗亮度、增加冷色', { brightness: -0.065, contrast: 1.16, saturation: 0.82, temperature: -0.35, tint: 0.05 }),
  preset('sunset', '落日', '温暖浓郁的暮色色调', { temperature: 0.85, tint: 0.18, saturation: 1.16, contrast: 1.06, brightness: 0.02 }),
])

export function matchClipFilterPreset(filters: ClipFilters = { ...DEFAULT_CLIP_FILTERS }): string | undefined {
  const parameters = ['brightness', 'contrast', 'saturation', 'temperature', 'tint', 'sepia'] as const
  return CLIP_FILTER_PRESETS.find(preset => parameters.every(key => Math.abs(preset.filters[key] - filters[key]) < 1e-8))?.id
}

function multiply(left: ColorMatrix, right: ColorMatrix): ColorMatrix {
  const result = Array<number>(12).fill(0) as ColorMatrix
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      result[row * 4 + col] = (col === 3 ? left[row * 4 + 3]! : 0)
      for (let channel = 0; channel < 3; channel++) result[row * 4 + col] += left[row * 4 + channel]! * right[channel * 4 + col]!
    }
  }
  return result
}

/** Contrast/brightness → saturation → sepia → temperature/tint → intensity; clamp only the final RGB. */
export function getClipColorMatrix(filters?: ClipFilters): ColorMatrix {
  if (!filters?.enabled || filters.intensity === 0) return [...IDENTITY]
  const { brightness, contrast, saturation, sepia, temperature, tint, intensity } = filters
  const bias = 0.5 * (1 - contrast) + brightness
  let matrix: ColorMatrix = [contrast, 0, 0, bias, 0, contrast, 0, bias, 0, 0, contrast, bias]
  const luma = [0.2126, 0.7152, 0.0722]
  const saturationMatrix = Array<number>(12).fill(0) as ColorMatrix
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) saturationMatrix[row * 4 + col] = (1 - saturation) * luma[col]! + (row === col ? saturation : 0)
  matrix = multiply(saturationMatrix, matrix)
  const sepiaValues = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131]
  const sepiaMatrix = Array<number>(12).fill(0) as ColorMatrix
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) sepiaMatrix[row * 4 + col] = sepia * sepiaValues[row * 3 + col]! + (row === col ? 1 - sepia : 0)
  matrix = multiply(sepiaMatrix, matrix)
  matrix[3] += 0.1 * temperature + 0.05 * tint
  matrix[7] -= 0.1 * tint
  matrix[11] += -0.1 * temperature + 0.05 * tint
  return matrix.map((value, index) => value * intensity + IDENTITY[index]! * (1 - intensity)) as ColorMatrix
}

export function getClipSvgColorMatrix(filters?: ClipFilters): number[] {
  const m = getClipColorMatrix(filters)
  return [m[0], m[1], m[2], 0, m[3], m[4], m[5], m[6], 0, m[7], m[8], m[9], m[10], 0, m[11], 0, 0, 0, 1, 0]
}

export function isClipFilterIdentity(filters?: ClipFilters): boolean {
  return getClipColorMatrix(filters).every((value, index) => Math.abs(value - IDENTITY[index]!) < 1e-10)
}

/** Operates on straight RGBA bytes and leaves every alpha byte untouched. */
export function applyClipColorMatrix(data: Uint8ClampedArray, matrix: ColorMatrix): void {
  for (let offset = 0; offset + 3 < data.length; offset += 4) {
    const r = data[offset]!, g = data[offset + 1]!, b = data[offset + 2]!
    data[offset] = matrix[0] * r + matrix[1] * g + matrix[2] * b + matrix[3] * 255
    data[offset + 1] = matrix[4] * r + matrix[5] * g + matrix[6] * b + matrix[7] * 255
    data[offset + 2] = matrix[8] * r + matrix[9] * g + matrix[10] * b + matrix[11] * 255
  }
}
