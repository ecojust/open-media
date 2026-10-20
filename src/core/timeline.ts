import { animatedSourceTimeAt, visualClipDuration } from './visual-animation.ts'
import { cloneProject, createTrack, newId, validateProject } from './project.ts'
import { isSubtitleClip, SUBTITLE_STYLE_KEYS, subtitleStyleFromClip } from './subtitle-style.ts'
import { reconcileTransitions } from './transitions.ts'
import { videoWorkingCopyResolver } from './video-working-copies.ts'
import type { Clip, MediaAsset, Project, ProjectHistory, Track, TrackKind } from './types.ts'

export function clipDuration(clip: Clip): number { return visualClipDuration(clip) }
export function clipEnd(clip: Clip): number { return clip.start + clipDuration(clip) }
export function projectDuration(project: Project): number { return Math.max(0, ...project.tracks.flatMap((track) => track.clips.map(clipEnd))) }
export function isClipActive(clip: Clip, time: number): boolean { return time >= clip.start && time < clipEnd(clip) }
export function sourceTimeAt(clip: Clip, time: number): number { return animatedSourceTimeAt(clip, time) }
export function clipOpacityAt(clip: Clip, time: number): number {
  if (!isClipActive(clip, time)) return 0
  const elapsed = time - clip.start
  const remaining = clipEnd(clip) - time
  return clip.opacity * Math.min(1, clip.fadeIn > 0 ? elapsed / clip.fadeIn : 1, clip.fadeOut > 0 ? remaining / clip.fadeOut : 1)
}

export function activeClips(project: Project, time: number): { track: Track; clip: Clip; asset?: MediaAsset; sourceTime: number }[] {
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]))
  return project.tracks.flatMap((track) => track.clips.filter((clip) => isClipActive(clip, time)).map((clip) => ({ track, clip, asset: clip.assetId ? assets.get(clip.assetId) : undefined, sourceTime: sourceTimeAt(clip, time) })))
}

function edit(project: Project, action: (copy: Project) => void): Project {
  const copy = cloneProject(project)
  action(copy)
  reconcileTransitions(copy, project)
  copy.updatedAt = new Date().toISOString()
  return validateProject(copy, { trusted: true })
}

function trackById(project: Project, id: string): Track {
  const track = project.tracks.find((item) => item.id === id)
  if (!track) throw new Error('轨道不存在。')
  return track
}

function editable(track: Track): void { if (track.locked) throw new Error('请先解锁此轨道。') }

/** Detached speech keeps its voice and original words for later inspection. */
function detachSpeechSources(project: Project, textClipIds: Set<string>): void {
  for (const track of project.tracks) for (const clip of track.clips) {
    if (clip.speech?.textClipId && textClipIds.has(clip.speech.textClipId)) { editable(track); delete clip.speech.textClipId }
  }
}

export function findClip(project: Project, id: string): { track: Track; clip: Clip; index: number } | undefined {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((clip) => clip.id === id)
    if (index >= 0) return { track, clip: track.clips[index]!, index }
  }
  return undefined
}

function requireClip(project: Project, id: string): { track: Track; clip: Clip; index: number } {
  const result = findClip(project, id)
  if (!result) throw new Error('片段不存在。')
  editable(result.track)
  return result
}

