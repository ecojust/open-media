import { cloneProject } from './project.ts'
import type { MediaAsset, Project } from './types.ts'
import { drawTextClip } from './preview.ts'
import { importBlobAsset } from '../native.ts'

export async function prepareNativeProject(source: Project, signal?: AbortSignal): Promise<{ project: Project; textAssets: Record<string, MediaAsset> }> {
  signal?.throwIfAborted()
  const project = cloneProject(source)
  for (const asset of project.assets) {
    signal?.throwIfAborted()
    if (asset.nativePath) continue
    const response = await fetch(asset.sourceUrl || asset.url, { signal })
    if (!response.ok) throw new Error(`无法读取素材：${asset.name}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    signal?.throwIfAborted()
    const imported = await importBlobAsset(bytes, asset.name)
    signal?.throwIfAborted()
    Object.assign(asset, imported, { id: asset.id })
  }
  const textAssets: Record<string, MediaAsset> = {}
  for (const track of project.tracks) {
    if (track.kind !== 'text') continue
    for (const clip of track.clips) {
      signal?.throwIfAborted()
      const width = Math.ceil(clip.width), height = Math.ceil(clip.height)
      if (width > 16384 || height > 16384 || width * height > 32_000_000) throw new Error('字幕区域过大，请缩小字幕区域后再导出。')
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法创建字幕图层。')
      drawTextClip(context, clip)
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('字幕图层生成失败。')), 'image/png'))
      canvas.width = canvas.height = 1
      signal?.throwIfAborted()
      const bytes = new Uint8Array(await blob.arrayBuffer())
      signal?.throwIfAborted()
      textAssets[clip.id] = await importBlobAsset(bytes, `字幕-${clip.id}.png`)
      signal?.throwIfAborted()
    }
  }
  return { project, textAssets }
}
