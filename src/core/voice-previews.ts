const files = import.meta.glob<string>('../assets/voice-previews/*.mp3', { eager: true, query: '?url', import: 'default' })

export const VOICE_PREVIEW_TEXT = {
  zh: '这是一款全程由AI接管并生成的软件',
  en: '这是一款全程由AI接管并生成的软件',
} as const

/** Each bundled sample belongs to its exact model voice; never substitute a similar voice. */
export function bundledVoicePreviewUrl(voiceId: string): string | undefined {
  return /^[a-z0-9_-]+$/i.test(voiceId) ? files[`../assets/voice-previews/${voiceId}.mp3`] : undefined
}
