import { cloneProject } from './project.ts'
import type { MediaAsset, Project } from './types.ts'
import { drawTextClip } from './preview.ts'
import { importBlobAsset } from '../native.ts'
import { clipEnd } from './timeline.ts'
import { mediaToolError } from './media-tool-error.ts'

export interface NativeProjectOptions {
  skipText?: boolean
  visualOnly?: boolean
  range?: { start: number; end?: number }
  rasterScale?: number
  onProgress?: (update: { stage: string; progress?: number }) => void
}
export async function prepareNativeProject(source: Project, signal?: AbortSignal, options: NativeProjectOptions = {}): Promise<{ project: Project; textAssets: Record<string, MediaAsset> }> {
  signal?.throwIfAborted()
  const range = options.range
  if (range && (!Number.isFinite(range.start) || range.start < 0 || range.end !== undefined && (!Number.isFinite(range.end) || range.end <= range.start))) throw new Error('素材准备范围无效。')
  const rasterScale = options.rasterScale ?? 1
  if (!Number.isFinite(rasterScale) || rasterScale <= 0 || rasterScale > 1) throw new Error('字幕准备比例无效。')
  const project = cloneProject(source)
  const selected = project.tracks.flatMap(track => track.kind === 'transition' || options.skipText && track.kind === 'text' || options.visualOnly && track.kind === 'audio' ? [] : track.clips).filter(clip => !range || (range.end === undefined ? clip.start <= range.start : clip.start < range.end) && clipEnd(clip) > range.start)
  const clipIds = new Set(selected.map(clip => clip.id)), assetIds = new Set(selected.map(clip => clip.assetId))
  const assets = project.assets.filter(asset => !range || assetIds.has(asset.id))
  let completed = 0
  const total = assets.filter(asset => !asset.nativePath).length + (options.skipText ? 0 : project.tracks.filter(track => track.kind === 'text').reduce((sum, track) => sum + track.clips.filter(clip => clipIds.has(clip.id) && clip.overlay?.kind !== 'blur').length, 0))
  for (const asset of assets) {
    signal?.throwIfAborted()
    if (asset.nativePath) continue
    options.onProgress?.({ stage: `正在准备素材：${asset.name}`, progress: completed / Math.max(1, total) })
    let stage = '素材读取'
    try {
      const response = await fetch(asset.sourceUrl || asset.url, { signal })
      if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      signal?.throwIfAborted()
      stage = '素材导入'
      const imported = await importBlobAsset(bytes, asset.name)
      signal?.throwIfAborted()
      Object.assign(asset, imported, { id: asset.id })
    } catch (cause) { throw mediaToolError(stage, cause, { resource: { assetId: asset.id, name: asset.name } }) }
    completed++
  }
  const textAssets: Record<string, MediaAsset> = {}
  for (const track of project.tracks) {
    if (options.skipText || track.kind !== 'text') continue
    for (const clip of track.clips) {
      if (!clipIds.has(clip.id) || clip.overlay?.kind === 'blur') continue
      signal?.throwIfAborted()
      options.onProgress?.({ stage: `正在准备字幕：${clip.name}`, progress: completed / Math.max(1, total) })
      let canvas: HTMLCanvasElement | undefined, stage = '字幕画面准备'
      try {
        const width = Math.ceil(clip.width * rasterScale), height = Math.ceil(clip.height * rasterScale)
        if (width > 16384 || height > 16384 || width * height > 32_000_000) throw new Error('字幕区域过大，请缩小字幕区域后再导出。')
        canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('无法创建字幕图层。')
        context.scale(rasterScale, rasterScale)
        drawTextClip(context, clip)
        stage = '字幕 PNG 导出'
        const target = canvas
        const blob = await new Promise<Blob>((resolve, reject) => target.toBlob(value => value ? resolve(value) : reject(new Error('字幕图层生成失败。')), 'image/png'))
        signal?.throwIfAborted()
        const bytes = new Uint8Array(await blob.arrayBuffer())
        signal?.throwIfAborted()
        stage = '字幕图层导入'
        textAssets[clip.id] = await importBlobAsset(bytes, `字幕-${clip.id}.png`)
        signal?.throwIfAborted()
      } catch (cause) { throw mediaToolError(stage, cause, { resource: { clipId: clip.id, name: clip.name } }) }
      finally { if (canvas) canvas.width = canvas.height = 1 }
      completed++
    }
  }
  return { project, textAssets }
}
