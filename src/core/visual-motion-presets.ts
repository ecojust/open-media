import type { Clip, ClipKeyframes } from './types.ts'
import { validateKeyframes, visualClipDuration } from './visual-animation.ts'

export type VisualMotionPreset = 'none' | 'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right' | 'push-in' | 'pull-back'

export const VISUAL_MOTION_PRESETS: ReadonlyArray<{ id: VisualMotionPreset; label: string }> = [
  { id: 'none', label: '无动画' }, { id: 'fade', label: '淡入淡出' },
  { id: 'slide-up', label: '向上滑入' }, { id: 'slide-down', label: '向下滑入' },
  { id: 'slide-left', label: '向左滑入' }, { id: 'slide-right', label: '向右滑入' },
  { id: 'push-in', label: '轻推近' }, { id: 'pull-back', label: '轻缩回' },
]

/** Presets reserve a stable reading interval, including for very short clips. */
export function applyVisualMotionPreset(clip: Clip, preset: VisualMotionPreset): Clip {
  if (!VISUAL_MOTION_PRESETS.some(item => item.id === preset)) throw new Error('入退场动画无效。')
  const duration = visualClipDuration(clip)
  if (!Number.isFinite(duration) || duration < 0.001) throw new Error('动画片段时长无效。')
  const offset = clip.animationOffset ?? 0
  if (!Number.isFinite(offset) || offset < 0) throw new Error('动画起点无效。')
  const keyframes: ClipKeyframes = {}
  for (const property of ['volume', 'rotation'] as const) {
    if (clip.keyframes?.[property]) keyframes[property] = clip.keyframes[property]!.map(frame => ({ ...frame }))
  }
  const next: Clip = { ...clip, fadeIn: 0, fadeOut: 0 }
  if (preset !== 'none') {
    const enter = Math.min(0.45, duration * 0.25)
    const exitStart = duration - Math.min(0.3, duration * 0.2)
    const sequence = (first: number, rest: number, last: number) => [
      { time: offset, value: first, easing: 'ease-out' as const },
      { time: offset + enter, value: rest, easing: 'linear' as const },
      { time: offset + exitStart, value: rest, easing: 'ease-in' as const },
      { time: offset + duration, value: last },
    ]
    keyframes.opacity = sequence(0, clip.opacity, 0)
    keyframes.opacity[2]!.easing = 'ease-out'
    if (preset.startsWith('slide-')) {
      const horizontal = preset === 'slide-left' || preset === 'slide-right'
      const property = horizontal ? 'x' : 'y'
      const distance = horizontal ? Math.min(96, Math.max(8, clip.width * 0.12)) : Math.min(64, Math.max(8, clip.height * 0.3))
      const sign = preset === 'slide-left' || preset === 'slide-up' ? 1 : -1
      keyframes[property] = sequence(clip[property] + sign * distance, clip[property], clip[property] - sign * distance)
    } else if (preset === 'push-in' || preset === 'pull-back') {
      const first = preset === 'push-in' ? 0.94 : 1.06
      const last = preset === 'push-in' ? 1.04 : 0.96
      keyframes.scaleX = sequence(first, 1, last)
      keyframes.scaleY = sequence(first, 1, last)
    }
  }
  if (Object.keys(keyframes).length) next.keyframes = validateKeyframes(keyframes, Math.max(duration + offset, ...Object.values(keyframes).flat().map(frame => frame.time)))
  else delete next.keyframes
  return next
}
