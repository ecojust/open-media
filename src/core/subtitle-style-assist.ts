import { cloneProject, validateProject } from './project.ts'
import { isSubtitleClip, SUBTITLE_STYLE_KEYS, subtitleStyleFromClip } from './subtitle-style.ts'
import { trackSubtitleIssues } from './subtitle-validation.ts'
import { clipDuration } from './timeline.ts'
import type { Clip, Project, SubtitleStyle } from './types.ts'

export interface StyleSubtitle {
  clipId: string
  trackId: string
  trackName: string
  text: string
  start: number
  locked: boolean
  animated: boolean
}

export interface SubtitleStyleUnificationOptions {
  sourceClipId: string
  targetTrackIds: string[]
  rememberAsDefault?: boolean
}

export interface SubtitleStyleUnificationPlan {
  source: StyleSubtitle
  style: SubtitleStyle
  changes: { clipId: string; trackId: string; style: SubtitleStyle }[]
  locked: StyleSubtitle[]
  animated: StyleSubtitle[]
  unchanged: StyleSubtitle[]
  defaultChanged: boolean
}

const visualAnimationKeys = ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity'] as const

function hasVisualAnimation(clip: Clip): boolean {
  return visualAnimationKeys.some(key => (clip.keyframes?.[key]?.length ?? 0) > 0)
}

export function listStyleSubtitles(project: Project): StyleSubtitle[] {
  return project.tracks.flatMap(track => track.clips
    .filter(clip => isSubtitleClip(track, clip))
    .map(clip => ({ clipId: clip.id, trackId: track.id, trackName: track.name,
      text: clip.text ?? '', start: clip.start, locked: track.locked, animated: hasVisualAnimation(clip) })))
    .sort((a, b) => a.start - b.start)
}

function sameStyle(a: SubtitleStyle | undefined, b: SubtitleStyle): boolean {
  return !!a && SUBTITLE_STYLE_KEYS.every(key => a[key] === b[key])
}

export function planSubtitleStyleUnification(project: Project, options: SubtitleStyleUnificationOptions): SubtitleStyleUnificationPlan {
  const subtitles = listStyleSubtitles(project)
  const source = subtitles.find(item => item.clipId === options.sourceClipId)
  if (!source) throw new Error('请选择一条现有字幕作为样式参考。')
  const sourceClip = project.tracks.find(track => track.id === source.trackId)!.clips.find(clip => clip.id === source.clipId)!
  const style = subtitleStyleFromClip(sourceClip)
  const targetIds = new Set(options.targetTrackIds)
  for (const id of targetIds) {
    const track = project.tracks.find(item => item.id === id)
    if (!track || track.kind !== 'text') throw new Error('所选字幕轨道已不存在，请重新选择。')
  }
  const plan: SubtitleStyleUnificationPlan = {
    source, style, changes: [], locked: [], animated: [], unchanged: [],
    defaultChanged: !!options.rememberAsDefault && !sameStyle(project.subtitleStyle, style),
  }
  const candidates = new Map(subtitles.map(item => [item.clipId, item]))
  for (const track of project.tracks) {
    if (!targetIds.has(track.id)) continue
    for (const clip of track.clips) {
      const candidate = candidates.get(clip.id)
      if (!candidate || clip.id === source.clipId) continue
      if (track.locked) { plan.locked.push(candidate); continue }
      // Base positions, bounds and opacity may conflict with manually animated values.
      // Keep such clips intact instead of flattening or translating their curves.
      if (candidate.animated) { plan.animated.push(candidate); continue }
      const duration = clipDuration(clip)
      const targetStyle = { ...style, fadeIn: Math.min(style.fadeIn, duration), fadeOut: Math.min(style.fadeOut, duration) }
      if (sameStyle(subtitleStyleFromClip(clip), targetStyle)) { plan.unchanged.push(candidate); continue }
      plan.changes.push({ clipId: clip.id, trackId: track.id, style: targetStyle })
    }
  }
  return plan
}

/** One immutable project edit, so the caller can commit one undoable history entry. */
export function applySubtitleStyleUnification(project: Project, options: SubtitleStyleUnificationOptions): Project {
  // Always plan against the latest project; a track may have been locked since preview.
  const plan = planSubtitleStyleUnification(project, options)
  if (!plan.changes.length && !plan.defaultChanged) return project
  const next = cloneProject(project)
  const styles = new Map(plan.changes.map(change => [change.clipId, change.style]))
  for (const track of next.tracks) for (const clip of track.clips) {
    const style = styles.get(clip.id)
    if (style) Object.assign(clip, style)
  }
  if (plan.defaultChanged) next.subtitleStyle = { ...plan.style }
  next.updatedAt = new Date().toISOString()
  return validateProject(next, { trusted: true })
}

export function subtitleStyleIssues(project: Project) {
  return project.tracks.flatMap(track => trackSubtitleIssues(track).map(issue => {
    const clip = track.clips.find(item => item.id === issue.clipId)!
    return { ...issue, trackId: track.id, trackName: track.name, start: clip.start, text: clip.text ?? '' }
  })).sort((a, b) => a.start - b.start)
}
