import type { MediaAsset } from './types.ts'
import type { SpeechRequest } from '../native.ts'
import type { VideoGenerationRequest } from './video-generation.ts'

export type AiProvider = 'speech' | 'video' | 'image' | 'music' | 'transcription'
export type AiCapability = 'text-to-speech' | 'text-to-video' | 'image-to-video' | 'reference-to-video' | 'storyboard-to-video' | 'text-to-image' | 'image-to-image' | 'text-to-music' | 'lyrics-to-song' | 'audio-to-text'
export interface AiRuntimeStatus { state: string; device?: string; reason?: string }
export interface AiModel {
  id: string
  name: string
  provider: AiProvider
  capabilities: AiCapability[]
  version: string
  size: number
  downloadedBytes: number
  downloadTotalBytes?: number
  downloadTransferredBytes?: number
  downloadPhase?: 'runtime' | 'model' | 'verifying'
  activeSource?: string
  downloadSession?: number
  downloadSpeedBytesPerSecond?: number
  remainingSeconds?: number
  state: 'not-downloaded' | 'downloading' | 'verifying' | 'ready' | 'failed' | 'unsupported' | 'update-available'
  hardware: string
  runtime: AiRuntimeStatus
  bundled: boolean
  requiresLicenseAcceptance: boolean
  license?: string
  licenseUrl?: string
  error?: string
  voices?: { id: string; name: string; language: string; gender?: string }[]
}
export interface AiJob {
  id: string
  provider: AiProvider
  modelId?: string
  kind: 'download' | 'generation'
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  stage: string
  progress?: number
  startedAt: number
  elapsedSeconds: number
  assets: MediaAsset[]
  cancelable: boolean
  error?: string
  warning?: string
}
export interface AiStatus { models: AiModel[]; jobs: AiJob[]; busy: boolean }
export interface AiGenerationRequest {
  requestId: string
  modelId: string
  prompt: string
  negativePrompt?: string
  inputAsset?: MediaAsset
  strength?: number
  width?: number
  height?: number
  steps?: number
  guidance?: number
  seed?: number
  lyrics?: string
  instrumental?: boolean
  seconds?: number
  bpm?: number
  language?: string
  keyScale?: string
  lowMemory?: boolean
}
export type AiRequest = { provider: 'speech'; request: SpeechRequest } | { provider: 'video'; request: VideoGenerationRequest } | { provider: 'image' | 'music'; request: AiGenerationRequest }
