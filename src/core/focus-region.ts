import type { Clip, ClipKeyframe, ClipKeyframes, NormalizedRect } from './types.ts'
import { ANIMATION_EASINGS, keyframeValue, validateKeyframes, validateNormalizedRect, visualChoice, visualClipDuration, visualNumber } from './visual-animation.ts'

export const FOCUS_PROPERTIES = ['x', 'y', 'scaleX', 'scaleY'] as const
export function hasFocusAnimation(clip: Clip): boolean { return FOCUS_PROPERTIES.some(key => !!clip.keyframes?.[key]?.length) }

function focusRotation(clip: Clip, start: number, end: number): number {
  const offset = clip.animationOffset ?? 0, from = start + offset, to = end + offset
  const rotation = keyframeValue(clip, 'rotation', from, clip.rotation)
  // Each supported easing is monotonic between its endpoints. Evaluating the window edges and
  // every enclosed keyframe also catches return curves and the first-keyframe jump from fallback.
  const samples = [to, ...(clip.keyframes?.rotation ?? []).filter(frame => frame.time > from && frame.time < to).map(frame => frame.time)]
  if (samples.some(time => Math.abs(keyframeValue(clip, 'rotation', time, clip.rotation) - rotation) > 1e-8)) {
    throw new Error('聚焦生效期间存在旋转动画，请移除该时段的旋转关键帧，或将聚焦调整到旋转完成后。')
  }
  return rotation * Math.PI / 180
}

/** Project coordinates and preview selections use the same center-based rotation as the renderer. */
export function focusLocalPoint(clip: Pick<Clip, 'x' | 'y' | 'width' | 'height' | 'rotation'>, point: { x: number; y: number }): { x: number; y: number } {
  const angle = -clip.rotation * Math.PI / 180, dx = point.x - clip.x - clip.width / 2, dy = point.y - clip.y - clip.height / 2
  return { x: (dx * Math.cos(angle) - dy * Math.sin(angle)) / clip.width + .5, y: (dx * Math.sin(angle) + dy * Math.cos(angle)) / clip.height + .5 }
}

/** A focus window writes ordinary keyframes, shared by live preview, snapshots and final export. */
export function buildFocusAnimation(clip: Clip, args: Record<string, unknown>): { keyframes: ClipKeyframes; region: NormalizedRect; start: number; end: number; scale: number } {
  const region = validateNormalizedRect(args.region), length = visualClipDuration(clip)
  const start = visualNumber(args.start ?? 0, '聚焦开始时间', 0, length)
  const duration = visualNumber(args.duration ?? Math.min(1, length - start), '放大时长', .01, length - start)
  const hold = visualNumber(args.holdDuration ?? 0, '停留时长', 0, length)
  const restore = visualNumber(args.returnDuration ?? 0, '恢复时长', 0, length)
  if (start + duration + hold + restore > length + 1e-6) throw new Error('放大、停留与恢复的总时长超出片段，请缩短时长或提前起点。')
  const maxScale = visualNumber(args.maxScale ?? 3, '最大放大倍数', 1, 16)
  const strength = visualNumber(args.strength ?? 1, '聚焦强度', .05, 1)
  const easing = visualChoice(args.easing ?? 'ease-in-out', ANIMATION_EASINGS, '缓动')
  if (args.replaceExisting !== undefined && typeof args.replaceExisting !== 'boolean') throw new Error('替换已有动画开关无效。')
  if (hasFocusAnimation(clip) && args.replaceExisting !== true) throw new Error('此片段已有位置或缩放动画；请明确选择替换，避免覆盖已有关键帧。')
  const peak = start + duration, holdEnd = peak + hold, end = Math.min(length, holdEnd + restore)
  // Without a return, the zoom remains active until the clip ends, including any later rotation.
  const rotation = focusRotation(clip, start, restore > 0 ? end : length)
  const scale = 1 + (Math.min(maxScale, 1 / region.width, 1 / region.height) - 1) * strength
  // Clamp local translation so magnifying an edge target cannot expose additional empty pixels.
  const clamp = (value: number, extent: number) => Math.max(-extent, Math.min(extent, value))
  const dx = clamp((.5 - region.x - region.width / 2) * clip.width * scale, clip.width * (scale - 1) / 2)
  const dy = clamp((.5 - region.y - region.height / 2) * clip.height * scale, clip.height * (scale - 1) / 2)
  const x = clip.x + dx * Math.cos(rotation) - dy * Math.sin(rotation)
  const y = clip.y + dx * Math.sin(rotation) + dy * Math.cos(rotation)
  function frames(from: number, to: number): ClipKeyframe[] {
    const points: ClipKeyframe[] = [{ time: start, value: from, easing }, { time: peak, value: to, easing: hold > 0 ? 'linear' : easing }]
    if (hold > 0) points.push({ time: holdEnd, value: to, easing })
    if (restore > 0) points.push({ time: end, value: from })
    return points
  }
  const generated = validateKeyframes({ x: frames(clip.x, x), y: frames(clip.y, y), scaleX: frames(1, scale), scaleY: frames(1, scale) }, length)
  if (clip.animationOffset) for (const group of Object.values(generated)) for (const frame of group) frame.time += clip.animationOffset
  return { keyframes: { ...clip.keyframes, ...generated }, region, start, end, scale }
}
