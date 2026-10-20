import type { MediaAsset } from './core/types'
import { ensureMediaPreview } from './core/media-import'
import { createMediaPreview, isDesktop } from './native'

export type AssetToolOperation = 'asset_upload_begin' | 'asset_upload_chunk' | 'asset_upload_status' | 'asset_upload_commit' | 'asset_upload_abort' | 'asset_import_url' | 'asset_probe' | 'asset_prepare_preview' | 'asset_get_frame' | 'asset_storyboard' | 'asset_detect_scenes' | 'asset_detect_idle' | 'validate_export'
export interface AssetToolProgress { stage: string; progress?: number }
export interface AssetToolOptions { taskId?: string; signal?: AbortSignal; onProgress?: (progress: AssetToolProgress) => void }
export interface AssetSource { kind: 'upload' | 'url'; name?: string; url?: string; finalUrl?: string; mimeType?: string; sha256: string; size?: number; importedAt: number }
export interface ImportedAssetResult { asset: MediaAsset; source: AssetSource }
export interface AssetFrame { mimeType: 'image/png'; requestedTime: number; sourceTime: number | null; width: number; height: number; base64: string; encodedBytes: number }
export interface AssetStoryboard { assetId: string; start: number; end: number; frames: AssetFrame[]; encodedBytes: number }
export interface AssetUploadStatus { uploadId: string; name?: string; receivedBytes: number; totalBytes: number; sha256?: string; ready?: boolean; maxChunkBytes?: number; expiresInSeconds?: number; replayed?: boolean }

const cancelled = () => new DOMException('素材任务已取消。', 'AbortError')
function check(signal?: AbortSignal): void { if (signal?.aborted) throw cancelled() }

export async function cancelAssetTool(taskId: string): Promise<boolean> {
  if (!isDesktop()) throw new Error('素材分析与传输需要桌面端。')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<boolean>('mcp_asset_cancel', { taskId })
}

/** The shared editor service resolves asset IDs; native code authorizes its stored file. */
export async function runAssetTool<T = Record<string, unknown>>(operation: AssetToolOperation, args: Record<string, unknown>, options: AssetToolOptions = {}): Promise<T> {
  if (!isDesktop()) throw new Error('素材分析与传输需要桌面端。')
  check(options.signal)
  const taskId = options.taskId ?? `asset-${crypto.randomUUID()}`
  const { invoke, convertFileSrc } = await import('@tauri-apps/api/core')
  check(options.signal)
  const abort = () => { void invoke('mcp_asset_cancel', { taskId }).catch(() => {}) }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) { abort(); options.signal.removeEventListener('abort', abort); throw cancelled() }
  try {
    options.onProgress?.({ stage: operation === 'asset_import_url' ? '正在下载并检查素材' : '正在处理素材' })
    const result = await invoke<T>('mcp_asset_tool', { taskId, operation, args })
    check(options.signal)
    if (operation === 'asset_upload_commit' || operation === 'asset_import_url') {
      const imported = result as ImportedAssetResult
      if (imported.asset?.nativePath) {
        imported.asset = await ensureMediaPreview({ ...imported.asset, url: convertFileSrc(imported.asset.nativePath) }, createMediaPreview)
        check(options.signal)
      }
    }
    options.onProgress?.({ stage: '已完成', progress: 1 })
    return result
  } catch (error) {
    if (options.signal?.aborted) throw cancelled()
    throw error
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
}

/** GUI file uploads use the same bounded, digest-verified transfer as remote callers. */
export async function uploadAsset(file: File, options: AssetToolOptions = {}): Promise<ImportedAssetResult> {
  check(options.signal)
  if (!file.size || file.size > 1024 ** 3) throw new Error('上传媒体大小须为 1 字节至 1 GB。')
  // Local GUI imports normally use the native file picker. This helper is for
  // browser File objects and keeps hashing memory bounded to small attachments.
  if (file.size > 64 * 1024 ** 2) throw new Error('浏览器文件上传最多支持 64 MB；更大的文件请通过本地素材导入。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  check(options.signal)
  const sha256 = async (value: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const begin = await runAssetTool<AssetUploadStatus>('asset_upload_begin', { name: file.name, size: bytes.length, sha256: await sha256(bytes) }, { signal: options.signal })
  try {
    const chunkSize = Math.min(begin.maxChunkBytes ?? 512 * 1024, 512 * 1024)
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      check(options.signal)
      const chunk = bytes.slice(offset, offset + chunkSize)
      let binary = ''
      for (let start = 0; start < chunk.length; start += 8192) binary += String.fromCharCode(...chunk.subarray(start, start + 8192))
      await runAssetTool('asset_upload_chunk', { uploadId: begin.uploadId, offset, base64: btoa(binary), sha256: await sha256(chunk) }, { signal: options.signal })
      options.onProgress?.({ stage: '正在上传素材', progress: Math.min(1, (offset + chunk.length) / bytes.length) * .9 })
    }
    return await runAssetTool<ImportedAssetResult>('asset_upload_commit', { uploadId: begin.uploadId }, { signal: options.signal, onProgress: options.onProgress })
  } catch (error) {
    await runAssetTool('asset_upload_abort', { uploadId: begin.uploadId }).catch(() => {})
    throw error
  }
}
