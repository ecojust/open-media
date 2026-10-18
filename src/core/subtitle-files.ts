import { cloneProject, createSubtitleClip, createTrack, validateProject } from './project.ts'
import { clipEnd } from './timeline.ts'
import type { Project } from './types.ts'

export type SubtitleFormat = 'srt' | 'vtt' | 'ass'
export interface SubtitleCue { start: number; end: number; text: string }
export interface SubtitleFileOptions { maxLineChars?: number; splitSentences?: boolean; offset?: number }
function timestamp(value: string): number {
  const match = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/)
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) throw new Error(`字幕时间格式无效：${value}`)
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]!.padEnd(3, '0')) / 1000
}
function formatTime(time: number, format: SubtitleFormat): string {
  const base = format === 'ass' ? 100 : 1000
  const ticks = Math.round(time * base), seconds = Math.floor(ticks / base)
  return `${Math.floor(seconds / 3600).toString().padStart(format === 'ass' ? 1 : 2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}${format === 'srt' ? ',' : '.'}${(ticks % base).toString().padStart(format === 'ass' ? 2 : 3, '0')}`
}
function assText(value: string): string {
  let output = ''
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!, next = value[index + 1]
    if (char === '\\' && next && ['N', 'n', 'h', '\\', '{', '}'].includes(next)) {
      output += next === 'N' || next === 'n' ? '\n' : next === 'h' ? ' ' : next
      index++
    } else if (char === '{') {
      const close = value.indexOf('}', index + 1)
      if (close >= 0) index = close
      else output += char
    } else output += char
  }
  return output
}
function normalize(cues: SubtitleCue[], options: SubtitleFileOptions): SubtitleCue[] {
  const offset = options.offset ?? 0, width = options.maxLineChars ?? 0
  if (!Number.isFinite(offset) || Math.abs(offset) > 86400 || width && (!Number.isInteger(width) || width < 4 || width > 80)) throw new Error('字幕偏移或换行长度无效。')
  const output: SubtitleCue[] = []
  for (const cue of cues) {
    const start = cue.start + offset, end = cue.end + offset
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 86400 || end - start < .001) throw new Error('字幕时间必须在 24 小时内，结束应晚于开始。')
    const raw = cue.text.replace(/\r/g, '').trim()
    if (!raw) continue
    const sentences = options.splitSentences ? raw.match(/[^。！？.!?\n]+[。！？.!?]*|[。！？.!?]+/gu)?.map(value => value.trim()).filter(Boolean) || [raw] : [raw]
    const lengths = sentences.map(value => Math.max(1, [...value].length)), total = lengths.reduce((sum, value) => sum + value, 0)
    let used = 0
    sentences.forEach((text, index) => {
      const from = start + (end - start) * used / total
      used += lengths[index]!
      const to = index === sentences.length - 1 ? end : start + (end - start) * used / total
      const wrapped = width ? text.split('\n').flatMap(line => { const chars = [...line], lines: string[] = []; for (let i = 0; i < chars.length; i += width) lines.push(chars.slice(i, i + width).join('')); return lines }).join('\n') : text
      if (to - from < .001) throw new Error('分句后的字幕过短，请关闭分句或延长原字幕。')
      output.push({ start: from, end: to, text: wrapped })
    })
  }
  if (output.length > 10000) throw new Error('单次字幕最多支持 10000 段。')
  return output.sort((a, b) => a.start - b.start)
}
export function parseSubtitleFile(text: string, format: SubtitleFormat, options: SubtitleFileOptions = {}): SubtitleCue[] {
  if (typeof text !== 'string' || text.length > 2_000_000 || text.includes('\0')) throw new Error('字幕文件为空、过大或包含无效字符。')
  if (!['srt', 'vtt', 'ass'].includes(format)) throw new Error('不支持这个字幕格式。')
  const cues: SubtitleCue[] = [], lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  if (format === 'ass') {
    let events = false, columns = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
    for (const line of lines) {
      if (/^\[/.test(line.trim())) { events = /^\[events\]$/i.test(line.trim()); continue }
      if (!events) continue
      if (/^Format:/i.test(line)) { columns = line.replace(/^Format:/i, '').split(',').map(value => value.trim().toLowerCase()); continue }
      if (!/^Dialogue:/i.test(line)) continue
      if (columns.at(-1) !== 'text' || !columns.includes('start') || !columns.includes('end')) throw new Error('字幕事件格式需要 Start、End，且 Text 必须为最后一列。')
      const fields = line.replace(/^Dialogue:\s*/i, '').split(',')
      if (fields.length < columns.length) throw new Error('字幕事件字段不完整。')
      const content = assText(fields.slice(columns.length - 1).join(','))
      cues.push({ start: timestamp(fields[columns.indexOf('start')]!), end: timestamp(fields[columns.indexOf('end')]!), text: content })
    }
  } else {
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!.trim()
      if (/^(NOTE|STYLE|REGION)(\s|$)/.test(line)) { while (index < lines.length && lines[index]!.trim()) index++; continue }
      if (!line.includes('-->')) continue
      const match = line.match(/^(\S+)\s+-->\s+(\S+)/)
      if (!match) throw new Error('字幕时间范围格式无效。')
      const content: string[] = []
      while (index + 1 < lines.length && lines[index + 1]!.trim()) content.push(lines[++index]!)
      cues.push({ start: timestamp(match[1]!), end: timestamp(match[2]!), text: content.join('\n').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') })
    }
  }
  if (!cues.length) throw new Error('未找到有效字幕时间和文字。')
  const result = normalize(cues, options)
  if (!result.length) throw new Error('字幕文件没有可用文字。')
  return result
}
export function importSubtitles(project: Project, text: string, format: SubtitleFormat, options: SubtitleFileOptions & { trackId?: string } = {}) {
  return importSubtitleCues(project, parseSubtitleFile(text, format, options), { trackId: options.trackId }, options.splitSentences)
}
export function importSubtitleCues(project: Project, input: SubtitleCue[], options: SubtitleFileOptions & { trackId?: string } = {}, proportionallySplit = false) {
  const cues = normalize(input, options), copy = cloneProject(project)
  if (!cues.length) throw new Error('没有可导入的字幕文字。')
  let track = options.trackId ? copy.tracks.find(item => item.id === options.trackId) : undefined
  if (options.trackId && (!track || track.kind !== 'text')) throw new Error('请选择有效的字幕轨道。')
  if (track?.locked) throw new Error('字幕轨道已锁定。')
  if (!track) { track = createTrack('text', '导入字幕'); copy.tracks.unshift(track) }
  const clipIds: string[] = []
  for (const cue of cues) { const clip = createSubtitleClip(copy, { text: cue.text, name: cue.text.slice(0, 100), start: cue.start, trimOut: cue.end - cue.start }); track.clips.push(clip); clipIds.push(clip.id) }
  copy.updatedAt = new Date().toISOString()
  return { project: validateProject(copy, { trusted: true }), label: `已导入 ${cues.length} 段字幕`, selection: { trackId: track.id, clipId: clipIds[0]! }, data: { count: cues.length, clipIds, splitTiming: (options.splitSentences || proportionallySplit) ? '按文字比例分配原字幕时长，非识别时间戳' : undefined } }
}
export function exportSubtitles(project: Project, format: SubtitleFormat, options: SubtitleFileOptions & { trackId?: string } = {}) {
  if (!['srt', 'vtt', 'ass'].includes(format)) throw new Error('不支持这个字幕格式。')
  const tracks = project.tracks.filter(track => track.kind === 'text' && (!options.trackId || track.id === options.trackId))
  if (options.trackId && !tracks.length) throw new Error('字幕轨道不存在。')
  const cues = normalize(tracks.flatMap(track => track.clips.filter(clip => clip.textRole !== 'watermark').map(clip => ({ start: clip.start, end: clipEnd(clip), text: clip.text || '' }))), options)
  if (!cues.length) throw new Error('没有可以导出的字幕。')
  const escape = (text: string) => format === 'ass' ? text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N') : text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  let text: string
  if (format === 'ass') text = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${project.width}\nPlayResY: ${project.height}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,20,20,20,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` + cues.map(cue => `Dialogue: 0,${formatTime(cue.start, format)},${formatTime(cue.end, format)},Default,,0,0,0,,${escape(cue.text)}`).join('\n') + '\n'
  else text = (format === 'vtt' ? 'WEBVTT\n\n' : '') + cues.map((cue, index) => `${index + 1}\n${formatTime(cue.start, format)} --> ${formatTime(cue.end, format)}\n${escape(cue.text)}\n`).join('\n')
  return { filename: `${project.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || '字幕'}.${format}`, text, mime: format === 'vtt' ? 'text/vtt' : 'text/plain', count: cues.length }
}
