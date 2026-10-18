import type { AnimatedProperty, AnimationEasing, Clip, ClipKeyframes, ClipOverlay, ClipSpeedRamp, ClipTransition, NormalizedRect } from './types.ts'

export const ANIMATED_PROPERTIES: readonly AnimatedProperty[] = ['x', 'y', 'scaleX', 'scaleY', 'opacity', 'rotation', 'volume']
export const ANIMATION_EASINGS: readonly AnimationEasing[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'step']
export function visualRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效。`)
  return value as Record<string, unknown>
}
export function visualNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label}超出允许范围。`)
  return value
}
export function visualChoice<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${label}无效。`)
  return value as T
}
export function visualColor(value: unknown): string {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error('视觉颜色须为六位十六进制颜色。')
  return value
}
export function easeProgress(value: number, easing: AnimationEasing = 'linear'): number {
  const t = Math.min(1, Math.max(0, value))
  switch (easing) {
    case 'ease-in': return t * t
    case 'ease-out': return 1 - (1 - t) ** 2
    case 'ease-in-out': return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
    case 'step': return t >= 1 ? 1 : 0
    default: return t
  }
}
export function validateNormalizedRect(value: unknown): NormalizedRect {
  const r = visualRecord(value, '源画面区域')
  const rect = { x: visualNumber(r.x, '区域横坐标', 0, 1), y: visualNumber(r.y, '区域纵坐标', 0, 1), width: visualNumber(r.width, '区域宽度', 0.001, 1), height: visualNumber(r.height, '区域高度', 0.001, 1) }
  if (rect.x + rect.width > 1 + 1e-9 || rect.y + rect.height > 1 + 1e-9) throw new Error('区域必须完整位于源画面内。')
  return rect
}
export function validateKeyframes(value: unknown, duration: number): ClipKeyframes {
  const r = visualRecord(value, '关键帧')
  const result: ClipKeyframes = {}
  for (const [name, frames] of Object.entries(r)) {
    const key = visualChoice(name, ANIMATED_PROPERTIES, '关键帧属性')
    if (!Array.isArray(frames) || frames.length < 1 || frames.length > 128) throw new Error('每个属性需要 1 至 128 个关键帧。')
    let previous = -1
    result[key] = frames.map(item => {
      const frame = visualRecord(item, '关键帧')
      const time = visualNumber(frame.time, '关键帧时间', 0, duration + 1e-6)
      if (time <= previous) throw new Error('关键帧时间必须严格递增。')
      previous = time
      const limits = key === 'opacity' ? [0, 1] : key === 'volume' ? [0, 2] : key === 'scaleX' || key === 'scaleY' ? [0.01, 16] : key === 'rotation' ? [-3600, 3600] : [-65536, 65536]
      return { time, value: visualNumber(frame.value, '关键帧值', limits[0]!, limits[1]!), ...(frame.easing !== undefined ? { easing: visualChoice(frame.easing, ANIMATION_EASINGS, '缓动') } : {}) }
    })
  }
  return result
}
export function validateSpeedRamp(value: unknown): ClipSpeedRamp {
  const r = visualRecord(value, '变速曲线')
  if (!Array.isArray(r.points) || r.points.length < 2 || r.points.length > 16) throw new Error('变速曲线需要 2 至 16 个点。')
  let previous = -1
  const points = r.points.map(item => { const p = visualRecord(item, '变速点'); const position = visualNumber(p.position, '源位置', 0, 1); if (position <= previous) throw new Error('变速点的位置必须严格递增。'); previous = position; return { position, speed: visualNumber(p.speed, '速度', 0.1, 16) } })
  if (points[0]!.position !== 0 || points.at(-1)!.position !== 1) throw new Error('变速曲线必须包含 0 和 1 两个端点。')
  if (r.preservePitch !== undefined && typeof r.preservePitch !== 'boolean') throw new Error('保持音调开关无效。')
  let sourceRange: { start: number; end: number } | undefined
  if (r.sourceRange !== undefined) { const range = visualRecord(r.sourceRange, '曲线源范围'); sourceRange = { start: visualNumber(range.start, '曲线源起点', 0, 86400), end: visualNumber(range.end, '曲线源终点', 0.001, 86400) }; if (sourceRange.end <= sourceRange.start) throw new Error('曲线源范围无效。') }
  return { points, easing: visualChoice(r.easing ?? 'linear', ANIMATION_EASINGS, '缓动'), preservePitch: r.preservePitch !== false, ...(sourceRange ? { sourceRange } : {}) }
}
export function validateOverlay(value: unknown, width: number, height: number): ClipOverlay {
  const r = visualRecord(value, '视觉标注')
  const result: ClipOverlay = { kind: visualChoice(r.kind, ['arrow', 'rectangle', 'highlight', 'mask', 'spotlight', 'blur'], '标注类型'), color: visualColor(r.color), strokeWidth: visualNumber(r.strokeWidth, '线宽', 1, 100), blurRadius: visualNumber(r.blurRadius, '模糊半径', 1, 50) }
  if (result.kind === 'spotlight') {
    const region = visualRecord(r.region, '聚光区域')
    result.region = { x: visualNumber(region.x, '聚光横坐标', 0, width), y: visualNumber(region.y, '聚光纵坐标', 0, height), width: visualNumber(region.width, '聚光宽度', 1, width), height: visualNumber(region.height, '聚光高度', 1, height) }
    if (result.region.x + result.region.width > width + 1e-6 || result.region.y + result.region.height > height + 1e-6) throw new Error('聚光区域超出画面。')
  }
  return result
}
export function validateTransitionParameters(value: Record<string, unknown>): Partial<ClipTransition> {
  return { ...(value.direction !== undefined ? { direction: visualChoice(value.direction, ['up', 'down', 'left', 'right'] as const, '转场方向') } : {}), ...(value.easing !== undefined ? { easing: visualChoice(value.easing, ANIMATION_EASINGS, '缓动') } : {}), ...(value.color !== undefined ? { color: visualColor(value.color) } : {}), ...(value.blur !== undefined ? { blur: visualNumber(value.blur, '转场模糊', 0, 50) } : {}), ...(value.scope !== undefined ? { scope: visualChoice(value.scope, ['both', 'outgoing', 'incoming'] as const, '转场作用范围') } : {}) }
}
export function keyframeValue(clip: Clip, property: AnimatedProperty, localTime: number, fallback: number): number {
  const frames = clip.keyframes?.[property]
  if (!frames?.length) return fallback
  if (localTime < frames[0]!.time) return fallback
  for (let index = 1; index < frames.length; index++) {
    const from = frames[index - 1]!, to = frames[index]!
    if (localTime < to.time) return from.value + (to.value - from.value) * easeProgress((localTime - from.time) / (to.time - from.time), from.easing)
  }
  return frames.at(-1)!.value
}
export function animatedClipAt(clip: Clip, time: number): Clip {
  if (!clip.keyframes) return clip
  const t = Math.max(0, time - clip.start) + (clip.animationOffset ?? 0)
  const scaleX = keyframeValue(clip, 'scaleX', t, 1), scaleY = keyframeValue(clip, 'scaleY', t, 1)
  return { ...clip, x: keyframeValue(clip, 'x', t, clip.x) + clip.width * (1 - scaleX) / 2, y: keyframeValue(clip, 'y', t, clip.y) + clip.height * (1 - scaleY) / 2, width: clip.width * scaleX, height: clip.height * scaleY, rotation: keyframeValue(clip, 'rotation', t, clip.rotation), opacity: keyframeValue(clip, 'opacity', t, clip.opacity), volume: keyframeValue(clip, 'volume', t, clip.volume) }
}
export interface SpeedSegment { sourceStart: number; sourceEnd: number; timeStart: number; timeEnd: number; speed: number }
export function rampSpeedAt(ramp: ClipSpeedRamp, position: number): number {
  for (let index = 1; index < ramp.points.length; index++) { const a = ramp.points[index - 1]!, b = ramp.points[index]!; if (position <= b.position) return a.speed + (b.speed - a.speed) * easeProgress((position - a.position) / (b.position - a.position), ramp.easing) }
  return ramp.points.at(-1)!.speed
}
/** The same source-space partition is used by playback and native audio/video export. */
export function speedSegments(clip: Clip): SpeedSegment[] {
  const span = clip.trimOut - clip.trimIn
  if (!clip.speedRamp) return [{ sourceStart: clip.trimIn, sourceEnd: clip.trimOut, timeStart: 0, timeEnd: span / clip.speed, speed: clip.speed }]
  const range = clip.speedRamp.sourceRange ?? { start: clip.trimIn, end: clip.trimOut }, fullSpan = range.end - range.start
  const positions = [...new Set([...Array.from({ length: 33 }, (_, i) => i / 32), ...clip.speedRamp.points.map(p => p.position)])].sort((a, b) => a - b)
  const bins = positions.slice(1).map((end, i) => ({ start: range.start + fullSpan * positions[i]!, end: range.start + fullSpan * end, speed: clip.speed * rampSpeedAt(clip.speedRamp!, (positions[i]! + end) / 2) }))
  if (clip.trimIn < range.start) bins.unshift({ start: clip.trimIn, end: range.start, speed: clip.speed * clip.speedRamp.points[0]!.speed })
  if (clip.trimOut > range.end) bins.push({ start: range.end, end: clip.trimOut, speed: clip.speed * clip.speedRamp.points.at(-1)!.speed })
  let time = 0
  return bins.filter(b => b.end > clip.trimIn && b.start < clip.trimOut).map(bin => { const sourceStart = Math.max(bin.start, clip.trimIn), sourceEnd = Math.min(bin.end, clip.trimOut), timeStart = time; time += (sourceEnd - sourceStart) / bin.speed; return { sourceStart, sourceEnd, timeStart, timeEnd: time, speed: bin.speed } })
}
export function visualClipDuration(clip: Clip): number { return Math.max(0, clip.speedRamp ? speedSegments(clip).at(-1)?.timeEnd ?? 0 : (clip.trimOut - clip.trimIn) / clip.speed) }
export function animatedSourceTimeAt(clip: Clip, time: number): number {
  if (clip.freezeFrame) return clip.freezeFrame.sourceTime
  const elapsed = Math.max(0, time - clip.start), segments = speedSegments(clip)
  const segment = segments.find(s => elapsed < s.timeEnd) ?? segments.at(-1)!
  return Math.min(clip.trimOut, segment.sourceStart + Math.max(0, elapsed - segment.timeStart) * segment.speed)
}
export function playbackSpeedAt(clip: Clip, time: number): number {
  const elapsed = Math.max(0, time - clip.start), segments = speedSegments(clip)
  return (segments.find(s => elapsed < s.timeEnd) ?? segments.at(-1)!).speed
}
/** Draw geometric overlays into the same local canvas used for text rasterization. */
export function drawClipOverlay(ctx: CanvasRenderingContext2D, clip: Clip): void {
  const overlay = clip.overlay
  if (!overlay || overlay.kind === 'blur') return
  const w = clip.width, h = clip.height, line = Math.min(overlay.strokeWidth, w / 2, h / 2)
  ctx.fillStyle = overlay.color; ctx.strokeStyle = overlay.color; ctx.lineWidth = line; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
  if (overlay.kind === 'arrow') {
    const head = Math.min(w * 0.4, h * 0.5), cy = h / 2
    ctx.beginPath(); ctx.moveTo(line / 2, cy); ctx.lineTo(w - head, cy); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(w - line / 2, cy); ctx.lineTo(w - head, cy - head); ctx.lineTo(w - head, cy + head); ctx.closePath(); ctx.fill()
  } else if (overlay.kind === 'rectangle') ctx.strokeRect(line / 2, line / 2, w - line, h - line)
  else if (overlay.kind === 'spotlight' && overlay.region) { const r = overlay.region; ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.rect(r.x, r.y, r.width, r.height); ctx.fill('evenodd') }
  else ctx.fillRect(0, 0, w, h)
}
