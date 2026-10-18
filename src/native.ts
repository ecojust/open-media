import type { MediaAsset, Project } from './core/types'
import type { CaptureControlAction, CaptureControlsSnapshot } from './core/capture-controls'
import { ensureMediaPreview, type MediaPreviewFormat } from './core/media-import'

export interface RuntimeStatus { ready: boolean; version?: string; source?: string; error?: string }
export interface ExportConfig { format: 'mp4' | 'webm' | 'mov' | 'gif'; width: number; height: number; fps: number; quality: 'draft' | 'balanced' | 'high' }
export type MediaJobSpec =
  | { kind: 'timeline'; project: Project; config: ExportConfig; textAssets?: Record<string, MediaAsset> }
  | { kind: 'convert'; asset: MediaAsset; format: string; width?: number; height?: number; fps?: number; quality?: 'draft' | 'balanced' | 'high'; audioOnly?: boolean; sampleRate?: number; videoBitrate?: number; audioBitrate?: number; trimStart?: number; trimEnd?: number }
  | { kind: 'gif'; asset: MediaAsset; segments: { start: number; end: number }[]; width: number; fps: number; loop?: boolean }
export interface MediaJob { id: string; state: 'running' | 'completed' | 'failed' | 'cancelled'; progress: number; name: string; outputPath?: string; error?: string; startedAt?: number; elapsedSeconds?: number; backend?: string; stage?: string; fallbackReason?: string }
export interface CaptureSize { width: number; height: number }
export interface CaptureRegion extends CaptureSize { x: number; y: number }
export interface CaptureOptions { fps: number; microphone: boolean; sourceId?: string; screenId?: string; audioDevice?: string; region?: CaptureRegion; outputSize?: CaptureSize; requestId?: string }
export interface CaptureStatus { state: 'idle' | 'recording' | 'paused' | 'stopping'; elapsed: number; segments: number; error?: string; sourceId?: string; sourceName?: string; sourceWidth?: number; sourceHeight?: number; outputSize?: CaptureSize; muted?: boolean; audioAvailable?: boolean; microphoneEnabled?: boolean }
export interface CaptureDevice { id: string; name: string; kind: 'screen' | 'window' | 'audio'; width?: number; height?: number; bounds?: CaptureRegion; scaleFactor?: number }
export interface CapturePickerPreferences { purpose?: 'record' | 'screenshot'; mode: 'region' | 'window' | 'screen'; sourceId?: string; outputSize?: CaptureSize; microphone?: boolean; audioDevice?: string }
export interface CaptureSelection { sourceId: string; sourceName?: string; sourceWidth?: number; sourceHeight?: number; region?: CaptureRegion; outputSize?: CaptureSize; microphone?: boolean; audioDevice?: string }
export type SpeechVoiceStatus = 'bundled' | 'not-downloaded' | 'downloading' | 'verifying' | 'ready' | 'failed' | 'unsupported'
export type SpeechRuntimeStatus = Exclude<SpeechVoiceStatus, 'bundled'> | 'upgrade-available' | 'upgrade-downloading' | 'upgrade-verifying' | 'upgrade-failed'
export interface SpeechVoice {
  id: string; name: string; language: string; gender?: string
  modelId?: string; modelSize?: number; downloadSize?: number; status?: SpeechVoiceStatus; downloadedBytes?: number; error?: string
  runtimeSize?: number; runtimeStatus?: SpeechRuntimeStatus; runtimeError?: string; runtimeDownloadId?: string
  license?: string; usageNote?: string
  downloadSources?: string[]; downloadSource?: string
}
export interface SpeechStatus { ready: boolean; voices: SpeechVoice[]; error?: string }
export interface SpeechRequest { requestId: string; text: string; voiceId: string; speed: number }
export interface SpeechJob { id: string; state: 'running' | 'completed' | 'failed' | 'cancelled'; progress?: number; stage: string; message?: string; asset?: MediaAsset; error?: string }

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
export async function revealMediaJobOutput(id: string): Promise<void> { return call('reveal_media_job_output', { id }) }
export async function revealMediaAsset(asset: MediaAsset): Promise<void> { return call('reveal_media_asset', { asset }) }
export async function getSpeechStatus(): Promise<SpeechStatus> {
  return isDesktop() ? call('get_speech_status') : { ready: false, voices: [], error: '离线文字转语音由桌面端提供，安装包内含语音模型和音色。' }
}
export async function beginSpeechModelDownload(modelId: string): Promise<SpeechStatus> { return call('begin_speech_model_download', { modelId }) }
export async function repairSpeechModel(modelId: string): Promise<SpeechStatus> { return call('repair_speech_model', { modelId }) }
export async function cancelSpeechModelDownload(modelId: string): Promise<SpeechStatus> { return call('cancel_speech_model_download', { modelId }) }
async function speechJobAsset(job: SpeechJob): Promise<SpeechJob> { return job.asset ? { ...job, asset: await assetUrl(job.asset) } : job }
export async function beginSpeechJob(request: SpeechRequest): Promise<SpeechJob> { return speechJobAsset(await call('begin_speech_job', { request })) }
export async function getSpeechJob(id: string): Promise<SpeechJob> { return speechJobAsset(await call('get_speech_job', { id })) }
export async function cancelSpeechJob(id: string): Promise<void> { return call('cancel_speech_job', { id }) }
export async function discardSpeechJob(id: string): Promise<void> { return call('discard_speech_job', { id }) }
export async function acceptSpeechJobs(ids: string[]): Promise<void> { return call('accept_speech_jobs', { ids }) }
export async function listCaptureDevices(requestPermission = false): Promise<CaptureDevice[]> { return call('list_capture_devices', { requestPermission }) }
export async function pickCaptureSource(requestId: string, preferences: CapturePickerPreferences): Promise<CaptureSelection | null> { return call('pick_capture_source', { requestId, preferences }) }
export async function cancelCapturePicker(requestId: string): Promise<void> { return call('cancel_capture_picker', { requestId }) }
export async function getCaptureStatus(): Promise<CaptureStatus> { return call('get_capture_status') }
export async function startCapture(options: CaptureOptions): Promise<CaptureStatus> { return call('start_capture', { options }) }
export async function cancelCaptureStart(requestId: string): Promise<void> { return call('cancel_capture_start', { requestId }) }
export async function pauseCapture(): Promise<CaptureStatus> { return call('pause_capture') }
export async function resumeCapture(): Promise<CaptureStatus> { return call('resume_capture') }
export async function setCaptureMuted(muted: boolean): Promise<CaptureStatus> { return call('set_capture_muted', { muted }) }
export async function setCaptureMicrophone(enabled: boolean, requestId: string): Promise<CaptureStatus> { return call('set_capture_microphone', { enabled, requestId }) }
export async function captureControlsReady(): Promise<CaptureControlsSnapshot> { return call('capture_controls_ready') }
export async function requestCaptureControlAction(action: CaptureControlAction): Promise<void> { return call('capture_controls_action', { action }) }
export async function onCaptureControlsState(handler: (snapshot: CaptureControlsSnapshot) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<CaptureControlsSnapshot>('capture-controls-state', event => handler(event.payload))
}
export async function onCaptureControlsAction(handler: (action: CaptureControlAction) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<{ action: CaptureControlAction }>('capture-controls-action', event => handler(event.payload.action))
}
export async function stopCapture(): Promise<MediaAsset | null> { const asset = await call<MediaAsset | null>('stop_capture'); return asset ? assetUrl(asset) : null }
export async function saveBytes(name: string, bytes: Uint8Array): Promise<string | null> { return call('save_bytes', { name, bytes: Array.from(bytes) }) }
export async function writeClipboardImage(width: number, height: number, rgba: Uint8ClampedArray, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!isDesktop()) throw new Error('此操作需要桌面端。')
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('剪贴板图片尺寸或像素数据无效。')
  if (width * height > 40_000_000) throw new Error('复制图片最多支持 4000 万像素，请减小尺寸后重试。')
  if (rgba.length !== width * height * 4) throw new Error('剪贴板图片尺寸或像素数据无效。')
  // Binary IPC avoids expanding a full-resolution screenshot into a large JSON array.
  const packet = new Uint8Array(8 + rgba.byteLength)
  const header = new DataView(packet.buffer)
  header.setUint32(0, width, true)
  header.setUint32(4, height, true)
  packet.set(rgba, 8)
  const { invoke } = await import('@tauri-apps/api/core')
  signal?.throwIfAborted()
  return invoke('copy_image_to_clipboard', packet)
}
export interface ProjectFileTarget { name: string; path: string; token: string }
export async function saveProjectFile(name: string, bytes: Uint8Array, token?: string): Promise<ProjectFileTarget | null> { return call('save_project_file', { name, bytes: Array.from(bytes), token: token ?? null }) }
export async function openProjectFile(): Promise<(ProjectFileTarget & { bytes: number[] }) | null> { return call('open_project_file') }

export async function onNativeCloseRequest(handler: () => void): Promise<() => void> {
  if (!isDesktop()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen('native-close-requested', handler)
}
export async function closeNativeWindow(): Promise<void> { return call('close_native_window') }

export async function configureScreenshotShortcut(shortcut: string | null): Promise<string | null> { return call('configure_screenshot_shortcut', { shortcut }) }
export async function captureScreenshot(selection: CaptureSelection): Promise<MediaAsset> { return assetUrl(await call('capture_screenshot', { selection })) }
export async function onScreenshotRequested(handler: () => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen('screenshot-requested', handler)
}
export async function showMainWindow(): Promise<void> { return call('show_main_window') }
