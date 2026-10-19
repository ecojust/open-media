import type { Clip, ClipKeyframe, Project, Track } from './types.ts'
import type { EditorToolContext, PreparedEditorTool } from './editor-tool-service.ts'
import { cloneProject, validateProject } from './project.ts'
import { clipDuration, clipEnd, findClip } from './timeline.ts'

export interface AudioBalanceOptions {
  speechTrackIds: string[]
  musicTrackIds?: string[]
  normalize?: boolean
  ducking?: boolean
  targetLufs?: number
  truePeak?: number
  reductionDb?: number
  attack?: number
  release?: number
}
export interface AudioBalanceMeasurement {
  clipId: string; name: string; beforeLufs: number; estimatedLufs: number; estimatedPeak: number; volume: number; limited: boolean
}
interface Interval { start: number; end: number }
function numeric(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  const result = value ?? fallback
  if (typeof result !== 'number' || !Number.isFinite(result) || result < min || result > max) throw new Error(`${label}应在 ${min} 到 ${max} 之间。`)
  return result
}
function selectedTracks(project: Project, ids: string[], label: string): Track[] {
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error(`${label}轨道列表无效。`)
  return ids.map(id => {
    const track = project.tracks.find(track => track.id === id && track.kind === 'audio')
    if (!track) throw new Error(`${label}轨道不存在或不是音频轨道。`)
    if (track.muted) throw new Error(`“${track.name}”已静音，请先取消静音或移出选择。`)
    return track
  })
}
export function ownsDuckingKeyframes(clip: Clip): boolean {
  const frames = clip.keyframes?.volume, saved = clip.audioBalance?.ducking.keyframes
  return Boolean(frames?.length && saved && frames.length === saved.length && frames.every((frame, index) => {
    const original = saved[index]!
    return frame.time === original.time && frame.value === original.value && (frame.easing ?? 'linear') === (original.easing ?? 'linear')
  }))
}
/** Short gaps stay quiet so music does not surge between consecutive spoken sentences. */
export function musicDuckingKeyframes(clip: Clip, intervals: Interval[], reductionDb = 12, attack = .15, release = .6): ClipKeyframe[] {
  const duration = clipDuration(clip), offset = clip.animationOffset ?? 0, base = clip.volume
  const merged: Interval[] = []
  for (const range of intervals.map(range => ({ start: Math.max(0, range.start), end: Math.min(duration, range.end) })).filter(range => range.end > range.start).sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1)
    if (previous && range.start - previous.end <= attack + release) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  if (!merged.length || reductionDb === 0) return []
  const points = new Map<number, number>(), low = base * 10 ** (-reductionDb / 20)
  points.set(0, base); points.set(duration, base)
  for (const range of merged) {
    points.set(Math.max(0, range.start - attack), base)
    points.set(range.start, low); points.set(range.end, low)
    if (range.end < duration) points.set(Math.min(duration, range.end + release), low + (base - low) * Math.min(1, (duration - range.end) / release))
  }
  const frames = [...points].sort(([a], [b]) => a - b).map(([time, value]): ClipKeyframe => ({ time: time + offset, value, easing: 'linear' }))
  // Remove redundant points without approximating the envelope.
  for (let index = frames.length - 2; index > 0; index--) {
    const a = frames[index - 1]!, b = frames[index]!, c = frames[index + 1]!
    if (Math.abs((b.value - a.value) * (c.time - b.time) - (c.value - b.value) * (b.time - a.time)) < 1e-10) frames.splice(index, 1)
  }
  if (frames.length > 128) throw new Error(`“${clip.name}”的人声区间过多，请先分割该音乐片段，再应用自动压低。`)
  return frames
}
export async function prepareAudioBalance(
  project: Project,
  options: AudioBalanceOptions,
  context: EditorToolContext,
  analyze: (clipId: string, context: EditorToolContext) => Promise<PreparedEditorTool>,
): Promise<PreparedEditorTool> {
  context.signal.throwIfAborted()
  const normalize = options.normalize ?? true, ducking = options.ducking ?? true
  if (typeof normalize !== 'boolean' || typeof ducking !== 'boolean' || !normalize && !ducking) throw new Error('请启用统一旁白响度或自动降低音乐。')
  const targetLufs = numeric(options.targetLufs, -16, -36, -5, '目标响度'), truePeak = numeric(options.truePeak, -1, -9, 0, '真峰值上限')
  const reduction = numeric(options.reductionDb, 12, 0, 36, '音乐压低幅度'), attack = numeric(options.attack, .15, .01, 5, '进入时间'), release = numeric(options.release, .6, .01, 5, '恢复时间')
  const speechTracks = selectedTracks(project, options.speechTrackIds, '人声'), musicTracks = selectedTracks(project, options.musicTrackIds ?? [], '音乐')
  if (!speechTracks.length) throw new Error('请至少选择一个人声轨道。')
  if (ducking && !musicTracks.length) throw new Error('请至少选择一个背景音乐轨道。')
  if (musicTracks.some(track => speechTracks.includes(track))) throw new Error('人声和背景音乐不能选择同一轨道。')
  for (const track of [...(normalize ? speechTracks : []), ...(ducking ? musicTracks : [])]) if (track.locked) throw new Error(`“${track.name}”已锁定，请先解锁或移出选择。`)
  const skipped: { clipId: string; name: string; reason: string }[] = [], speech = speechTracks.flatMap(track => track.clips).filter(clip => clip.volume > 0 || clip.keyframes?.volume?.some(frame => frame.value > 0))
  if (!speech.length) throw new Error('所选人声轨道没有可听的音频片段。')
  for (const clip of speech) {
    if (normalize && (clip.speedRamp || clip.keyframes?.volume?.length)) throw new Error(`“${clip.name}”包含变速或音量关键帧，请取消统一响度或先处理该片段。`)
    if (!project.assets.some(asset => asset.id === clip.assetId && asset.kind === 'audio')) throw new Error(`“${clip.name}”缺少音频素材，请重新导入。`)
  }
  const music = ducking ? musicTracks.flatMap(track => track.clips) : []
  const envelopes = new Map<string, ClipKeyframe[]>()
  for (const clip of music) {
    if (clip.keyframes?.volume?.length && !ownsDuckingKeyframes(clip)) throw new Error(`“${clip.name}”已有手动音量关键帧，未覆盖；请移出选择或先清除这些关键帧。`)
    const intervals = speech.map(voice => ({ start: voice.start - clip.start, end: clipEnd(voice) - clip.start }))
    envelopes.set(clip.id, musicDuckingKeyframes(clip, intervals, reduction, attack, release))
  }
  const copy = cloneProject(project), measurements: AudioBalanceMeasurement[] = []
  const total = (normalize ? speech.length : 0) + music.length
  let done = 0, normalizedCount = 0, duckedCount = 0, restoredCount = 0
  if (normalize) for (const clip of speech) {
    context.signal.throwIfAborted()
    const prepared = await analyze(clip.id, { ...context, onProgress: update => context.onProgress({ ...update, stage: `人声 ${done + 1}/${speech.length} · ${clip.name} · ${update.stage}`, progress: (done + (update.progress ?? 0)) / Math.max(1, total) }) })
    try {
      context.signal.throwIfAborted()
      const data = prepared.data as Record<string, unknown>, loudness = data.integratedLufs, peak = data.truePeakDbtp
      if (data.silent === true) skipped.push({ clipId: clip.id, name: clip.name, reason: '静音片段，保持原音量' })
      else {
        if (typeof loudness !== 'number' || !Number.isFinite(loudness) || typeof peak !== 'number' || !Number.isFinite(peak)) throw new Error(`“${clip.name}”没有有效的响度及真峰值测量，未修改项目。`)
        const gainDb = Math.min(targetLufs - loudness, truePeak - peak, 20 * Math.log10(2 / clip.volume))
        const volume = Math.min(2, clip.volume * 10 ** (gainDb / 20))
        const target = findClip(copy, clip.id)!.clip
        target.volume = volume
        if (Math.abs(volume - clip.volume) > 1e-8) normalizedCount++
        measurements.push({ clipId: clip.id, name: clip.name, beforeLufs: loudness, estimatedLufs: loudness + gainDb, estimatedPeak: peak + gainDb, volume, limited: loudness + gainDb < targetLufs - .2 })
      }
      await prepared.accept?.()
    } catch (error) { await prepared.discard?.(); throw error }
    done++
  }
  for (const clip of music) {
    context.signal.throwIfAborted()
    const target = findClip(copy, clip.id)!.clip, frames = envelopes.get(clip.id)!
    if (frames.length) {
      target.keyframes = { ...target.keyframes, volume: frames }
      target.audioBalance = { ducking: { keyframes: frames.map(frame => ({ ...frame })) } }
      duckedCount++
    } else if (ownsDuckingKeyframes(clip)) {
      delete target.keyframes!.volume; if (!Object.keys(target.keyframes!).length) delete target.keyframes
      delete target.audioBalance; restoredCount++
    } else skipped.push({ clipId: clip.id, name: clip.name, reason: '没有重叠人声或压低幅度为零，保持原音量' })
    done++; context.onProgress({ stage: `正在准备音乐音量曲线 ${done}/${total}`, progress: done / Math.max(1, total) })
  }
  context.signal.throwIfAborted()
  copy.updatedAt = new Date().toISOString()
  return { project: validateProject(copy, { trusted: true }), label: '统一旁白与背景音乐', data: { normalizedCount, duckedCount, restoredCount, measurements, skipped, limitedCount: measurements.filter(item => item.limited).length, nonDestructive: true, note: '响度按片段音量后、淡入淡出前测量；预计响度采用线性增益计算。真峰值上限与 200% 音量上限可能限制目标响度。音乐依据人声片段区间压低，短停顿保持压低，不检测片段内部的呼吸与停顿。' } }
}
