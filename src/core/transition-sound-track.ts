import { cloneProject, createClip, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS, validateProject } from './project.ts'
import { clipEnd, findClip, projectDuration } from './timeline.ts'
import { findTransitionCut, type TransitionCut } from './transitions.ts'
import type { MediaAsset, Project } from './types.ts'

export const TRANSITION_SOUND_TRACK = '转场音效'
const soundCutOptions = { includeLocked: true, minimumDuration: 0.001 }

/** A selected picture transition anchors the sound even when the playhead has moved. */
export function findTransitionSoundCut(project: Project, time: number, selectedClipId?: string): TransitionCut | undefined {
  const selected = selectedClipId ? findClip(project, selectedClipId) : undefined
  const binding = selected?.clip.transition
  if (binding) {
    const from = findClip(project, binding.fromClipId), to = findClip(project, binding.toClipId)
    if (from && to && from.track.id === to.track.id) {
      const cut = findTransitionCut(project, to.clip.start, from.track.id, soundCutOptions)
      if (cut?.fromClipId === from.clip.id && cut.toClipId === to.clip.id) return cut
    }
  }
  return findTransitionCut(project, time, undefined, soundCutOptions)
}

/** Place the sound's accent on the cut, trimming only outside the existing timeline. */
export function addTransitionSound(project: Project, asset: MediaAsset, cut: TransitionCut, anchor: number): { project: Project; clipId: string; trackId: string; start: number } {
  const actualCut = findTransitionCut(project, cut.time, cut.trackId, soundCutOptions)
  if (!actualCut || actualCut.fromClipId !== cut.fromClipId || actualCut.toClipId !== cut.toClipId || Math.abs(actualCut.time - cut.time) > 1e-6) {
    throw new Error('视频切点已变化，请重新选择转场音效。')
  }
  const existing = project.assets.find(item => item.id === asset.id), source = existing ?? asset
  if (source.kind !== 'audio' || !source.url || !Number.isFinite(source.size) || source.size <= 0) throw new Error('转场音效需要可用的音频素材。')
  if (!Number.isFinite(source.duration) || source.duration < 0.001) throw new Error('转场音效时长无效。')
  if (!Number.isFinite(anchor) || anchor < 0 || anchor >= source.duration) throw new Error('转场音效重音位置无效。')
  const desiredStart = cut.time - anchor, start = Math.max(0, desiredStart)
  const trimIn = Math.max(0, -desiredStart)
  const trimOut = Math.min(source.duration, projectDuration(project) - desiredStart)
  const duration = trimOut - trimIn
  if (duration < 0.001 || start + duration > MAX_PROJECT_DURATION) throw new Error('转场音效位置超出时间线范围。')
  if (!existing && project.assets.length >= MAX_ASSETS) throw new Error(`项目最多容纳 ${MAX_ASSETS} 个素材。`)
  if (project.tracks.reduce((total, track) => total + track.clips.length, 0) >= MAX_CLIPS) throw new Error(`项目最多容纳 ${MAX_CLIPS} 个片段。`)
  const target = project.tracks.find(track => track.kind === 'audio' && track.name === TRANSITION_SOUND_TRACK && !track.locked && !track.muted
    && track.clips.every(clip => clipEnd(clip) <= start || clip.start >= start + duration))
  if (!target && project.tracks.length >= MAX_TRACKS) throw new Error(`项目最多容纳 ${MAX_TRACKS} 条轨道，没有可用的转场音效轨道。`)
  const next = cloneProject(project)
  if (!existing) next.assets.push({ ...source })
  const track = target ? next.tracks.find(item => item.id === target.id)! : createTrack('audio', TRANSITION_SOUND_TRACK)
  const clip = createClip(source, project, { start, trimIn, trimOut, volume: 0.7, fadeIn: Math.min(0.005, duration / 2), fadeOut: Math.min(0.02, duration / 2) })
  track.clips.push(clip)
  if (!target) next.tracks.push(track)
  next.updatedAt = new Date().toISOString()
  return { project: validateProject(next, { trusted: true }), clipId: clip.id, trackId: track.id, start }
}
