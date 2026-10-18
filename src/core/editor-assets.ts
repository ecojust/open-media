import { cloneProject, createClip, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS, validateProject } from './project.ts'
import { adoptFirstVideoSize } from './project-size.ts'
import type { MediaAsset, Project, Track } from './types.ts'
import { videoAssetKey } from './video-assets.ts'

/** Only explicit bundled-material roles are hidden; older user assets stay visible. */
export function projectSourceAssets(project: Project): MediaAsset[] {
  return project.assets.filter(asset => asset.libraryRole === undefined)
}

export interface EditorAssetInsertion { trackId?: string; start?: number }
export interface EditorAssetEdit { project: Project; assetId: string; clipId: string; trackId: string; addedAsset: boolean }

function defaultTrack(track: Track, asset: MediaAsset): boolean {
  const kind = asset.kind === 'audio' ? 'audio' : 'video'
  return track.kind === kind && !track.locked && !['水印轨道', '背景音乐轨道', '视频片段轨道'].includes(track.name)
}

/** Register one selected source and insert its clip as one undoable project edit. */
export function addEditorAssetToTimeline(project: Project, asset: MediaAsset, options: EditorAssetInsertion = {}): EditorAssetEdit {
  const start = options.start === undefined ? 0 : options.start
  if (!Number.isFinite(start) || start < 0 || start > MAX_PROJECT_DURATION) throw new Error('片段开始时间超出允许范围。')
  const byPath = asset.nativePath ? project.assets.find(item => item.nativePath && videoAssetKey(item) === videoAssetKey(asset)) : undefined
  const byId = project.assets.find(item => item.id === asset.id)
  if (!byPath && byId?.nativePath && asset.nativePath && videoAssetKey(byId) !== videoAssetKey(asset)) {
    throw new Error('素材标识与现有文件冲突，请刷新素材列表后重试。')
  }
  const existing = byPath ?? byId
  const source = existing ?? asset
  const duration = source.kind === 'image' ? Math.max(5, source.duration) : source.duration
  if (!Number.isFinite(duration) || duration < 0.001 || start + duration > MAX_PROJECT_DURATION) throw new Error('素材时长无效或时间线超过 24 小时。')
  const target = options.trackId !== undefined ? project.tracks.find(track => track.id === options.trackId) : project.tracks.find(track => defaultTrack(track, source))
  if (options.trackId !== undefined && !target) throw new Error('目标轨道不存在，请重新选择。')
  if (target?.locked) throw new Error('请先解锁此轨道。')
  if (target && (target.kind === 'text' || target.kind === 'transition'
    || target.kind === 'video' && source.kind === 'audio' || target.kind === 'audio' && source.kind === 'image')) {
    throw new Error('目标轨道不支持此素材类型。')
  }
  if (!existing && project.assets.length >= MAX_ASSETS) throw new Error(`项目最多容纳 ${MAX_ASSETS} 个素材。`)
  if (project.tracks.reduce((count, track) => count + track.clips.length, 0) >= MAX_CLIPS) throw new Error(`项目最多容纳 ${MAX_CLIPS} 个片段。`)
  if (!target && project.tracks.length >= MAX_TRACKS) throw new Error(`项目最多容纳 ${MAX_TRACKS} 条轨道。`)

  let next = cloneProject(project)
  if (!existing) next.assets.push({ ...source })
  next = adoptFirstVideoSize(next, [source])
  const track = target ? next.tracks.find(item => item.id === target.id)! : createTrack(source.kind === 'audio' ? 'audio' : 'video')
  const clip = createClip(source, next, { start })
  track.clips.push(clip)
  if (!target) next.tracks.push(track)
  next.updatedAt = new Date().toISOString()
  return { project: validateProject(next, { trusted: true }), assetId: source.id, clipId: clip.id, trackId: track.id, addedAsset: !existing }
}
