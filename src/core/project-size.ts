import type { MediaAsset, Project } from './types.ts'
import { cloneProject, validateProject } from './project.ts'

/** A new canvas follows its first imported video once, then retains that size. */
export function adoptFirstVideoSize(project: Project, imported: readonly MediaAsset[]): Project {
  // Older documents and explicit user sizes must never be changed by an import.
  if (project.autoSizeFromVideo !== true) return project
  const source = imported.find(asset => asset.kind === 'video'
    && Number.isInteger(asset.width) && Number.isInteger(asset.height)
    && asset.width >= 16 && asset.height >= 16 && asset.width <= 16384 && asset.height <= 16384)
  if (!source) return project
  const next = cloneProject(project)
  const sx = source.width / project.width, sy = source.height / project.height
  next.width = source.width; next.height = source.height; next.autoSizeFromVideo = false
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
