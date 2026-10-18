import type { MediaAsset, Project } from './types.ts'
import type { WatermarkMaterial } from './watermark-library.ts'
import type { BackgroundMusicItem } from './background-music-catalog.ts'
import type { VideoSegmentItem } from './video-segment-catalog.ts'
import type { VideoSegmentPlacement } from './video-segment-presets.ts'
import { addTextWatermark, addWatermark } from './watermark-track.ts'
import { chooseWatermarkSource } from './watermark-source.ts'
import { addBackgroundMusic } from './background-music-track.ts'
import { insertVideoSegment } from './video-segment-track.ts'
import { MAX_PROJECT_DURATION } from './project.ts'

export type McpMaterialKind = 'watermark' | 'music' | 'video_segment'
export interface McpMaterialQuery { kind: McpMaterialKind; search?: string; offset?: number; limit?: number }
export interface McpMaterialArguments {
  kind: McpMaterialKind
  id: string
  start?: number
  placement?: VideoSegmentPlacement
  heading?: string
  subheading?: string
}
export interface McpMaterialMetadata {
  id: string
  name: string
  category: string
  description: string
  duration: number
  mediaKind: 'video' | 'image' | 'audio' | 'text'
  width?: number
  height?: number
  tags?: string[]
  editableText?: boolean
  text?: string
  placement?: string
  heading?: string
  subheading?: string
}
export interface McpMaterialDependencies {
  loadWatermarks?(): Promise<readonly WatermarkMaterial[]>
  loadMusic?(): Promise<readonly BackgroundMusicItem[]>
  loadVideoSegments?(): Promise<readonly VideoSegmentItem[]>
  /** Dependency hooks are application-owned, never exposed as MCP arguments. */
  native?: { isDesktop(): boolean; importBlobAsset(bytes: Uint8Array, name: string): Promise<MediaAsset> }
  fetchBlob?(url: string, signal?: AbortSignal): Promise<Blob>
  chooseWatermarkSource?(material: WatermarkMaterial): string
}
export interface McpMaterialOptions extends McpMaterialDependencies {
  signal?: AbortSignal
  onAsset?(asset: MediaAsset, blob: Blob): void
}
export interface PreparedMcpMaterial {
  project: Project
  label: string
  selection: { clipId: string; trackId: string }
  assets?: { asset: MediaAsset; blob: Blob }[]
}

function checkKind(kind: unknown): asserts kind is McpMaterialKind {
  if (!['watermark', 'music', 'video_segment'].includes(kind as string)) throw new Error('内置素材类型无效。')
}
async function watermarks(dependencies: McpMaterialDependencies): Promise<readonly WatermarkMaterial[]> {
  return dependencies.loadWatermarks ? dependencies.loadWatermarks() : (await import('./watermark-library.ts')).WATERMARK_MATERIALS
}
async function music(dependencies: McpMaterialDependencies): Promise<readonly BackgroundMusicItem[]> {
  return dependencies.loadMusic ? dependencies.loadMusic() : (await import('./background-music-catalog.ts')).BACKGROUND_MUSIC
}
async function videoSegments(dependencies: McpMaterialDependencies): Promise<readonly VideoSegmentItem[]> {
  return dependencies.loadVideoSegments ? dependencies.loadVideoSegments() : (await import('./video-segment-catalog.ts')).VIDEO_SEGMENTS
}

/** Return a compact catalog, without exposing internal media URLs or local paths. */
export async function listMcpMaterials(query: McpMaterialQuery, dependencies: McpMaterialDependencies = {}): Promise<{ kind: McpMaterialKind; total: number; offset: number; limit: number; items: McpMaterialMetadata[] }> {
  checkKind(query.kind)
  const offset = query.offset ?? 0, limit = query.limit ?? 50
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('素材分页参数无效。')
  if (query.search !== undefined && (typeof query.search !== 'string' || query.search.length > 200)) throw new Error('素材搜索文字过长或格式无效。')
  let items: McpMaterialMetadata[]
  if (query.kind === 'watermark') {
    items = (await watermarks(dependencies)).map(item => ({ id: item.id, name: item.name, category: item.category, description: item.tags.join(' · '), tags: [...item.tags], duration: item.duration, mediaKind: item.kind, width: item.width, height: item.height, editableText: item.kind === 'text', ...(item.kind === 'text' ? { text: item.textTemplate?.text } : {}), placement: item.placement }))
  } else if (query.kind === 'music') {
    items = (await music(dependencies)).map(item => ({ id: item.id, name: item.title, category: item.style, description: item.description, duration: item.duration, mediaKind: 'audio' }))
  } else {
    items = (await videoSegments(dependencies)).map(item => ({ id: item.id, name: item.title, category: item.style, description: item.description, duration: item.duration, mediaKind: 'video', width: item.width, height: item.height, editableText: true, placement: item.placement, heading: item.heading, subheading: item.subheading }))
  }
  const search = query.search?.trim().toLowerCase()
  if (search) items = items.filter(item => [item.id, item.name, item.category, item.description, item.text, item.heading, item.subheading].some(value => value?.toLowerCase().includes(search)))
  return { kind: query.kind, total: items.length, offset, limit, items: items.slice(offset, offset + limit) }
}

