import { clipOpacityAt } from './timeline.ts'
import type { Clip, Project, Track } from './types.ts'

type ClipGeometry = Pick<Clip, 'x' | 'y' | 'width' | 'height' | 'rotation'>
export interface ClipBounds { left: number; top: number; right: number; bottom: number; centerX: number; centerY: number }
export interface PreviewPosition { x: number; y: number }
export interface PreviewGeometry extends PreviewPosition { width?: number; height?: number }
export type PreviewCorner = 'nw' | 'ne' | 'sw' | 'se'
export interface PreviewGuides { x: number | null; y: number | null }

/** The renderer rotates around the clip rectangle's center, including subtitle boxes. */
export function clipBounds(clip: ClipGeometry): ClipBounds {
  const angle = clip.rotation * Math.PI / 180
  const halfWidth = (Math.abs(Math.cos(angle)) * clip.width + Math.abs(Math.sin(angle)) * clip.height) / 2
  const halfHeight = (Math.abs(Math.sin(angle)) * clip.width + Math.abs(Math.cos(angle)) * clip.height) / 2
  const centerX = clip.x + clip.width / 2, centerY = clip.y + clip.height / 2
  return { left: centerX - halfWidth, top: centerY - halfHeight, right: centerX + halfWidth, bottom: centerY + halfHeight, centerX, centerY }
}

/** Locked visuals remain alignment references, while only editable ones can be moved. */
export function visibleVisualClips(project: Project, time: number): { track: Track; clip: Clip }[] {
  const assets = new Map(project.assets.map(asset => [asset.id, asset]))
  return project.tracks.filter(track => !track.hidden && track.kind !== 'audio' && track.kind !== 'transition').flatMap(track => track.clips.filter(clip => {
    if (clipOpacityAt(clip, time) <= 0) return false
    if (track.kind === 'text' || clip.text !== undefined) {
      if (!clip.text?.trim() && (clip.textRole !== 'watermark' || !clip.background || clip.background === 'transparent')) return false
    } else {
      const asset = clip.assetId && assets.get(clip.assetId)
      if (!asset || asset.kind === 'audio') return false
    }
    const bounds = clipBounds(clip)
    return bounds.right > 0 && bounds.bottom > 0 && bounds.left < project.width && bounds.top < project.height
  }).map(clip => ({ track, clip })))
}

function nearestOffset(anchors: number[], targets: number[], threshold: number): { offset: number; guide: number | null } {
  let best = { offset: 0, guide: null as number | null }, distance = threshold + 1e-7
  for (const target of targets) for (const anchor of anchors) {
    const next = target - anchor
    if (Math.abs(next) < distance) { distance = Math.abs(next); best = { offset: next, guide: target } }
  }
  return best
}

/** Threshold is in project pixels so callers can keep the snap distance constant on screen. */
export function snapClipPosition(clip: ClipGeometry, position: PreviewPosition, project: Pick<Project, 'width' | 'height'>, others: readonly ClipGeometry[], threshold: number, enabled = true): PreviewPosition & { guides: PreviewGuides } {
  const x = Math.max(-65536, Math.min(65536, position.x)), y = Math.max(-65536, Math.min(65536, position.y))
  if (!enabled || threshold < 0 || !Number.isFinite(threshold)) return { x, y, guides: { x: null, y: null } }
  const bounds = clipBounds({ ...clip, x, y })
  const references = others.map(clipBounds)
  const xs = [project.width / 2, 0, project.width, ...references.flatMap(item => [item.centerX, item.left, item.right])].filter(value => value >= 0 && value <= project.width)
  const ys = [project.height / 2, 0, project.height, ...references.flatMap(item => [item.centerY, item.top, item.bottom])].filter(value => value >= 0 && value <= project.height)
  const horizontal = nearestOffset([bounds.centerX, bounds.left, bounds.right], xs, threshold)
  const vertical = nearestOffset([bounds.centerY, bounds.top, bounds.bottom], ys, threshold)
  if (Math.abs(x + horizontal.offset) > 65536) { horizontal.offset = 0; horizontal.guide = null }
  if (Math.abs(y + vertical.offset) > 65536) { vertical.offset = 0; vertical.guide = null }
  return { x: x + horizontal.offset, y: y + vertical.offset, guides: { x: horizontal.guide, y: vertical.guide } }
}

/** Resize around the opposite corner in the clip's local axes; source aspect is optional. */
export function resizeClipFromCorner(clip: ClipGeometry, delta: PreviewPosition, corner: PreviewCorner, project: Pick<Project, 'width' | 'height'>, others: readonly ClipGeometry[], threshold: number, snap = true, keepAspect = true): Required<PreviewGeometry> & { guides: PreviewGuides } {
  const sx = corner.endsWith('e') ? 1 : -1, sy = corner.startsWith('s') ? 1 : -1
  const angle = clip.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle)
  const anchorX = clip.x + clip.width / 2 - cos * sx * clip.width / 2 + sin * sy * clip.height / 2
  const anchorY = clip.y + clip.height / 2 - sin * sx * clip.width / 2 - cos * sy * clip.height / 2
  let width = clip.width + sx * (delta.x * cos + delta.y * sin)
  let height = clip.height + sy * (-delta.x * sin + delta.y * cos)
  const minScale = Math.max(1 / clip.width, 1 / clip.height), maxScale = Math.min(65536 / clip.width, 65536 / clip.height)
  if (keepAspect) {
    const scale = Math.max(minScale, Math.min(maxScale, (width * clip.width + height * clip.height) / (clip.width ** 2 + clip.height ** 2)))
    width = clip.width * scale; height = clip.height * scale
  } else { width = Math.max(1, Math.min(65536, width)); height = Math.max(1, Math.min(65536, height)) }
  const guides: PreviewGuides = { x: null, y: null }
  if (snap && threshold >= 0 && Number.isFinite(threshold) && Math.abs(sin) < 1e-8 && cos > 0) {
    const references = others.map(clipBounds)
    const xs = [project.width / 2, 0, project.width, ...references.flatMap(item => [item.centerX, item.left, item.right])].filter(value => value >= 0 && value <= project.width)
    const ys = [project.height / 2, 0, project.height, ...references.flatMap(item => [item.centerY, item.top, item.bottom])].filter(value => value >= 0 && value <= project.height)
    const x = nearestOffset([anchorX + sx * width], xs, threshold), y = nearestOffset([anchorY + sy * height], ys, threshold)
    if (keepAspect) {
      const useX = x.guide !== null && (y.guide === null || Math.abs(x.offset) <= Math.abs(y.offset))
      const scale = useX ? (width + sx * x.offset) / clip.width : y.guide !== null ? (height + sy * y.offset) / clip.height : undefined
      if (scale !== undefined && scale >= minScale && scale <= maxScale) {
        width = clip.width * scale; height = clip.height * scale
        if (useX) guides.x = x.guide; else guides.y = y.guide
      }
    } else {
      if (x.guide !== null && width + sx * x.offset >= 1 && width + sx * x.offset <= 65536) { width += sx * x.offset; guides.x = x.guide }
      if (y.guide !== null && height + sy * y.offset >= 1 && height + sy * y.offset <= 65536) { height += sy * y.offset; guides.y = y.guide }
    }
  }
  return { x: Math.max(-65536, Math.min(65536, anchorX + cos * sx * width / 2 - sin * sy * height / 2 - width / 2)), y: Math.max(-65536, Math.min(65536, anchorY + sin * sx * width / 2 + cos * sy * height / 2 - height / 2)), width, height, guides }
}
