import { createClip, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS } from './project.ts'
import { addAssets, addClip, addTrack, clipEnd } from './timeline.ts'
import type { MediaAsset, Project } from './types.ts'

/** Return one edit so the recording, asset and any new track share an undo step. */
export function addRecordedAudio(project: Project, asset: MediaAsset, start: number): { project: Project; clipId: string; trackId: string } {
  if (asset.kind !== 'audio' || !Number.isFinite(asset.duration) || asset.duration < 0.001 || asset.size <= 0 || !asset.url) {
    throw new Error('录音结果不是可用的音频素材。')
  }
  if (!Number.isFinite(start) || start < 0 || start + asset.duration > MAX_PROJECT_DURATION) {
    throw new Error('录音起点无效或时间线超过 24 小时。')
  }
  if (project.assets.length >= MAX_ASSETS) throw new Error(`项目最多容纳 ${MAX_ASSETS} 个素材，请移除不用的素材后再添加录音。`)
  if (project.tracks.reduce((count, track) => count + track.clips.length, 0) >= MAX_CLIPS) {
    throw new Error(`项目最多容纳 ${MAX_CLIPS} 个片段，请移除不用的片段后再添加录音。`)
  }
  const end = start + asset.duration
  const existing = project.tracks.find((track) => track.kind === 'audio' && track.name === '配音轨道' && !track.locked && !track.muted
    && track.clips.every((clip) => clipEnd(clip) <= start || clip.start >= end))
  if (!existing && project.tracks.length >= MAX_TRACKS) {
    throw new Error(`项目最多容纳 ${MAX_TRACKS} 条轨道，没有可用的配音轨道。请移除不用的轨道后再添加录音。`)
  }
  const track = existing ?? createTrack('audio', '配音轨道')
  const clip = createClip(asset, project, { start })
  let next = addAssets(project, [asset])
  if (!existing) next = addTrack(next, track)
  return { project: addClip(next, track.id, clip), clipId: clip.id, trackId: track.id }
}
