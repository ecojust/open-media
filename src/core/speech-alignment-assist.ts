import type { Clip, Project, Track } from './types.ts'
import type { SpeechAlignmentSettings } from './speech-timing.ts'
import { validateSpeechAlignment } from './speech-timing.ts'
import { alignSpeechSubtitle } from './speech-alignment.ts'
import { cloneProject, validateProject } from './project.ts'
import { clipDuration, clipEnd, findClip, projectDuration } from './timeline.ts'
import { reconcileTransitions } from './transitions.ts'

const EPSILON = 1e-6
export type SpeechAlignmentIssueKind = 'start' | 'short' | 'duration' | 'overlap' | 'text-changed'
export interface SpeechAlignmentIssue {
  kind: SpeechAlignmentIssueKind
  clipId: string
  speechClipId: string
  time: number
  name: string
  message: string
}
export interface SpeechAlignmentEntry {
  textClipId: string
  speechClipId: string
  textTrackId: string
  speechTrackId: string
  name: string
  textStart: number
  textDuration: number
  speechStart: number
  speechDuration: number
  locked: boolean
  muted: boolean
  textChanged: boolean
}
export interface SpeechAlignmentReport {
  entries: SpeechAlignmentEntry[]
  issues: SpeechAlignmentIssue[]
  unvoicedCount: number
  mutedCount: number
  /** This is existing media timing, never a text-based synthesis estimate. */
  timingSource: 'existing-audio-clips'
}
export interface SpeechAlignmentOptions extends SpeechAlignmentSettings { textTrackId?: string }
export interface SpeechAlignmentChange {
  clipId: string
  name: string
  trackName: string
  beforeStart: number
  afterStart: number
  beforeDuration: number
  afterDuration: number
  removed: boolean
}
export interface SpeechAlignmentPreview {
  project: Project
  changes: SpeechAlignmentChange[]
  changedSubtitleCount: number
  movedSpeechCount: number
  retimedVisualCount: number
  movedMarkerCount: number
  beforeDuration: number
  afterDuration: number
  remainingIssues: SpeechAlignmentIssue[]
}

function subtitleTracks(project: Project, trackId?: string): Track[] {
  if (trackId && !project.tracks.some(track => track.id === trackId && track.kind === 'text')) throw new Error('所选字幕轨道已不存在，请重新选择。')
  return project.tracks.filter(track => track.kind === 'text' && (!trackId || track.id === trackId))
}

export function inspectSpeechAlignment(project: Project, textTrackId?: string): SpeechAlignmentReport {
  const entries: SpeechAlignmentEntry[] = [], issues: SpeechAlignmentIssue[] = []
  const linked = new Map(project.tracks.filter(track => track.kind === 'audio').flatMap(track => track.clips.flatMap(clip => clip.speech?.textClipId ? [[clip.speech.textClipId, { track, clip }] as const] : [])))
  let unvoicedCount = 0
  for (const track of subtitleTracks(project, textTrackId)) for (const clip of track.clips) {
    if (clip.textRole === 'watermark') continue
    const voice = linked.get(clip.id)
    if (!voice) { if (!track.muted) unvoicedCount++; continue }
    const entry: SpeechAlignmentEntry = {
      textClipId: clip.id, speechClipId: voice.clip.id, textTrackId: track.id, speechTrackId: voice.track.id,
      name: clip.text?.trim() || clip.name, textStart: clip.start, textDuration: clipDuration(clip),
      speechStart: voice.clip.start, speechDuration: clipDuration(voice.clip),
      locked: track.locked || voice.track.locked, muted: track.muted || voice.track.muted,
      textChanged: (clip.text?.trim() ?? '') !== voice.clip.speech!.text.trim(),
    }
    entries.push(entry)
    if (entry.muted) continue
    const add = (kind: SpeechAlignmentIssueKind, message: string) => issues.push({ kind, clipId: clip.id, speechClipId: voice.clip.id, time: voice.clip.start, name: entry.name, message })
    if (entry.textChanged) add('text-changed', '文字已修改，与现有配音内容不同；请先重新生成配音。')
    const tolerance = Math.max(EPSILON, 0.5 / project.fps)
    if (Math.abs(entry.textStart - entry.speechStart) > tolerance) add('start', `字幕与配音起点相差 ${Math.abs(entry.textStart - entry.speechStart).toFixed(2)} 秒。`)
    if (entry.textDuration < entry.speechDuration - tolerance) add('short', `字幕比现有配音短 ${(entry.speechDuration - entry.textDuration).toFixed(2)} 秒。`)
    else if (entry.textDuration > entry.speechDuration + tolerance) add('duration', `字幕比现有配音长 ${(entry.textDuration - entry.speechDuration).toFixed(2)} 秒。`)
  }
  const audible = entries.filter(entry => !entry.muted).sort((a, b) => a.speechStart - b.speechStart)
  let covering: SpeechAlignmentEntry | undefined
  for (const entry of audible) {
    if (covering && entry.speechStart < covering.speechStart + covering.speechDuration - EPSILON) {
      const end = Math.min(covering.speechStart + covering.speechDuration, entry.speechStart + entry.speechDuration)
      issues.push({ kind: 'overlap', clipId: entry.textClipId, speechClipId: entry.speechClipId, time: entry.speechStart, name: entry.name, message: `与“${covering.name.slice(0, 24)}”的配音重叠 ${(end - entry.speechStart).toFixed(2)} 秒。` })
    }
    if (!covering || entry.speechStart + entry.speechDuration > covering.speechStart + covering.speechDuration) covering = entry
  }
  return { entries, issues, unvoicedCount, mutedCount: entries.filter(entry => entry.muted).length, timingSource: 'existing-audio-clips' }
}

