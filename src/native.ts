import type { MediaAsset, Project } from './core/types'
import { ensureMediaPreview, type MediaPreviewFormat } from './core/media-import'

export interface RuntimeStatus { ready: boolean; version?: string; source?: string; error?: string }
export interface ExportConfig { format: 'mp4' | 'webm' | 'mov' | 'gif'; width: number; height: number; fps: number; quality: 'draft' | 'balanced' | 'high' }
export type MediaJobSpec =
  | { kind: 'timeline'; project: Project; config: ExportConfig; textAssets?: Record<string, MediaAsset> }
  | { kind: 'convert'; asset: MediaAsset; format: string; width?: number; height?: number; fps?: number; quality?: 'draft' | 'balanced' | 'high'; audioOnly?: boolean; sampleRate?: number; videoBitrate?: number; audioBitrate?: number; trimStart?: number; trimEnd?: number }
  | { kind: 'gif'; asset: MediaAsset; segments: { start: number; end: number }[]; width: number; fps: number; loop?: boolean }
export interface MediaJob { id: string; state: 'running' | 'completed' | 'failed' | 'cancelled'; progress: number; name: string; outputPath?: string; error?: string }
export interface CaptureOptions { fps: number; microphone: boolean; screenId?: string; audioDevice?: string; region?: { x: number; y: number; width: number; height: number } }
export interface CaptureStatus { state: 'idle' | 'recording' | 'paused' | 'stopping'; elapsed: number; segments: number; error?: string }
export interface CaptureDevice { id: string; name: string; kind: 'screen' | 'audio' }

export function isDesktop(): boolean { return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window }
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Error('此操作需要桌面端。')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}
async function assetUrl(asset: MediaAsset): Promise<MediaAsset> {
  if (!asset.nativePath) return asset
  const { convertFileSrc } = await import('@tauri-apps/api/core')
  return ensureMediaPreview({ ...asset, url: convertFileSrc(asset.nativePath) }, createMediaPreview)
}
export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  if (!isDesktop()) return { ready: false, error: '完整媒体编码由桌面端提供。' }
  return call('get_runtime_status')
}
export async function selectRuntime(): Promise<RuntimeStatus> { return call('select_runtime') }
export async function pickMediaAssets(): Promise<MediaAsset[]> {
  const assets = await call<MediaAsset[]>('pick_media_assets')
  const ready: MediaAsset[] = []
  for (const asset of assets) ready.push(await assetUrl(asset))
  return ready
}
export async function importBlobAsset(bytes: Uint8Array, name: string): Promise<MediaAsset> {
  return assetUrl(await call('import_blob_asset', { name, bytes: Array.from(bytes) }))
}
export async function createMediaPreview(asset: MediaAsset, format?: MediaPreviewFormat): Promise<string> {
  const result = await call<{ path: string }>('create_media_preview', { asset, format })
  const { convertFileSrc } = await import('@tauri-apps/api/core')
  return convertFileSrc(result.path)
}
async function localAsset(asset: MediaAsset): Promise<MediaAsset> {
  if (asset.nativePath) return asset
  const response = await fetch(asset.sourceUrl || asset.url)
  if (!response.ok) throw new Error(`无法读取素材：${asset.name}`)
  const imported = await importBlobAsset(new Uint8Array(await response.arrayBuffer()), asset.name)
  return { ...imported, id: asset.id }
}
export async function beginMediaJob(spec: MediaJobSpec): Promise<MediaJob | null> {
  if (!isDesktop()) throw new Error('完整媒体导出需要桌面端。')
  if (spec.kind === 'timeline') {
    const assets = await Promise.all(spec.project.assets.map(localAsset))
    const textAssets = Object.fromEntries(await Promise.all(Object.entries(spec.textAssets ?? {}).map(async ([id, asset]) => [id, await localAsset(asset)])))
    return call('begin_media_job', { spec: { ...spec, project: { ...spec.project, assets }, textAssets } })
  }
  return call('begin_media_job', { spec: { ...spec, asset: await localAsset(spec.asset) } })
}
export async function getMediaJobs(): Promise<MediaJob[]> { return isDesktop() ? call('get_media_jobs') : [] }
export async function cancelMediaJob(id: string): Promise<void> { return call('cancel_media_job', { id }) }
export async function listCaptureDevices(): Promise<CaptureDevice[]> { return call('list_capture_devices') }
export async function getCaptureStatus(): Promise<CaptureStatus> { return call('get_capture_status') }
export async function startCapture(options: CaptureOptions): Promise<CaptureStatus> { return call('start_capture', { options }) }
export async function pauseCapture(): Promise<CaptureStatus> { return call('pause_capture') }
export async function resumeCapture(): Promise<CaptureStatus> { return call('resume_capture') }
export async function stopCapture(): Promise<MediaAsset | null> { const asset = await call<MediaAsset | null>('stop_capture'); return asset ? assetUrl(asset) : null }
export async function saveBytes(name: string, bytes: Uint8Array): Promise<string | null> { return call('save_bytes', { name, bytes: Array.from(bytes) }) }
export async function openProjectFile(): Promise<{ name: string; bytes: number[] } | null> { return call('open_project_file') }

export async function onNativeCloseRequest(handler: () => void): Promise<() => void> {
  if (!isDesktop()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen('native-close-requested', handler)
}
export async function closeNativeWindow(): Promise<void> { return call('close_native_window') }
