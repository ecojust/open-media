import type { SpeechVoice } from '../native'

export type VoiceCategoryId = 'zh-male' | 'zh-female' | 'en-female' | 'other'

export const VOICE_CATEGORIES: ReadonlyArray<{ id: VoiceCategoryId; label: string }> = [
  { id: 'zh-male', label: '中文男声' },
  { id: 'zh-female', label: '中文女声' },
  { id: 'en-female', label: '英文女声' },
  { id: 'other', label: '其他声音' },
]

function language(voice: SpeechVoice): string { return voice.language.toLowerCase().replace(/_/g, '-') }

export function voiceCategory(voice: SpeechVoice): VoiceCategoryId {
  const locale = language(voice), gender = voice.gender?.toLowerCase()
  if (locale.startsWith('zh') && gender === 'male') return 'zh-male'
  if (locale.startsWith('zh') && gender === 'female') return 'zh-female'
  if (locale.startsWith('en') && gender === 'female') return 'en-female'
  return 'other'
}

export function voiceTypeLabel(voice: SpeechVoice): string {
  const category = voiceCategory(voice), locale = language(voice)
  if (category === 'zh-male') return '中文 · 男声'
  if (category === 'zh-female') return '中文 · 女声'
  if (category === 'en-female') return `${locale === 'en-us' ? '美式英语' : locale === 'en-gb' ? '英式英语' : '英语'} · 女声`
  const gender = voice.gender?.toLowerCase()
  const kind = gender === 'male' ? '男声' : gender === 'female' ? '女声' : '未标注性别'
  let label = locale.startsWith('zh') ? '中文' : locale.startsWith('en') ? '英语' : ''
  if (!label) {
    try { label = new Intl.DisplayNames(['zh-CN'], { type: 'language', fallback: 'none' }).of(voice.language) || '其他语言' } catch { label = '其他语言' }
  }
  return `${label} · ${kind}`
}

export function voiceArtworkVariant(id: string): number {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return hash % 2
}
