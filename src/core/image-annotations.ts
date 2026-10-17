import type { ImagePoint } from './image-crop.ts'

export type ImageBrushStyle = 'pen' | 'marker' | 'dashed'
interface AnnotationBase { id: string; color: string; opacity: number }
export interface ImageTextAnnotation extends AnnotationBase {
  kind: 'text'
  x: number
  y: number
  text: string
  fontSize: number
  fontFamily: string
  fontWeight: number
}
export interface ImageStrokeAnnotation extends AnnotationBase {
  kind: 'stroke'
  points: ImagePoint[]
  width: number
  style: ImageBrushStyle
}
export type ImageAnnotation = ImageTextAnnotation | ImageStrokeAnnotation
export interface ImageAnnotationBounds { x: number; y: number; width: number; height: number }
export const MAX_IMAGE_ANNOTATIONS = 1000
export const MAX_IMAGE_ANNOTATION_POINTS = 200_000
export const MAX_IMAGE_ANNOTATION_TEXT = 200_000

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('图片编辑内容格式无效。')
  return value as Record<string, unknown>
}
function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label}超出允许范围。`)
  return value
}
function text(value: unknown, label: string, limit: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > limit || value.includes('\0')) throw new Error(`${label}无效。`)
  return value
}
function color(value: unknown): string {
  const result = text(value, '文字或笔触颜色', 80)
  if (!/^(?:#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8}|black|white|transparent)$/i.test(result)) throw new Error('文字或笔触颜色须使用十六进制颜色。')
  return result
}

/** Coordinates are source-image pixels, independent of crop, output size and preview zoom. */
export function validateImageAnnotations(value: unknown): ImageAnnotation[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_IMAGE_ANNOTATIONS) throw new Error(`图片最多支持 ${MAX_IMAGE_ANNOTATIONS} 个文字或笔触。`)
  const ids = new Set<string>()
  let pointCount = 0, textCount = 0
  return Array.from(value, item => {
    const annotation = record(item)
    const id = text(annotation.id, '图片编辑标识', 160)
    if (ids.has(id)) throw new Error('图片编辑内容包含重复标识。')
    ids.add(id)
    const base = { id, color: color(annotation.color), opacity: number(annotation.opacity, '文字或笔触不透明度', 0, 1) }
    if (annotation.kind === 'text') {
      const content = text(annotation.text, '图片文字', 20_000, true)
      textCount += content.length
      if (textCount > MAX_IMAGE_ANNOTATION_TEXT) throw new Error('图片中的文字总量过多，请减少文字后再编辑。')
      const fontFamily = text(annotation.fontFamily, '文字字体', 200)
      if (!/^[\p{L}\p{N}\s,_'"-]+$/u.test(fontFamily) || !/[\p{L}\p{N}]/u.test(fontFamily) || /[\r\n\t]/.test(fontFamily)) throw new Error('文字字体格式无效。')
      return {
        ...base, kind: 'text', x: number(annotation.x, '文字横坐标', -10_000_000, 10_000_000), y: number(annotation.y, '文字纵坐标', -10_000_000, 10_000_000), text: content,
        fontSize: number(annotation.fontSize, '文字字号', 4, 2048), fontFamily, fontWeight: number(annotation.fontWeight, '文字字重', 100, 900),
      }
    }
    if (annotation.kind !== 'stroke' || !Array.isArray(annotation.points) || annotation.points.length < 1) throw new Error('图片笔触至少需要一个有效坐标。')
    pointCount += annotation.points.length
    if (pointCount > MAX_IMAGE_ANNOTATION_POINTS) throw new Error('图片笔触过于复杂，请减少笔触后再编辑。')
    if (!['pen', 'marker', 'dashed'].includes(String(annotation.style))) throw new Error('图片笔触风格无效。')
    const points = Array.from(annotation.points, value => {
      const point = record(value)
      return { x: number(point.x, '笔触横坐标', -10_000_000, 10_000_000), y: number(point.y, '笔触纵坐标', -10_000_000, 10_000_000) }
    })
    return { ...base, kind: 'stroke', points, width: number(annotation.width, '笔触宽度', 0.25, 2048), style: annotation.style as ImageBrushStyle }
  })
}

export function cloneImageAnnotations(annotations: readonly ImageAnnotation[]): ImageAnnotation[] {
  return annotations.map(annotation => annotation.kind === 'stroke' ? { ...annotation, points: annotation.points.map(point => ({ ...point })) } : { ...annotation })
}

function textLines(annotation: ImageTextAnnotation): string[] { return annotation.text.replace(/\r\n?/g, '\n').split('\n') }
function setTextStyle(context: CanvasRenderingContext2D, annotation: ImageTextAnnotation): void {
  context.font = `${annotation.fontWeight} ${annotation.fontSize}px ${annotation.fontFamily}`
  context.textAlign = 'left'
  context.textBaseline = 'top'
}

/** One path is composited once, so a translucent stroke does not darken at its own crossings. */
export function drawImageAnnotations(context: CanvasRenderingContext2D, annotations: readonly ImageAnnotation[]): void {
  for (const annotation of annotations) {
    if (annotation.opacity <= 0) continue
    context.save()
    try {
      context.globalCompositeOperation = 'source-over'
      context.globalAlpha *= annotation.opacity
      context.fillStyle = context.strokeStyle = annotation.color
      if (annotation.kind === 'text') {
        setTextStyle(context, annotation)
        textLines(annotation).forEach((line, index) => context.fillText(line, annotation.x, annotation.y + index * annotation.fontSize * 1.25))
        continue
      }
      const first = annotation.points[0]
      if (!first) continue
      context.beginPath()
      if (annotation.points.every(point => point.x === first.x && point.y === first.y)) {
        if (annotation.style === 'marker') context.fillRect(first.x - annotation.width / 2, first.y - annotation.width / 2, annotation.width, annotation.width)
        else { context.arc(first.x, first.y, annotation.width / 2, 0, Math.PI * 2); context.fill() }
        continue
      }
      context.lineWidth = annotation.width
      context.lineCap = annotation.style === 'marker' ? 'butt' : 'round'
      context.lineJoin = annotation.style === 'marker' ? 'bevel' : 'round'
      context.setLineDash(annotation.style === 'dashed' ? [annotation.width * 3, annotation.width * 2] : [])
      context.lineDashOffset = 0
      context.moveTo(first.x, first.y)
      for (let index = 1; index < annotation.points.length; index++) context.lineTo(annotation.points[index]!.x, annotation.points[index]!.y)
      context.stroke()
    } finally { context.restore() }
  }
}

/** Pass the drawing context for exact font advances; the fallback is for geometry-only callers. */
export function imageAnnotationBounds(annotation: ImageAnnotation, context?: CanvasRenderingContext2D): ImageAnnotationBounds {
  if (annotation.kind === 'stroke') {
    if (!annotation.points.length) return { x: 0, y: 0, width: 0, height: 0 }
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
    for (const point of annotation.points) { left = Math.min(left, point.x); right = Math.max(right, point.x); top = Math.min(top, point.y); bottom = Math.max(bottom, point.y) }
    const padding = annotation.width / 2
    return { x: left - padding, y: top - padding, width: right - left + annotation.width, height: bottom - top + annotation.width }
  }
  const lines = textLines(annotation)
  let width = 0
  context?.save()
  try {
    if (context) setTextStyle(context, annotation)
    for (const line of lines) width = Math.max(width, context ? context.measureText(line).width : Array.from(line).length * annotation.fontSize * 0.65)
  } finally { context?.restore() }
  return { x: annotation.x, y: annotation.y, width: Math.max(1, width), height: Math.max(annotation.fontSize, lines.length * annotation.fontSize * 1.25) }
}

function distanceToSegment(point: ImagePoint, start: ImagePoint, end: ImagePoint): number {
  const dx = end.x - start.x, dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  const ratio = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
  return Math.hypot(point.x - start.x - ratio * dx, point.y - start.y - ratio * dy)
}

/** Dashed lines are selected by their whole path so gaps remain easy to grab. */
export function hitImageAnnotation(annotation: ImageAnnotation, point: ImagePoint, tolerance = 0, context?: CanvasRenderingContext2D): boolean {
  if (annotation.opacity <= 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
  const margin = Number.isFinite(tolerance) ? Math.max(0, tolerance) : 0
  const bounds = imageAnnotationBounds(annotation, context)
  if (point.x < bounds.x - margin || point.y < bounds.y - margin || point.x > bounds.x + bounds.width + margin || point.y > bounds.y + bounds.height + margin) return false
  if (annotation.kind === 'text') return !!annotation.text.trim()
  const first = annotation.points[0]
  if (!first) return false
  const radius = annotation.width / 2 + margin
  if (annotation.points.every(item => item.x === first.x && item.y === first.y)) return annotation.style === 'marker' || Math.hypot(point.x - first.x, point.y - first.y) <= radius
  for (let index = 1; index < annotation.points.length; index++) if (distanceToSegment(point, annotation.points[index - 1]!, annotation.points[index]!) <= radius) return true
  return false
}
