import type { SpeechVoice } from '../native'

export function voiceReady(voice: SpeechVoice | undefined): boolean {
  return !!voice && (!voice.status || voice.status === 'bundled' || voice.status === 'ready')
}

export function voiceDownloading(voice: SpeechVoice): boolean {
  return voice.status === 'downloading' || voice.status === 'verifying'
}

export function voiceDownloadProgress(voice: SpeechVoice): number {
  if (!Number.isFinite(voice.downloadSize) || !voice.downloadSize || voice.downloadSize <= 0) return 0
  const bytes = Number.isFinite(voice.downloadedBytes) ? voice.downloadedBytes || 0 : 0
  return Math.min(100, Math.max(0, Math.floor(bytes / voice.downloadSize * 100)))
}

export function voiceModelSize(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2).replace(/0$/, '')} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`
  if (bytes >= 1_000) return `${Math.ceil(bytes / 1_000)} KB`
  return `${Math.ceil(bytes)} B`
}
