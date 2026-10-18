import type { SpeechVoice } from '../native'

export function voiceDownloadId(voice: SpeechVoice): string | undefined {
  return voice.runtimeDownloadId || voice.modelId
}

export function voiceRepairId(voice: SpeechVoice): string | undefined {
  return voice.modelId || (voice.runtimeStatus === 'ready' || voice.runtimeStatus === 'upgrade-failed' ? voice.runtimeDownloadId : undefined)
}

export function voiceRuntimeUpgrade(voice: SpeechVoice): boolean {
  return ['upgrade-available', 'upgrade-downloading', 'upgrade-verifying', 'upgrade-failed'].includes(voice.runtimeStatus || '')
}

export function voiceReady(voice: SpeechVoice | undefined): boolean {
  return !!voice && (!voice.status || voice.status === 'bundled' || voice.status === 'ready')
    && (!voice.runtimeStatus || voice.runtimeStatus === 'ready' || voiceRuntimeUpgrade(voice))
}

export function voiceDownloading(voice: SpeechVoice): boolean {
  return voice.status === 'downloading' || voice.status === 'verifying'
    || voice.runtimeStatus === 'downloading' || voice.runtimeStatus === 'verifying'
    || voice.runtimeStatus === 'upgrade-downloading' || voice.runtimeStatus === 'upgrade-verifying'
}

export function voiceUnsupported(voice: SpeechVoice): boolean {
  return voice.status === 'unsupported' || voice.runtimeStatus === 'unsupported'
}

export function voiceRuntimeLabel(voice: SpeechVoice): string {
  if (!voice.runtimeStatus && !voice.runtimeSize) return ''
  const labels: Record<NonNullable<SpeechVoice['runtimeStatus']>, string> = {
    'not-downloaded': '待下载', downloading: '下载中', verifying: '校验中', ready: '已就绪', failed: '未就绪', unsupported: '当前平台不可用',
    'upgrade-available': '可下载 · CPU 可用', 'upgrade-downloading': '下载中 · CPU 可用',
    'upgrade-verifying': '校验中 · CPU 可用', 'upgrade-failed': '下载失败 · CPU 可用',
  }
  const size = voiceModelSize(voice.runtimeSize)
  const state = voice.runtimeStatus ? labels[voice.runtimeStatus] : ''
  return [voiceRuntimeUpgrade(voice) ? 'GPU 加速组件' : '运行组件', size, state].filter(Boolean).join(' · ')
}

export function voiceDownloadProgress(voice: SpeechVoice): number {
  if (!Number.isFinite(voice.downloadSize) || !voice.downloadSize || voice.downloadSize <= 0) return 0
  const bytes = Number.isFinite(voice.downloadedBytes) ? voice.downloadedBytes || 0 : 0
  const runtimeSize = voice.runtimeSize || 0
  if (voiceRuntimeUpgrade(voice)) {
    if (!Number.isFinite(runtimeSize) || runtimeSize <= 0) return 0
    const installedModel = Math.max(0, voice.downloadSize - runtimeSize)
    return Math.min(100, Math.max(0, Math.floor((bytes - installedModel) / runtimeSize * 100)))
  }
  return Math.min(100, Math.max(0, Math.floor(bytes / voice.downloadSize * 100)))
}

/** Installed runtime bytes count toward progress, but are not downloaded twice. */
export function voiceDownloadSize(voice: SpeechVoice): number | undefined {
  if (voiceRuntimeUpgrade(voice)) return Number.isFinite(voice.runtimeSize) && (voice.runtimeSize || 0) > 0 ? voice.runtimeSize : undefined
  if (!Number.isFinite(voice.downloadSize) || !voice.downloadSize || voice.downloadSize < 0) return undefined
  const installedRuntime = voice.runtimeStatus === 'ready' && Number.isFinite(voice.runtimeSize) ? Math.max(0, voice.runtimeSize || 0) : 0
  return Math.max(0, voice.downloadSize - installedRuntime)
}

export function voiceSourceOrigin(source: string | undefined): string {
  if (!source) return ''
  try {
    const url = new URL(source)
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : ''
  } catch { return '' }
}

export function voiceDownloadSources(voice: SpeechVoice): string[] {
  return [...new Set((voice.downloadSources || []).map(voiceSourceOrigin).filter(Boolean))]
}

export function voiceModelSize(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2).replace(/0$/, '')} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`
  if (bytes >= 1_000) return `${Math.ceil(bytes / 1_000)} KB`
  return `${Math.ceil(bytes)} B`
}
