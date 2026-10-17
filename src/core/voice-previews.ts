const files = import.meta.glob<string>('../assets/voice-previews/*.mp3', { eager: true, query: '?url', import: 'default' })

export const VOICE_PREVIEW_TEXT = {
  zh: '你好，这是一段语音试听。让文字拥有清晰自然的声音。',
  en: 'Hello, this is a voice preview. Let your story come to life with a clear and natural voice.',
} as const

/** Each bundled sample belongs to its exact model voice; never substitute a similar voice. */
export function bundledVoicePreviewUrl(voiceId: string): string | undefined {
  return /^[a-z0-9_-]+$/i.test(voiceId) ? files[`../assets/voice-previews/${voiceId}.mp3`] : undefined
}
