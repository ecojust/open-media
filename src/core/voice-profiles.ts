import type { VoiceCategoryId, VoiceStyleId } from './voice-catalog'

export interface VoiceProfile {
  category: VoiceCategoryId
  speakerId: number
  style: VoiceStyleId
}

// The source model describes this single bilingual voice as gentle female speech.
export const VOICE_PROFILE_SOURCE = {
  archiveSha256: '271b804af570400d3bcdcb53bf6e53cc9f75180ee763b9f13eb5eaf2b0d086ef',
  modelSha256: '524286bf6cf11be74329ae1c682ac69e34d6860c2ea9fd1290319d561540b16a',
  vocoderSha256: 'b599142a1fb8ff03de3e84ac35ff537c619e56f4267a6fe894851a42844acf9e',
  modelCard: 'https://modelscope.cn/models/dengcunqin/matcha_tts_zh_en_20251010/summary',
  sampleRate: 16000,
  silenceScale: 0.2,
} as const

export const VOICE_PROFILES: Readonly<Record<string, VoiceProfile>> = {
  matcha_zh_en_female: { category: 'zh-en-female', speakerId: 0, style: 'gentle' },
}
