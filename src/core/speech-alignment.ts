import type { Clip, Project } from './types.ts'
import type { SpeechAlignmentSettings } from './speech-timing.ts'
import type { SpeechResult } from './speech.ts'
import { clipDuration, clipEnd, findClip } from './timeline.ts'
import { cloneProject, validateProject } from './project.ts'
import { reconcileTransitions } from './transitions.ts'

/** Subtitle length follows the actual audio timeline, including trims and playback speed. */
export function alignSpeechSubtitle(clip: Clip, start: number, duration: number): void {
  clip.start = start
  clip.trimIn = 0
  clip.trimOut = duration
  clip.speed = 1
  clip.fadeIn = Math.min(clip.fadeIn, duration)
  clip.fadeOut = Math.min(clip.fadeOut, duration)
}

/** Apply explicit narration timing policies without silently changing source media. */
export function applySpeechAlignment(project: Project, results: SpeechResult[], policy: SpeechAlignmentSettings): Project {
  if (policy.mode === 'subtitle' && policy.gap === 0) return project
  const copy = cloneProject(project)
  let previousEnd = -Infinity
  for (const result of [...results].sort((a, b) => a.source.start - b.source.start)) {
    const text = findClip(copy, result.source.clipId)
    const speech = copy.tracks.flatMap(track => track.clips.map(clip => ({ track, clip }))).find(item => item.clip.speech?.textClipId === result.source.clipId)
    if (!text || !speech) throw new Error('配音对齐的关联字幕或音频已不存在。')
    if (text.track.locked || speech.track.locked) throw new Error('配音对齐涉及已锁定的字幕或配音轨道，请先解锁。')
    if (policy.mode === 'subtitle') {
      const start = Math.max(text.clip.start, previousEnd + policy.gap)
      text.clip.start = speech.clip.start = start
      previousEnd = clipEnd(speech.clip)
      continue
    }
    const boundary = text.clip.start + result.source.duration
    const following = copy.tracks.filter(track => track.kind === 'text' || track.kind === 'audio')
      .flatMap(track => track.clips).filter(clip => clip.id !== text.clip.id && clip.id !== speech.clip.id && (clip.speech || clip.text !== undefined && clip.textRole !== 'watermark') && clip.start >= boundary - 1e-6)
      .sort((a, b) => a.start - b.start)[0]
    const existingPause = following ? Math.max(0, following.start - boundary) : policy.gap
    const addedPause = Math.max(0, policy.gap - existingPause)
    const delta = Math.max(0, clipDuration(speech.clip) + addedPause - result.source.duration)
    if (delta < 1e-6) continue
    let extended: string | undefined
    if (policy.mode === 'extend_visual') {
      const visual = copy.tracks.filter(track => track.kind === 'video' && !track.muted).flatMap(track => track.clips.map(clip => ({ track, clip }))).find(item => item.clip.start <= text.clip.start + 1e-6 && clipEnd(item.clip) >= boundary - 1e-6)
      if (!visual) throw new Error('字幕时段没有完整覆盖的画面，无法延长；请使用字幕对齐或顺延后文。')
      if (visual.clip.speedRamp) throw new Error('覆盖画面包含变速曲线，请先移除曲线或选择字幕对齐。')
      if (visual.track.locked) throw new Error(`“${visual.track.name}”已锁定，无法延长画面。`)
      const asset = copy.assets.find(item => item.id === visual.clip.assetId)
      const duration = clipDuration(visual.clip) + delta
      if (asset?.kind === 'image' || visual.clip.freezeFrame) visual.clip.trimOut = visual.clip.trimIn + duration * visual.clip.speed
      else {
        const speed = (visual.clip.trimOut - visual.clip.trimIn) / duration
        if (speed < 0.1) throw new Error('延长画面所需速度低于 0.1 倍，请拆分配音或选择其他对齐方式。')
        visual.clip.speed = speed
      }
      extended = visual.clip.id
    }
    for (const track of copy.tracks) for (const clip of track.clips) {
      if (clip.id === text.clip.id || clip.id === speech.clip.id || clip.id === extended || clip.transition || clip.start < boundary - 1e-6) continue
      if (policy.mode === 'ripple' && track.kind !== 'text' && !clip.speech) continue
      if (track.locked) throw new Error(`“${track.name}”已锁定，无法顺延片段。`)
      clip.start += delta
    }
  }
  reconcileTransitions(copy, project)
  copy.updatedAt = new Date().toISOString()
  return validateProject(copy, { trusted: true })
}