function requireEditable(track: Track): void {
  if (track.locked) throw new Error(`“${track.name}”已锁定，此方案需要修改该轨道。请先解锁或选择其他范围。`)
}

function alignText(track: Track, text: Clip, audio: Clip): void {
  const duration = clipDuration(audio)
  if (Math.abs(text.start - audio.start) < EPSILON && Math.abs(clipDuration(text) - duration) < EPSILON) return
  requireEditable(track)
  alignSpeechSubtitle(text, audio.start, duration)
}

function extendShot(project: Project, text: Clip, boundary: number, delta: number, speech: Clip): void {
  if (delta < EPSILON) return
  if (Math.abs(text.start - speech.start) > EPSILON) throw new Error('字幕与配音的起点不同，无法确定要延长的镜头；请选择字幕跟随配音或顺延字幕与配音。')
  const candidates = project.tracks.filter(track => track.kind === 'video' && !track.muted)
    .flatMap(track => track.clips.map(clip => ({ track, clip })))
    .filter(({ clip }) => Math.abs(clip.start - text.start) < EPSILON && Math.abs(clipEnd(clip) - boundary) < EPSILON)
  if (candidates.length !== 1) throw new Error('延长画面需要一个与当前字幕起止一致的独立镜头。请先在字幕边界分割视频，或选择顺延字幕与配音。')
  const visual = candidates[0]!
  requireEditable(visual.track)
  if (visual.clip.speedRamp || visual.clip.keyframes && Object.values(visual.clip.keyframes).some(points => points?.length)) throw new Error('对应镜头含变速曲线或关键帧，无法安全延长。请选择顺延字幕与配音。')
  for (const track of project.tracks) for (const clip of track.clips) {
    if ([text.id, speech.id, visual.clip.id].includes(clip.id) || clip.transition || track.muted) continue
    if (clip.start >= boundary - EPSILON || clipEnd(clip) <= text.start + EPSILON) continue
    const asset = project.assets.find(item => item.id === clip.assetId)
    if (track.kind === 'audio' && !clip.speech && asset?.libraryRole === 'background-music') continue
    throw new Error(`“${clip.name}”与待延长镜头重叠或跨越镜头边界，延长可能破坏同步。请先处理该片段或选择顺延字幕与配音。`)
  }
  const asset = project.assets.find(item => item.id === visual.clip.assetId)
  if (!asset) throw new Error('对应镜头缺少源素材。')
  const duration = clipDuration(visual.clip) + delta
  if (asset.kind === 'image' || visual.clip.freezeFrame) visual.clip.trimOut = visual.clip.trimIn + duration * visual.clip.speed
  else {
    const speed = (visual.clip.trimOut - visual.clip.trimIn) / duration
    if (speed < 0.1) throw new Error('延长镜头需要低于 0.1 倍的速度，请拆分旁白或选择顺延字幕与配音。')
    visual.clip.speed = speed
  }
  for (const track of project.tracks) for (const clip of track.clips) {
    if (clip.id === speech.id || clip.id === text.id || clip.id === visual.clip.id || clip.transition || clip.start < boundary - EPSILON) continue
    requireEditable(track)
    clip.start += delta
  }
  for (const marker of project.markers ?? []) if (marker.time >= boundary - EPSILON) marker.time += delta
}

