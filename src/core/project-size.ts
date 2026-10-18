import type { MediaAsset, Project } from './types.ts'
import { cloneProject, validateProject } from './project.ts'

export const MIN_PROJECT_SIZE = 16
export const MAX_PROJECT_SIZE = 16384

export function projectSizeError(width: number, height: number): string | undefined {
  if (![width, height].every(value => Number.isFinite(value) && Number.isInteger(value)
    && value >= MIN_PROJECT_SIZE && value <= MAX_PROJECT_SIZE)) {
    return `项目宽度和高度必须为 ${MIN_PROJECT_SIZE} 到 ${MAX_PROJECT_SIZE} 之间的整数。`
  }
  return undefined
}

/** Resize the canvas and its visual geometry while retaining source media and timing. */
export function resizeProject(project: Project, width: number, height: number): Project {
  const error = projectSizeError(width, height)
  if (error) throw new Error(error)
  if (project.width === width && project.height === height && project.autoSizeFromVideo === false) return project
  const next = cloneProject(project)
  const sx = width / project.width, sy = height / project.height
  next.width = width; next.height = height; next.autoSizeFromVideo = false
  next.updatedAt = new Date().toISOString()
  if (sx !== 1 || sy !== 1) {
    const visuals = next.tracks.filter(track => track.kind !== 'audio').flatMap(track => track.clips)
    const geometry = [...visuals, ...(next.subtitleStyle ? [next.subtitleStyle] : [])]
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
    for (const clip of geometry) {
      clip.x = clamp(clip.x * sx, -65536, 65536); clip.y = clamp(clip.y * sy, -65536, 65536)
      clip.width = clamp(clip.width * sx, 1, 65536); clip.height = clamp(clip.height * sy, 1, 65536)
      if (clip.fontSize !== undefined) clip.fontSize = clamp(clip.fontSize * Math.min(sx, sy), 4, 2048)
    }
  }
  return validateProject(next, { trusted: true })
}

/** Imported asset dimensions already reflect display rotation; clip transforms do not. */
export function videoClipSourceSize(project: Project, clipId: string): { width: number; height: number } | undefined {
  const track = project.tracks.find(track => track.kind === 'video' && track.clips.some(clip => clip.id === clipId))
  const clip = track?.clips.find(clip => clip.id === clipId)
  const asset = clip && project.assets.find(asset => asset.id === clip.assetId && asset.kind === 'video')
  return asset ? { width: asset.width, height: asset.height } : undefined
}

export function resizeProjectToVideoClip(project: Project, clipId: string): Project {
  const source = videoClipSourceSize(project, clipId)
  if (!source) throw new Error('请选择具有源视频素材的视频片段。')
  const track = project.tracks.find(track => track.clips.some(clip => clip.id === clipId))!
  if (track.locked) throw new Error('请先解锁该视频轨道，再匹配项目尺寸。')
  return resizeProject(project, source.width, source.height)
}

/** A new canvas follows its first imported video once, then retains that size. */
export function adoptFirstVideoSize(project: Project, imported: readonly MediaAsset[]): Project {
  // Older documents and explicit user sizes must never be changed by an import.
  if (project.autoSizeFromVideo !== true) return project
  const source = imported.find(asset => asset.kind === 'video' && !projectSizeError(asset.width, asset.height))
  return source ? resizeProject(project, source.width, source.height) : project
}
