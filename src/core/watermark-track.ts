import { createChromaKey } from './chroma-key.ts'
import { cloneProject, createClip, createTextClip, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS, validateProject } from './project.ts'
import { clipEnd } from './timeline.ts'
import type { MediaAsset, Project } from './types.ts'
import type { WatermarkMaterial } from './watermark-library.ts'

export type WatermarkPlacement = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'bottom-center'
export interface WatermarkOptions { placement?: WatermarkPlacement; chromaKey?: boolean; spillSuppression?: boolean }

/** Text templates remain editable text clips, without importing their card thumbnails. */
export function addTextWatermark(project: Project, material: WatermarkMaterial, start: number): { project: Project; clipId: string; trackId: string } {
  const template = material.textTemplate
  if (material.kind !== 'text' || !template) throw new Error('需要可编辑的文字水印模板。')
  if (![material.width, material.height, template.width, template.height, template.fontSize].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('文字水印模板尺寸无效。')
  }
  const duration = material.duration
  if (!Number.isFinite(duration) || duration < 0.001) throw new Error('水印素材时长无效。')
  if (!Number.isFinite(start) || start < 0 || start + duration > MAX_PROJECT_DURATION) throw new Error('水印起点无效或时间线超过 24 小时。')
  const placement = material.placement ?? 'center'
  if (!['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'bottom-center'].includes(placement)) throw new Error('水印位置无效。')
  if (project.tracks.reduce((count, track) => count + track.clips.length, 0) >= MAX_CLIPS) {
    throw new Error(`项目最多容纳 ${MAX_CLIPS} 个片段，请移除不用的片段后再添加水印。`)
  }
  const end = start + duration
  const existing = project.tracks.find(track => track.kind === 'text' && track.name === '文字水印轨道' && !track.locked && !track.muted
    && track.clips.every(clip => clipEnd(clip) <= start || clip.start >= end))
  if (!existing && project.tracks.length >= MAX_TRACKS) throw new Error(`项目最多容纳 ${MAX_TRACKS} 条轨道，没有可用的文字水印轨道。请移除不用的轨道后再添加水印。`)
  const marginX = project.width * 0.04, marginY = project.height * 0.04
  const scale = Math.min(project.width / material.width, project.height / material.height,
    (project.width - marginX * 2) / template.width, (project.height - marginY * 2) / template.height)
  const width = Math.max(1, template.width * scale), height = Math.max(1, template.height * scale)
  const x = placement.endsWith('left') ? marginX : placement.endsWith('right') ? project.width - marginX - width : (project.width - width) / 2
  const y = placement.startsWith('top') ? marginY : placement.startsWith('bottom') ? project.height - marginY - height : (project.height - height) / 2
  const clip = createTextClip(project, {
    name: material.name, start, trimOut: duration, width, height, x, y,
    text: template.text, color: template.color, background: template.background,
    fontFamily: template.fontFamily, fontWeight: template.fontWeight, textAlign: template.textAlign,
    fontSize: Math.max(4, Math.min(2048, template.fontSize * scale)),
  })
  const next = cloneProject(project)
  const track = existing ? next.tracks.find(item => item.id === existing.id)! : createTrack('text', '文字水印轨道')
  track.clips.push(clip)
  next.tracks = [track, ...next.tracks.filter(item => item.id !== track.id)]
  next.updatedAt = new Date().toISOString()
  return { project: validateProject(next, { trusted: true }), clipId: clip.id, trackId: track.id }
}

/** Add the asset, foreground track and overlay together as one reversible edit. */
export function addWatermark(project: Project, asset: MediaAsset, start: number, options: WatermarkOptions = {}): { project: Project; clipId: string; trackId: string } {
  const existingAsset = project.assets.find((item) => item.id === asset.id)
  const source = existingAsset ?? asset
  if (!['video', 'image'].includes(source.kind) || !source.url || !Number.isFinite(source.size) || source.size <= 0
    || !Number.isFinite(source.width) || source.width < 1 || !Number.isFinite(source.height) || source.height < 1) {
    throw new Error('水印需要可用的视频或图片素材。')
  }
  const duration = source.kind === 'image' ? 5 : source.duration
  if (!Number.isFinite(duration) || duration < 0.001) throw new Error('水印素材时长无效。')
  if (!Number.isFinite(start) || start < 0 || start + duration > MAX_PROJECT_DURATION) {
    throw new Error('水印起点无效或时间线超过 24 小时。')
  }
  const placement = options.placement ?? 'top-right'
  if (!['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'bottom-center'].includes(placement)) throw new Error('水印位置无效。')
  if (options.chromaKey !== undefined && typeof options.chromaKey !== 'boolean') throw new Error('水印抠像开关无效。')
  if (options.spillSuppression !== undefined && typeof options.spillSuppression !== 'boolean') throw new Error('水印溢色抑制开关无效。')
  if (!existingAsset && project.assets.length >= MAX_ASSETS) throw new Error(`项目最多容纳 ${MAX_ASSETS} 个素材，请移除不用的素材后再添加水印。`)
  if (project.tracks.reduce((count, track) => count + track.clips.length, 0) >= MAX_CLIPS) {
    throw new Error(`项目最多容纳 ${MAX_CLIPS} 个片段，请移除不用的片段后再添加水印。`)
  }
  const end = start + duration
  const existing = project.tracks.find((track) => track.kind === 'video' && track.name === '水印轨道' && !track.locked && !track.muted
    && track.clips.every((clip) => clipEnd(clip) <= start || clip.start >= end))
  if (!existing && project.tracks.length >= MAX_TRACKS) {
    throw new Error(`项目最多容纳 ${MAX_TRACKS} 条轨道，没有可用的水印轨道。请移除不用的轨道后再添加水印。`)
  }

  const marginX = project.width * 0.04, marginY = project.height * 0.04
  const scale = Math.min(project.width * 0.38 / source.width, (project.height - 2 * marginY) / source.height)
  const width = Math.max(1, source.width * scale), height = Math.max(1, source.height * scale)
  const x = placement.endsWith('left') ? marginX : placement.endsWith('right') ? project.width - marginX - width : (project.width - width) / 2
  const y = placement.startsWith('top') ? marginY : placement.startsWith('bottom') ? project.height - marginY - height : (project.height - height) / 2
  const clip = createClip(source, project, { start, trimOut: duration, volume: 0, width, height, x, y, ...(options.chromaKey ? { chromaKey: createChromaKey({ spillSuppression: options.spillSuppression }) } : {}) })
  const next = cloneProject(project)
  if (!existingAsset) next.assets.push({ ...source })
  const track = existing ? next.tracks.find((item) => item.id === existing.id)! : createTrack('video', '水印轨道')
  track.clips.push(clip)
  next.tracks = [track, ...next.tracks.filter((item) => item.id !== track.id)]
  next.updatedAt = new Date().toISOString()
  return { project: validateProject(next, { trusted: true }), clipId: clip.id, trackId: track.id }
}
