import { cloneProject, createClip, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS, validateProject } from './project.ts'
import { adoptFirstVideoSize } from './project-size.ts'
import type { MediaAsset, Project, Track } from './types.ts'
import { videoAssetKey } from './video-assets.ts'
import { projectWorkingAssets, workingVideoAsset } from './video-working-copies.ts'
import { clipEnd } from './timeline.ts'

/** Only explicit bundled-material roles are hidden; older user assets stay visible. */
export function projectSourceAssets(project: Project): MediaAsset[] {
  return projectWorkingAssets(project).filter(asset => asset.libraryRole === undefined)
}

export interface EditorAssetInsertion { trackId?: string; start?: number }
export interface EditorAssetEdit { project: Project; assetId: string; clipId: string; trackId: string; addedAsset: boolean }

function defaultTrack(track: Track, asset: MediaAsset): boolean {
  const kind = asset.kind === 'audio' ? 'audio' : 'video'
  return track.kind === kind && !track.locked && !['图片轨道', '水印轨道', '背景音乐轨道', '视频片段轨道', '转场音效'].includes(track.name)
}

/** Image overlays start centered and proportional, leaving room to position them like subtitles. */
export function imageClipBounds(asset: Pick<MediaAsset, 'width' | 'height'>, project: Pick<Project, 'width' | 'height'>): { x: number; y: number; width: number; height: number } {
  if (![asset.width, asset.height].every(value => Number.isFinite(value) && value >= 1)) throw new Error('图片尺寸无效。')
  const scale = Math.min(1, project.width * 0.5 / asset.width, project.height * 0.5 / asset.height)
  const width = Math.max(1, asset.width * scale), height = Math.max(1, asset.height * scale)
  return { x: (project.width - width) / 2, y: (project.height - height) / 2, width, height }
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
  const source = workingVideoAsset(project, existing ?? asset)
  const duration = source.kind === 'image' ? Math.max(5, source.duration) : source.duration
  if (!Number.isFinite(duration) || duration < 0.001 || start + duration > MAX_PROJECT_DURATION) throw new Error('素材时长无效或时间线超过 24 小时。')
  const target = options.trackId !== undefined ? project.tracks.find(track => track.id === options.trackId)
    : source.kind === 'image'
      ? project.tracks.find(track => track.kind === 'video' && track.name === '图片轨道' && !track.locked && !track.hidden && track.clips.every(clip => clipEnd(clip) <= start || clip.start >= start + duration))
      : project.tracks.find(track => defaultTrack(track, source))
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
  const track = target ? next.tracks.find(item => item.id === target.id)! : createTrack(source.kind === 'audio' ? 'audio' : 'video', source.kind === 'image' ? '图片轨道' : undefined)
  const clip = createClip(source, next, { start, ...(source.kind === 'image' ? { ...imageClipBounds(source, next), volume: 0 } : {}) })
  track.clips.push(clip)
  if (!target) {
    if (source.kind === 'video') next.tracks.unshift(track)
    else next.tracks.push(track)
  }
  next.updatedAt = new Date().toISOString()
  return { project: validateProject(next, { trusted: true }), assetId: source.id, clipId: clip.id, trackId: track.id, addedAsset: !existing }
}
