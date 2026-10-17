import { cloneProject, createClip, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS, validateProject } from './project.ts'
import { clipEnd } from './timeline.ts'
import type { MediaAsset, Project } from './types.ts'

/** Insert the complete recording, asset and background track as one reversible edit. */
export function addBackgroundMusic(project: Project, asset: MediaAsset, start: number): { project: Project; clipId: string; trackId: string } {
  const existingAsset = project.assets.find(item => item.id === asset.id)
  const source = existingAsset ?? asset
  if (source.kind !== 'audio' || !source.url || !Number.isFinite(source.size) || source.size <= 0) {
    throw new Error('背景音乐需要可用的音频素材。')
  }
  const duration = source.duration
  if (!Number.isFinite(duration) || duration < 0.001) throw new Error('背景音乐素材时长无效。')
  if (!Number.isFinite(start) || start < 0 || start + duration > MAX_PROJECT_DURATION) {
    throw new Error('背景音乐起点无效或时间线超过 24 小时。')
  }
  if (!existingAsset && project.assets.length >= MAX_ASSETS) {
    throw new Error(`项目最多容纳 ${MAX_ASSETS} 个素材，请移除不用的素材后再添加背景音乐。`)
  }
  if (project.tracks.reduce((count, track) => count + track.clips.length, 0) >= MAX_CLIPS) {
    throw new Error(`项目最多容纳 ${MAX_CLIPS} 个片段，请移除不用的片段后再添加背景音乐。`)
  }
  const end = start + duration
  const existingTrack = project.tracks.find(track => track.kind === 'audio' && track.name === '背景音乐轨道' && !track.locked && !track.muted
    && track.clips.every(clip => clipEnd(clip) <= start || clip.start >= end))
  if (!existingTrack && project.tracks.length >= MAX_TRACKS) {
    throw new Error(`项目最多容纳 ${MAX_TRACKS} 条轨道，没有可用的背景音乐轨道。请移除不用的轨道后再添加背景音乐。`)
  }

  const clip = createClip(source, project, {
    start, volume: 0.3, fadeIn: Math.min(0.5, duration / 2), fadeOut: Math.min(1, duration / 2),
  })
  const next = cloneProject(project)
  if (!existingAsset) next.assets.push({ ...source })
  const track = existingTrack ? next.tracks.find(item => item.id === existingTrack.id)! : createTrack('audio', '背景音乐轨道')
  track.clips.push(clip)
  if (!existingTrack) next.tracks.push(track)
  next.updatedAt = new Date().toISOString()
  return { project: validateProject(next, { trusted: true }), clipId: clip.id, trackId: track.id }
}