/** Prepare a complete, non-destructive edit; the caller commits it as one history operation. */
export function previewSpeechAlignment(project: Project, options: SpeechAlignmentOptions): SpeechAlignmentPreview {
  const policy = validateSpeechAlignment(options)
  const report = inspectSpeechAlignment(project, options.textTrackId)
  const entries = report.entries.filter(entry => !entry.muted).sort((a, b) => a.speechStart - b.speechStart || a.textStart - b.textStart)
  if (!entries.length) throw new Error('所选范围没有启用的关联配音，请先为字幕生成配音。')
  const stale = entries.find(entry => entry.textChanged)
  if (stale) throw new Error(`“${stale.name.slice(0, 36)}”的文字已修改，请先重新生成配音再对齐。`)
  const copy = cloneProject(project)
  const voiceByText = new Map(entries.map(entry => [entry.textClipId, entry.speechClipId]))
  const mutedTextIds = new Set(report.entries.filter(entry => entry.muted).map(entry => entry.textClipId))
  const clipIndex = new Map(copy.tracks.flatMap(track => track.clips.map(clip => [clip.id, { track, clip }] as const)))
  const eligibleTextIds = new Set(subtitleTracks(project, options.textTrackId).filter(track => !track.muted)
    .flatMap(track => track.clips.filter(clip => clip.textRole !== 'watermark' && !mutedTextIds.has(clip.id)).map(clip => clip.id)))
  const processed = new Set<string>()
  for (const entry of entries) {
    const text = clipIndex.get(entry.textClipId)!, audio = clipIndex.get(entry.speechClipId)!
    const oldEnd = clipEnd(text.clip)
    if (policy.mode !== 'subtitle') {
      const following = [...eligibleTextIds].filter(id => id !== text.clip.id && !processed.has(id)).map(id => {
        const caption = clipIndex.get(id)!, voiceId = voiceByText.get(id), voice = voiceId ? clipIndex.get(voiceId) : undefined
        return { caption, voice, anchor: voice?.clip.start ?? caption.clip.start }
      }).filter(item => item.anchor >= audio.clip.start - EPSILON).sort((a, b) => a.anchor - b.anchor)[0]
      const pause = following ? Math.max(policy.gap, following.anchor - oldEnd, 0) : 0
      const shift = following ? Math.max(0, clipEnd(audio.clip) + pause - following.anchor) : 0
      if (policy.mode === 'extend_visual') {
        const extra = Math.max(shift, clipEnd(audio.clip) - oldEnd, 0)
        if (following && following.anchor < oldEnd - EPSILON && extra > EPSILON) throw new Error('后一句配音已在当前镜头内开始，无法直接延长镜头；请先顺延字幕与配音，或手动调整镜头边界。')
        extendShot(copy, text.clip, oldEnd, extra, audio.clip)
      } else if (following && shift > EPSILON) {
        for (const id of eligibleTextIds) {
          if (id === text.clip.id || processed.has(id)) continue
          const caption = clipIndex.get(id)!, voiceId = voiceByText.get(id), voice = voiceId ? clipIndex.get(voiceId) : undefined
          if ((voice?.clip.start ?? caption.clip.start) < following.anchor - EPSILON) continue
          requireEditable(caption.track)
          caption.clip.start += shift
          if (voice) { requireEditable(voice.track); voice.clip.start += shift }
        }
      }
    }
    alignText(text.track, text.clip, audio.clip)
    processed.add(text.clip.id)
  }
  reconcileTransitions(copy, project)
  const changes: SpeechAlignmentChange[] = []
  let changedSubtitleCount = 0, movedSpeechCount = 0, retimedVisualCount = 0
  for (const track of project.tracks) for (const before of track.clips) {
    const after = findClip(copy, before.id)?.clip
    if (after && JSON.stringify(before) === JSON.stringify(after)) continue
    changes.push({ clipId: before.id, name: before.name, trackName: track.name, beforeStart: before.start, afterStart: after?.start ?? before.start, beforeDuration: clipDuration(before), afterDuration: after ? clipDuration(after) : 0, removed: !after })
    if (track.kind === 'text') changedSubtitleCount++
    if (before.speech && after && Math.abs(before.start - after.start) > EPSILON) movedSpeechCount++
    if (track.kind === 'video' && after && Math.abs(clipDuration(before) - clipDuration(after)) > EPSILON) retimedVisualCount++
  }
  const movedMarkerCount = (project.markers ?? []).filter(marker => copy.markers?.find(after => after.id === marker.id)?.time !== marker.time).length
  if (changes.length || movedMarkerCount) copy.updatedAt = new Date().toISOString()
  const next = changes.length || movedMarkerCount ? validateProject(copy, { trusted: true }) : project
  return { project: next, changes, changedSubtitleCount, movedSpeechCount, retimedVisualCount, movedMarkerCount, beforeDuration: projectDuration(project), afterDuration: projectDuration(next), remainingIssues: inspectSpeechAlignment(next, options.textTrackId).issues }
}
