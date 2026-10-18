import type { MediaAsset } from './core/types'
import { isDesktop } from './native'

export interface AsrTimedText { text: string; start: number; end: number }
export interface AsrSegment extends AsrTimedText { words: AsrTimedText[]; tokens: AsrTimedText[]; boundaryAdjustedForChunk?: boolean }
export interface AsrResult {
  text: string; language: string; segments: AsrSegment[]; tokens: AsrTimedText[]
  timestampKind: 'model'; wordSegmentation: 'latin-whitespace-and-cjk-model-tokens'
  backend: string; fallbackFrom?: string; duration: number; modelId: string
}
export interface AsrJob {
  id: string; state: 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number; stage: string; result?: AsrResult | Record<string, unknown> | null; error?: string | null
}
export interface AsrModelStatus {
  id: string; name: string; status: 'not-downloaded' | 'downloading' | 'verifying' | 'ready' | 'failed'
  downloadSize: number; modelSize: number; downloadedBytes: number; progress: number
  hardware: string; language: string; error?: string | null; jobId?: string | null
}
export interface AsrStatus { ready: boolean; runtimeReady: boolean; error?: string | null; models: AsrModelStatus[] }
export interface AsrTranscriptionSpec {
  asset: MediaAsset; modelId?: string; language?: string; granularity?: 'sentence' | 'word'
  trimIn?: number; trimOut?: number; speed?: number
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Error('离线语音识别需要桌面端。')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}
export function getAsrStatus(): Promise<AsrStatus> { return call('asr_status') }
export function beginAsrDownload(modelId?: string): Promise<AsrJob> { return call('asr_download', { modelId: modelId ?? null }) }
export function beginAsrTranscription(spec: AsrTranscriptionSpec): Promise<AsrJob> { return call('asr_transcribe', { spec }) }
export function getAsrJob(id: string): Promise<AsrJob> { return call('asr_job', { id }) }
export function cancelAsrJob(id: string): Promise<void> { return call('asr_cancel', { id }) }
