const files = import.meta.glob<string>('../assets/voice-previews/*.mp3', { eager: true, query: '?url', import: 'default' })

export const VOICE_PREVIEW_TEXT = {
  zh: '欢迎使用 Open Media。你可以录制屏幕、剪辑视频、编辑图片，还能生成配音，让创作更轻松。',
  en: '欢迎使用 Open Media。你可以录制屏幕、剪辑视频、编辑图片，还能生成配音，让创作更轻松。',
} as const

/** Each bundled sample belongs to its exact model voice; never substitute a similar voice. */
export function bundledVoicePreviewUrl(voiceId: string): string | undefined {
  return /^[a-z0-9_-]+$/i.test(voiceId) ? files[`../assets/voice-previews/${voiceId}.mp3`] : undefined
}