function bundledUrl(url: string): string {
  // Catalogs contain packaged relative URLs. A tool can select their IDs, never supply a URL.
  if (!url || /[\\\u0000-\u0020]/.test(url) || /^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//') || url.split(/[?#]/, 1)[0]!.split('/').some(part => part === '..')) throw new Error('内置素材地址无效。')
  return url
}
async function fetchBundledBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal, redirect: 'error' })
  if (!response.ok) throw new Error('内置素材读取失败，请检查安装文件。')
  if (Number(response.headers.get('content-length')) > 64 * 1024 * 1024) throw new Error('内置素材大小超出限制。')
  return response.blob()
}
function revokePreparedAsset(asset: MediaAsset): void {
  for (const url of new Set([asset.url, asset.sourceUrl])) if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
}

/** Prepare one reversible edit; the caller owns revision checking and committing it. */
export async function prepareMcpMaterial(project: Project, args: McpMaterialArguments, options: McpMaterialOptions = {}): Promise<PreparedMcpMaterial> {
  checkKind(args.kind)
  if (typeof args.id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(args.id)) throw new Error('内置素材标识无效。')
  const start = args.start ?? 0
  if (!Number.isFinite(start) || start < 0 || start > MAX_PROJECT_DURATION) throw new Error('素材起点无效。')
  if (args.kind !== 'video_segment' && (args.placement !== undefined || args.heading !== undefined || args.subheading !== undefined)) throw new Error('片头片尾位置和标题仅适用于视频片段。')
  if (args.placement !== undefined && !['prepend', 'append'].includes(args.placement)) throw new Error('请选择向前或向后添加视频片段。')
  if (args.heading !== undefined && (typeof args.heading !== 'string' || args.heading.length > 120 || args.heading.includes('\0'))) throw new Error('片头片尾标题最多支持 120 个字符。')
  if (args.subheading !== undefined && (typeof args.subheading !== 'string' || args.subheading.length > 240 || args.subheading.includes('\0'))) throw new Error('片头片尾副标题最多支持 240 个字符。')
  options.signal?.throwIfAborted()
  const native = options.native ?? await import('../native.ts')
  if (!native.isDesktop()) throw new Error('MCP 内置素材操作需要桌面端。')
  options.signal?.throwIfAborted()
  let asset: MediaAsset | undefined
  try {
    let url: string, name: string, label: string, expectedKind: 'video' | 'image' | 'audio'
    let apply: (asset: MediaAsset) => { project: Project; clipId: string; trackId: string }
    if (args.kind === 'watermark') {
      const material = (await watermarks(options)).find(item => item.id === args.id)
      options.signal?.throwIfAborted()
      if (!material) throw new Error('找不到这个内置水印，请重新浏览素材库。')
      if (material.kind === 'text') {
        const edit = addTextWatermark(project, material, start)
        options.signal?.throwIfAborted()
        return { project: edit.project, label: 'MCP 添加可编辑文字水印', selection: { clipId: edit.clipId, trackId: edit.trackId } }
      }
      url = bundledUrl((options.chooseWatermarkSource ?? chooseWatermarkSource)(material))
      expectedKind = material.kind
      const extension = new URL(url, 'https://bundled.invalid/').pathname.split('.').pop() || (material.kind === 'image' ? 'png' : 'mp4')
      name = `${material.name}.${extension}`
      label = 'MCP 添加水印素材'
      apply = value => addWatermark(project, value, start, { placement: material.placement ?? 'bottom-right', chromaKey: material.chromaKey, spillSuppression: material.spillSuppression })
    } else if (args.kind === 'music') {
      const material = (await music(options)).find(item => item.id === args.id)
      options.signal?.throwIfAborted()
      if (!material) throw new Error('找不到这段内置背景音乐，请重新浏览素材库。')
      url = bundledUrl(material.url)
      name = `${material.title}.${material.filename.split('.').pop() || 'mp3'}`
      expectedKind = 'audio'
      label = 'MCP 添加背景音乐'
      apply = value => addBackgroundMusic(project, value, start)
    } else {
      const material = (await videoSegments(options)).find(item => item.id === args.id)
      options.signal?.throwIfAborted()
      if (!material) throw new Error('找不到这个内置视频片段，请重新浏览素材库。')
      const placement = args.placement ?? material.placement
      const caption = { heading: args.heading ?? material.heading, subheading: args.subheading ?? material.subheading, textColor: material.textColor }
      url = bundledUrl(material.url)
      name = `${material.title}.${material.filename.split('.').pop() || 'webm'}`
      expectedKind = 'video'
      label = placement === 'prepend' ? 'MCP 添加片头，现有轨道同步后移' : 'MCP 添加片尾'
      apply = value => insertVideoSegment(project, value, placement, caption)
    }
    const blob = await (options.fetchBlob ?? fetchBundledBlob)(url, options.signal)
    options.signal?.throwIfAborted()
    if (!blob.size || blob.size > 64 * 1024 * 1024) throw new Error('内置素材文件为空或大小超出限制。')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    options.signal?.throwIfAborted()
    asset = await native.importBlobAsset(bytes, name)
    options.signal?.throwIfAborted()
    if (asset.kind !== expectedKind || !asset.nativePath) throw new Error('内置素材没有生成有效的本地媒体文件。')
    asset = { ...asset, libraryRole: args.kind === 'watermark' ? 'watermark' : args.kind === 'music' ? 'background-music' : 'video-segment' }
    const edit = apply(asset)
    options.signal?.throwIfAborted()
    options.onAsset?.(asset, blob)
    options.signal?.throwIfAborted()
    return { project: edit.project, label, selection: { clipId: edit.clipId, trackId: edit.trackId }, assets: [{ asset, blob }] }
  } catch (cause) {
    if (asset) revokePreparedAsset(asset)
    throw cause
  }
}
