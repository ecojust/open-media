import type { Clip, Track } from './types.ts'
import { isSubtitleClip } from './subtitle-style.ts'

export const DEFAULT_SUBTITLE_TEXT = '在这里输入字幕'
const placeholderTexts = new Set([DEFAULT_SUBTITLE_TEXT, '双击编辑字幕'])

export interface SubtitleIssue {
  clipId: string
  reason: 'empty' | 'placeholder'
  message: string
}

export function subtitleIssue(track: Track, clip: Clip): SubtitleIssue | undefined {
  if (!isSubtitleClip(track, clip)) return undefined
  const text = (clip.text ?? '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim()
  if (!text) return { clipId: clip.id, reason: 'empty', message: '字幕内容为空' }
  if (placeholderTexts.has(text)) return { clipId: clip.id, reason: 'placeholder', message: '字幕仍为默认文字' }
  return undefined
}

export function trackSubtitleIssues(track: Track): SubtitleIssue[] {
  return [...track.clips].sort((a, b) => a.start - b.start).flatMap(clip => {
    const issue = subtitleIssue(track, clip)
    return issue ? [issue] : []
  })
}
