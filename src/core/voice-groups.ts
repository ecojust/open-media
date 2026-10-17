import type { VoiceCategoryId } from './voice-catalog'

export interface VoiceGroup {
  category: VoiceCategoryId
  locale: string
  representative: string
  members: readonly string[]
}

// One bundled speaker; speed changes do not create additional voices.
export const VOICE_GROUPS: readonly VoiceGroup[] = [
  { category: 'zh-en-female', locale: 'zh-cn', representative: 'matcha_zh_en_female', members: ['matcha_zh_en_female'] },
]
