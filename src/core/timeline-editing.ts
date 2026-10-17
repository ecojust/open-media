import { cloneProject, validateProject } from './project.ts'
import { clipDuration, clipEnd, deleteClip, findClip, projectDuration, sourceTimeAt } from './timeline.ts'
import type { Project } from './types.ts'

const TIME_EPSILON = 1e-6
const EDIT_EPSILON = 1e-7
interface TimeRange { start: number; end: number }

function finish(project: Project): Project {
  project.updatedAt = new Date().toISOString()
  return validateProject(project, { trusted: true })
}

/** Return to one complete source pass without moving the clip or changing its speed. */
export function restoreAudioClipLength(project: Project, clipId: string): Project {
  const current = findClip(project, clipId)
  if (!current) throw new Error('片段不存在。')
  if (current.track.locked) throw new Error('请先解锁此轨道。')
  const asset = project.assets.find(item => item.id === current.clip.assetId)
  if (current.track.kind !== 'audio' || !asset || asset.kind === 'image') throw new Error('请选择音频轨道中的片段。')
  const copy = cloneProject(project)
  const clip = findClip(copy, clipId)!.clip
  clip.trimIn = 0
  clip.trimOut = asset.duration
  clip.fadeIn = Math.min(clip.fadeIn, clipDuration(clip))
  clip.fadeOut = Math.min(clip.fadeOut, clipDuration(clip))
  if (clip.speech) delete clip.speech.textClipId
  return finish(copy)
}

/** Crop at a timeline position while retaining the source timing of the remaining media. */
export function trimClipAtPlayhead(project: Project, clipId: string, time: number, side: 'start' | 'end'): Project {
  const current = findClip(project, clipId)
  if (!current) throw new Error('片段不存在。')
  if (current.track.locked) throw new Error('请先解锁此轨道。')
  if (side !== 'start' && side !== 'end') throw new Error('裁剪方向无效。')
  if (!Number.isFinite(time) || time <= current.clip.start + EDIT_EPSILON || time >= clipEnd(current.clip) - EDIT_EPSILON) throw new Error('请将播放头移到片段内部再裁剪。')
  const remaining = side === 'start' ? clipEnd(current.clip) - time : time - current.clip.start
  if (remaining < 1 / project.fps - EDIT_EPSILON) throw new Error('裁剪后至少需要保留一帧。')
  const copy = cloneProject(project)
  const edited = findClip(copy, clipId)!
  if (edited.track.kind === 'text') {
    for (const track of copy.tracks) for (const clip of track.clips) {
      if (clip.speech?.textClipId !== clipId) continue
      if (track.locked) throw new Error('关联的配音轨道已锁定，请先解锁。')
      delete clip.speech.textClipId
    }
  }
  if (edited.clip.speech) delete edited.clip.speech.textClipId
  const sourceTime = sourceTimeAt(current.clip, time)
  if (side === 'start') {
    edited.clip.start = time
    edited.clip.trimIn = sourceTime
  } else edited.clip.trimOut = sourceTime
  const duration = clipDuration(edited.clip)
  edited.clip.fadeIn = Math.min(edited.clip.fadeIn, duration)
  edited.clip.fadeOut = Math.min(edited.clip.fadeOut, duration)
  return finish(copy)
}

/** Every track, including muted or locked tracks, contributes occupied time. */
function commonGaps(project: Project, range: TimeRange): TimeRange[] {
  const occupied = project.tracks.flatMap((track) => track.clips.map((clip) => ({ start: clip.start, end: clipEnd(clip) })))
    .filter((interval) => interval.end > range.start && interval.start < range.end)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const gaps: TimeRange[] = []
  let cursor = range.start
  for (const interval of occupied) {
    if (interval.start > cursor + TIME_EPSILON) gaps.push({ start: cursor, end: Math.min(interval.start, range.end) })
    cursor = Math.max(cursor, interval.end)
    if (cursor >= range.end - TIME_EPSILON) break
  }
  if (cursor < range.end - TIME_EPSILON) gaps.push({ start: cursor, end: range.end })
  return gaps
}

function compressGaps(project: Project, gaps: TimeRange[]): Project {
  if (!gaps.length) return project
  const moves = new Map<string, number>()
  for (const track of project.tracks) for (const clip of track.clips) {
    const offset = gaps.reduce((sum, gap) => sum + Math.max(0, Math.min(clip.start, gap.end) - gap.start), 0)
    if (offset <= TIME_EPSILON) continue
    if (track.locked) throw new Error(`轨道“${track.name}”上的片段需要移动，请先解锁此轨道。`)
    moves.set(clip.id, Math.max(0, clip.start - offset))
  }
  if (!moves.size) return project
  const copy = cloneProject(project)
  for (const track of copy.tracks) for (const clip of track.clips) {
    const start = moves.get(clip.id)
    if (start !== undefined) clip.start = start
  }
  return finish(copy)
}

/** Remove only periods in which the entire timeline is empty. */
export function closeTimelineGaps(project: Project): Project {
  return compressGaps(project, commonGaps(project, { start: 0, end: projectDuration(project) }))
}

/** Existing gaps outside the deleted clip's original interval remain untouched. */
export function deleteClipAndCloseGap(project: Project, clipId: string): Project {
  const current = findClip(project, clipId)
  if (!current) throw new Error('片段不存在。')
  const range = { start: current.clip.start, end: clipEnd(current.clip) }
  const deleted = deleteClip(project, clipId)
  return compressGaps(deleted, commonGaps(deleted, range))
}

/** Equal distances retain the first candidate, letting callers choose a stable priority. */
export function findNearestSnap(value: number, candidates: readonly number[], threshold: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(threshold) || threshold < 0) return value
  let snapped = value
  let nearestDistance = Infinity
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate)) continue
    const distance = Math.abs(candidate - value)
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(candidate)) * 8
    if (distance <= threshold + tolerance && distance < nearestDistance - tolerance) {
      snapped = candidate
      nearestDistance = distance
    }
  }
  return snapped
}
