import type { ClipChromaKey } from './types.ts'

export const DEFAULT_CHROMA_KEY: Readonly<ClipChromaKey> = Object.freeze({ enabled: true, color: '#00ff00', similarity: 0.18, blend: 0.08 })

export function validateChromaKey(value: unknown): ClipChromaKey {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('片段抠像配置无效。')
  const key = value as Record<string, unknown>
  if (Object.keys(key).some(field => !['enabled', 'color', 'similarity', 'blend'].includes(field))) throw new Error('片段抠像包含不支持的参数。')
  if (typeof key.enabled !== 'boolean') throw new Error('片段抠像开关无效。')
  if (typeof key.color !== 'string' || !/^#[\da-f]{6}$/i.test(key.color)) throw new Error('片段抠像颜色必须为六位十六进制颜色。')
  if (typeof key.similarity !== 'number' || !Number.isFinite(key.similarity) || key.similarity < 0.01 || key.similarity > 1) throw new Error('片段抠像相似度必须介于 0.01 和 1 之间。')
  if (typeof key.blend !== 'number' || !Number.isFinite(key.blend) || key.blend < 0 || key.blend > 1) throw new Error('片段抠像边缘柔化必须介于 0 和 1 之间。')
  return { enabled: key.enabled, color: key.color.toLowerCase(), similarity: key.similarity, blend: key.blend }
}

export function createChromaKey(overrides: Partial<ClipChromaKey> = {}): ClipChromaKey {
  return validateChromaKey({ ...DEFAULT_CHROMA_KEY, ...overrides })
}

export function isChromaKeyEnabled(key?: ClipChromaKey): boolean { return key?.enabled === true }

/** Normalized straight RGB; uses the same distance as the native color-key filter. */
export function chromaKeyColor(key: ClipChromaKey): [number, number, number] {
  return [1, 3, 5].map(offset => Number.parseInt(key.color.slice(offset, offset + 2), 16) / 255) as [number, number, number]
}

/** Mutates alpha only, preserving existing source transparency and original RGB. */
export function applyChromaKey(data: Uint8ClampedArray, key?: ClipChromaKey): void {
  if (!isChromaKeyEnabled(key)) return
  const [red, green, blue] = chromaKeyColor(key!)
  for (let offset = 0; offset + 3 < data.length; offset += 4) {
    const r = data[offset]! / 255 - red, g = data[offset + 1]! / 255 - green, b = data[offset + 2]! / 255 - blue
    const distance = Math.sqrt((r * r + g * g + b * b) / 3)
    const alpha = key!.blend > 0.0001 ? Math.min(1, Math.max(0, (distance - key!.similarity) / key!.blend)) : Number(distance > key!.similarity)
    data[offset + 3] = data[offset + 3]! * alpha
  }
}