export function addAsset(project: Project, asset: MediaAsset): Project { return edit(project, (copy) => { copy.assets.push({ ...asset }) }) }
export function addAssets(project: Project, assets: MediaAsset[]): Project { return edit(project, (copy) => { copy.assets.push(...assets.map((asset) => ({ ...asset }))) }) }
export function removeAsset(project: Project, assetId: string): Project {
  if (project.tracks.some((track) => track.clips.some((clip) => clip.assetId === assetId))) throw new Error('素材正在时间线中使用，请先移除相关片段。')
  return edit(project, (copy) => { copy.assets = copy.assets.filter((asset) => asset.id !== assetId) })
}
export function addTrack(project: Project, kindOrTrack: TrackKind | Track, name?: string): Project {
  return edit(project, (copy) => { copy.tracks.push(typeof kindOrTrack === 'string' ? createTrack(kindOrTrack, name) : JSON.parse(JSON.stringify(kindOrTrack)) as Track) })
}
export function setTrack(project: Project, trackId: string, patch: Partial<Pick<Track, 'name' | 'muted' | 'locked'>>): Project {
  return edit(project, (copy) => { Object.assign(trackById(copy, trackId), patch) })
}
export function removeTrack(project: Project, trackId: string): Project {
  return edit(project, (copy) => { const track = trackById(copy, trackId); editable(track); if (track.kind === 'text') detachSpeechSources(copy, new Set(track.clips.map((clip) => clip.id))); copy.tracks = copy.tracks.filter((track) => track.id !== trackId) })
}
export function reorderTrack(project: Project, trackId: string, index: number): Project {
  return edit(project, (copy) => { const track = trackById(copy, trackId); editable(track); copy.tracks = copy.tracks.filter((item) => item.id !== trackId); copy.tracks.splice(Math.max(0, Math.min(copy.tracks.length, Math.round(index))), 0, track) })
}
export function addClip(project: Project, trackId: string, clip: Clip): Project {
  return addClips(project, trackId, [clip])
}
export function addClips(project: Project, trackId: string, clips: Clip[]): Project {
  return edit(project, (copy) => {
    const track = trackById(copy, trackId); editable(track)
    const assets = new Map(copy.assets.map(asset => [asset.id, asset])), resolve = videoWorkingCopyResolver(copy)
    track.clips.push(...clips.map(clip => {
      const asset = clip.assetId ? assets.get(clip.assetId) : undefined
      return { ...clip, ...(asset ? { assetId: resolve(asset).id } : {}) }
    }))
  })
}
export interface ClipUpdateOptions { translatePositionKeyframes?: boolean }
export function updateClip(project: Project, clipId: string, patch: Partial<Omit<Clip, 'id' | 'assetId'>>, options: ClipUpdateOptions = {}): Project {
  return edit(project, (copy) => {
    const { clip, track } = requireClip(copy, clipId)
    if (track.kind === 'transition') throw new Error('请通过转场属性调整效果和时长，转场会固定在视频切点。')
    // Position curves contain absolute project coordinates. Move the entire
    // curve by the base-position delta only when explicitly requested.
    if (options.translatePositionKeyframes) {
      if (patch.keyframes !== undefined) throw new Error('同步位置关键帧与替换关键帧不能同时进行。')
      for (const axis of ['x', 'y'] as const) {
        const position = patch[axis], frames = clip.keyframes?.[axis]
        if (position === undefined || !frames?.length) continue
        const delta = position - clip[axis]
        clip.keyframes![axis] = frames.map(frame => ({ ...frame, value: frame.value + delta }))
      }
    }
    const textChanged = track.kind === 'text' && patch.text !== undefined && patch.text !== clip.text
    const subtitleStyleChanged = isSubtitleClip(track, clip) && SUBTITLE_STYLE_KEYS.some(key => patch[key] !== undefined && patch[key] !== clip[key])
    const oldId = clip.id
    const oldAsset = clip.assetId
    Object.assign(clip, patch)
    clip.id = oldId
    clip.assetId = oldAsset
    if (textChanged) clip.generatedAt = new Date().toISOString()
    const duration = clipDuration(clip)
    clip.fadeIn = Math.min(clip.fadeIn, duration)
    clip.fadeOut = Math.min(clip.fadeOut, duration)
    if (subtitleStyleChanged) copy.subtitleStyle = subtitleStyleFromClip(clip)
  })
}
export function applySubtitleStyleToTrack(project: Project, sourceClipId: string): Project {
  const { track, clip: source } = requireClip(project, sourceClipId)
  if (!isSubtitleClip(track, source)) throw new Error('请选择字幕片段。')
  const style = subtitleStyleFromClip(source)
  const changes = new Map(track.clips
    .filter(clip => clip.id !== sourceClipId && isSubtitleClip(track, clip))
    .map(clip => {
      const duration = clipDuration(clip)
      return { clip, style: { ...style, fadeIn: Math.min(style.fadeIn, duration), fadeOut: Math.min(style.fadeOut, duration) } }
    })
    .filter(item => SUBTITLE_STYLE_KEYS.some(key => item.clip[key] !== item.style[key]))
    .map(item => [item.clip.id, item.style]))
  if (!changes.size) return project
  return edit(project, copy => {
    for (const clip of trackById(copy, track.id).clips) {
      const targetStyle = changes.get(clip.id)
      if (targetStyle) Object.assign(clip, targetStyle)
    }
    copy.subtitleStyle = { ...style }
  })
}
export function moveClip(project: Project, clipId: string, targetTrackId: string, start: number): Project {
  return edit(project, (copy) => { const { track, clip, index } = requireClip(copy, clipId); const target = trackById(copy, targetTrackId); editable(target); if (track.kind === 'transition' || target.kind === 'transition') throw new Error('转场只能固定在相邻视频的切点，不能自由移动。'); if ((track.kind === 'text') !== (target.kind === 'text')) throw new Error('字幕和媒体片段不能相互移动到对方轨道。'); track.clips.splice(index, 1); clip.start = start; if (target.kind === 'audio') { delete clip.filters; delete clip.chromaKey }; target.clips.push(clip) })
}
/** Split a detached project without publishing intermediate timeline states. */
function splitClipInPlace(copy: Project, clipId: string, time: number): Clip {
  const { track, clip, index } = requireClip(copy, clipId)
  if (track.kind === 'transition') throw new Error('转场不能分割，请调整转场时长。')
  if (!Number.isFinite(time) || time <= clip.start + 1e-6 || time >= clipEnd(clip) - 1e-6) throw new Error('请将播放头移到片段内部再分割。')
  const source = clip.freezeFrame ? clip.trimIn + (time - clip.start) * clip.speed : sourceTimeAt(clip, time)
  if (clip.speedRamp && !clip.speedRamp.sourceRange) clip.speedRamp.sourceRange = { start: clip.trimIn, end: clip.trimOut }
  if (track.kind === 'text') detachSpeechSources(copy, new Set([clip.id]))
  if (clip.speech) delete clip.speech.textClipId
  const right = { ...clip, ...(clip.speech ? { speech: { ...clip.speech } } : {}), id: newId('clip'), start: time, trimIn: source, fadeIn: 0 }
  if (clip.keyframes) right.animationOffset = (clip.animationOffset ?? 0) + time - clip.start
  clip.trimOut = source
  clip.fadeOut = 0
  clip.fadeIn = Math.min(clip.fadeIn, clipDuration(clip))
  right.fadeOut = Math.min(right.fadeOut, clipDuration(right))
  track.clips.splice(index + 1, 0, right)
  for (const effectTrack of copy.tracks) for (const transition of effectTrack.clips) {
    if (transition.transition?.fromClipId === clip.id) transition.transition.fromClipId = right.id
  }
  return right
}
export function splitClip(project: Project, clipId: string, time: number): Project {
  return edit(project, copy => { splitClipInPlace(copy, clipId, time) })
}
/** One clone and one validation even when a detector finds many boundaries. */
export function splitClipAtTimes(project: Project, clipId: string, times: readonly number[]): Project {
  const sorted = [...new Set(times)].sort((left, right) => right - left)
  if (!sorted.length) return project
  return edit(project, copy => { for (const time of sorted) splitClipInPlace(copy, clipId, time) })
}
export function duplicateClip(project: Project, clipId: string, start?: number): Project {
  return edit(project, (copy) => { const { track, clip } = requireClip(copy, clipId); if (track.kind === 'transition') throw new Error('转场不能直接复制，请在其他视频切点添加。'); const duplicate = { ...clip, ...(clip.speech ? { speech: { ...clip.speech } } : {}), id: newId('clip'), start: start ?? clipEnd(clip) }; if (duplicate.speech) delete duplicate.speech.textClipId; track.clips.push(duplicate) })
}
export function deleteClip(project: Project, clipId: string): Project {
  return edit(project, (copy) => { const { track, index } = requireClip(copy, clipId); if (track.kind === 'text') detachSpeechSources(copy, new Set([clipId])); track.clips.splice(index, 1) })
}
export function trimClip(project: Project, clipId: string, trimIn: number, trimOut: number): Project { return updateClip(project, clipId, { trimIn, trimOut }) }
export function setClipSpeed(project: Project, clipId: string, speed: number): Project { return updateClip(project, clipId, { speed }) }

export function createHistory(project: Project, limit = 80): ProjectHistory { return { past: [], present: cloneProject(project), future: [], limit: Math.max(1, Math.min(500, Math.round(limit))) } }
function historyKey(project: Project): string { return JSON.stringify({ ...project, updatedAt: '' }) }
export function commitHistory(history: ProjectHistory, project: Project): ProjectHistory {
  if (historyKey(history.present) === historyKey(project)) return history
  return { ...history, past: [...history.past, cloneProject(history.present)].slice(-history.limit), present: cloneProject(project), future: [] }
}
export function undoHistory(history: ProjectHistory): ProjectHistory {
  if (!history.past.length) return history
  return { ...history, past: history.past.slice(0, -1), present: cloneProject(history.past[history.past.length - 1]!), future: [cloneProject(history.present), ...history.future] }
}
export function redoHistory(history: ProjectHistory): ProjectHistory {
  if (!history.future.length) return history
  return { ...history, past: [...history.past, cloneProject(history.present)].slice(-history.limit), present: cloneProject(history.future[0]!), future: history.future.slice(1) }
}
