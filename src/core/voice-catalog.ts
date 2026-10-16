import type { SpeechVoice } from '../native'
import { VOICE_PROFILES } from './voice-profiles.ts'
import { VOICE_GROUPS } from './voice-groups.ts'

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

/** Keep one available representative per bundled group, preserving an existing selection. */
export function compactVoiceCatalog(voices: readonly SpeechVoice[], selectedId = ''): SpeechVoice[] {
  const unique = [...new Map(voices.map(voice => [voice.id, voice])).values()]
  const grouped = new Set<string>(), retained = new Set<string>()
  for (const group of VOICE_GROUPS) {
    const candidates = unique.filter(voice => group.members.includes(voice.id)
      && voiceCategory(voice) === group.category && language(voice) === group.locale)
    for (const voice of candidates) grouped.add(voice.id)
    const representative = candidates.find(voice => voice.id === selectedId)
      || candidates.find(voice => voice.id === group.representative)
      || group.members.map(id => candidates.find(voice => voice.id === id)).find(Boolean)
    if (representative) retained.add(representative.id)
  }
  return unique.filter(voice => !grouped.has(voice.id) || retained.has(voice.id))
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

export type VoiceStyleId = 'natural' | 'deep' | 'bright' | 'relaxed' | 'mature'

export interface VoiceStyle {
  id: VoiceStyleId
  label: string
  portrait: number
}

export function voiceStyle(voice: SpeechVoice): VoiceStyle {
  const category = voiceCategory(voice)
  const profile = VOICE_PROFILES[voice.id]
  const id = profile && profile.category === category ? profile.style : 'natural'
  if (category === 'zh-male') {
    if (id === 'deep') return { id, label: '低沉', portrait: 1 }
    if (id === 'bright') return { id, label: '明亮', portrait: 2 }
    if (id === 'relaxed') return { id, label: '舒缓', portrait: 3 }
    return { id: 'natural', label: '自然', portrait: 0 }
  }
  if (category === 'zh-female') {
    if (id === 'bright') return { id, label: '清亮', portrait: 5 }
    if (id === 'deep') return { id, label: '低沉', portrait: 6 }
    if (id === 'relaxed') return { id, label: '舒缓', portrait: 7 }
    return { id: 'natural', label: '自然', portrait: 4 }
  }
  if (category === 'en-female') {
    if (id === 'bright') return { id, label: '明亮', portrait: 9 }
    if (id === 'mature') return { id, label: '成熟', portrait: 10 }
    return { id: 'natural', label: '自然', portrait: 8 }
  }
  return { id: 'natural', label: '通用', portrait: 11 }
}

export function voiceSearchText(voice: SpeechVoice): string {
  return `${voice.name} ${voiceTypeLabel(voice)} ${voiceStyle(voice).label} ${voice.id}`.toLocaleLowerCase()
}
