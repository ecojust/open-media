import type { Clip, SubtitleStyle, Track } from './types.ts'

export const SUBTITLE_STYLE_KEYS = [
  'x', 'y', 'width', 'height', 'rotation', 'opacity', 'fadeIn', 'fadeOut',
  'fontSize', 'fontFamily', 'fontWeight', 'color', 'background', 'textAlign', 'textVerticalAlign',
] as const satisfies readonly (keyof SubtitleStyle)[]

export function isSubtitleClip(track: Track, clip: Clip): boolean {
  return track.kind === 'text' && (clip.textRole ? clip.textRole === 'subtitle' : track.name !== '文字水印轨道')
}

export function subtitleStyleFromClip(clip: Clip): SubtitleStyle {
  return {
    x: clip.x, y: clip.y, width: clip.width, height: clip.height,
    rotation: clip.rotation, opacity: clip.opacity, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut,
    fontSize: clip.fontSize ?? 64, fontFamily: clip.fontFamily ?? 'sans-serif', fontWeight: clip.fontWeight ?? 600,
    color: clip.color ?? '#ffffff', background: clip.background ?? 'transparent', textAlign: clip.textAlign ?? 'center',
    textVerticalAlign: clip.textVerticalAlign ?? 'middle',
  }
}
