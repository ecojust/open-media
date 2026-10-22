import { cloneProject, createClip, createTextClip, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS, validateProject } from './project.ts'
import { clipEnd, projectDuration } from './timeline.ts'
import type { MediaAsset, Project } from './types.ts'
import type { VideoSegmentCaption, VideoSegmentPlacement } from './video-segment-presets.ts'
import { videoSegmentTextLayout } from './video-segment-layout.ts'

export type { VideoSegmentCaption, VideoSegmentPlacement } from './video-segment-presets.ts'

/** Insert an opening/ending and its editable titles as one reversible operation. */
export function insertVideoSegment(project: Project, asset: MediaAsset, placement: VideoSegmentPlacement, caption?: VideoSegmentCaption): { project: Project; clipId: string; trackId: string; start: number; duration: number } {
  if (placement !== 'prepend' && placement !== 'append') throw new Error('请选择向前或向后添加视频片段。')
  const existingAsset = project.assets.find(item => item.id === asset.id)
  const source = existingAsset ?? asset
  if (source.kind !== 'video' || !source.url || !Number.isFinite(source.size) || source.size <= 0) throw new Error('视频片段需要可用的视频素材。')
  if (!Number.isFinite(source.duration) || source.duration < 0.001) throw new Error('视频片段时长无效。')
  const duration = caption?.duration ?? source.duration
  if (caption?.duration !== undefined && (typeof caption.duration !== 'number' || !Number.isFinite(duration) || duration < 0.5 || duration > 30)) throw new Error('模板时长需为 0.5 至 30 秒。')
  const speed = source.duration / duration
  if (speed < 0.1 || speed > 16) throw new Error('这个时长超出素材支持的变速范围，请调整模板时长。')
  const end = projectDuration(project)
  if (end + duration > MAX_PROJECT_DURATION) throw new Error('添加后时间线将超过 24 小时，请先缩短项目。')
  if (placement === 'prepend') {
    const locked = project.tracks.find(track => track.locked && track.clips.length > 0)
    if (locked) throw new Error(`向前添加需要整体后移现有片段，请先解锁“${locked.name}”。`)
  }
  if (!existingAsset && project.assets.length >= MAX_ASSETS) throw new Error(`项目最多容纳 ${MAX_ASSETS} 个素材。`)
  if (caption && (typeof caption.heading !== 'string' || typeof caption.subheading !== 'string' || caption.heading.length > 120 || caption.subheading.length > 240 || /\0/.test(caption.heading + caption.subheading))) throw new Error('片头片尾标题过长或格式无效。')
  const heading = caption?.heading.trim() ?? '', subheading = caption?.subheading.trim() ?? ''
  const textLayout = videoSegmentTextLayout(project.width, project.height, caption?.layout, Boolean(subheading))
  const textCount = Number(Boolean(heading)) + Number(Boolean(subheading))
  if (project.tracks.reduce((count, track) => count + track.clips.length, 0) + 1 + textCount > MAX_CLIPS) throw new Error(`项目最多容纳 ${MAX_CLIPS} 个片段。`)
  // Keep an opening/ending beside the main footage so a transition can span its cut.
  const assets = new Map(project.assets.map(item => [item.id, item]))
  const boundaryTrack = project.tracks.find(track => track.kind === 'video' && !track.locked && !track.muted
    && track.clips.some(clip => assets.get(clip.assetId ?? '')?.kind === 'video'
      && Math.abs(placement === 'prepend' ? clip.start : clipEnd(clip) - end) < 1e-6))
  const videoTrack = boundaryTrack ?? project.tracks.find(track => track.kind === 'video' && track.name === '视频片段轨道' && !track.locked && !track.muted)
  const videoLayer = videoTrack ? project.tracks.indexOf(videoTrack) : -1
  const textTrack = textCount ? project.tracks.find((track, index) => index > videoLayer && track.kind === 'text' && track.name === '片头片尾文字' && !track.locked && !track.muted) : undefined
  const newTracks = Number(!videoTrack) + Number(textCount > 0 && !textTrack)
  if (project.tracks.length + newTracks > MAX_TRACKS) throw new Error(`项目最多容纳 ${MAX_TRACKS} 条轨道，请移除不用的轨道后再添加。`)

  const next = cloneProject(project)
  if (placement === 'prepend') for (const track of next.tracks) for (const clip of track.clips) clip.start += duration
  if (!existingAsset) next.assets.push({ ...source })
  const start = placement === 'prepend' ? 0 : end
  const target = videoTrack ? next.tracks.find(track => track.id === videoTrack.id)! : createTrack('video', '视频片段轨道')
  const clip = createClip(source, next, { start, speed, fit: caption ? 'cover' : 'contain' })
  target.clips.push(clip)
  if (!videoTrack) next.tracks.unshift(target)
  if (textCount) {
    const titles = textTrack ? next.tracks.find(track => track.id === textTrack.id)! : createTrack('text', '片头片尾文字')
    for (const [isHeading, value] of [[true, heading], [false, subheading]] as const) {
      if (!value) continue
      titles.clips.push(createTextClip(next, {
        name: isHeading ? '片头片尾标题' : '片头片尾副标题', text: value, textRole: 'watermark', start, trimOut: duration,
        ...(isHeading ? textLayout.heading : textLayout.subheading), fontWeight: isHeading ? 600 : 400,
        color: caption!.textColor, background: 'transparent', textVerticalAlign: 'middle',
        fadeIn: Math.min(isHeading ? 0.65 : 0.95, duration / 3), fadeOut: Math.min(0.45, duration / 3),
      }))
    }
    if (!textTrack) next.tracks.push(titles)
  }
  next.updatedAt = new Date().toISOString()
  return { project: validateProject(next, { trusted: true }), clipId: clip.id, trackId: target.id, start, duration }
}
