import type { MediaAsset } from './core/types.ts'

export type CompressionMode = 'lossless' | 'quality'
export type CompressionQuality = 'high' | 'balanced' | 'compact'
export interface CompressionItem {
  sourceIds: string[]
  sourceSize: number
  outputSize?: number
  asset?: MediaAsset
  state: 'waiting' | 'running' | 'completed' | 'skipped'
  message?: string
}
export interface CompressionJob {
  id: string
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  stage: string
  message?: string
  current: number
  total: number
  elapsedSeconds: number
  backend?: string
  items: CompressionItem[]
  error?: string
}
export interface CompressionRequest { assets: MediaAsset[]; mode: CompressionMode; quality?: CompressionQuality }

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { isDesktop } = await import('./native.ts')
  if (!isDesktop()) throw new Error('工程视频压缩需要桌面端。')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}
export function beginProjectVideoCompression(request: CompressionRequest): Promise<CompressionJob> { return call('begin_project_video_compression', { ...request }) }
export function getProjectVideoCompressionJob(id: string): Promise<CompressionJob> { return call('get_project_video_compression_job', { id }) }
export function cancelProjectVideoCompression(id: string): Promise<void> { return call('cancel_project_video_compression', { id }) }
export function acceptProjectVideoCompression(id: string): Promise<void> { return call('accept_project_video_compression', { id }) }
export function discardProjectVideoCompression(id: string): Promise<void> { return call('discard_project_video_compression', { id }) }

/** A compatible preview always points back to the new working copy for export. */
export async function prepareProjectCompressionAsset(asset: MediaAsset, signal?: AbortSignal, jobId?: string): Promise<MediaAsset> {
  signal?.throwIfAborted()
  if (!asset.nativePath || !jobId) throw new Error('压缩视频未返回本地文件路径或任务标识。')
  const { convertFileSrc } = await import('@tauri-apps/api/core')
  const { ensureMediaPreview } = await import('./core/media-import.ts')
  const source = { ...asset, url: convertFileSrc(asset.nativePath) }
  delete source.sourceUrl
  let abort: (() => void) | undefined
  try {
    const preparing = ensureMediaPreview(source, async (value, format) => {
      signal?.throwIfAborted()
      const result = await call<{ path: string }>('prepare_project_video_compression_preview', { id: jobId, assetId: value.id, format })
      signal?.throwIfAborted()
      return convertFileSrc(result.path)
    })
    const ready = signal ? await Promise.race([preparing, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new DOMException('处理已取消。', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })]) : await preparing
    signal?.throwIfAborted()
    return ready
  } finally { if (abort) signal?.removeEventListener('abort', abort) }
}
