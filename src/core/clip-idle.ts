import { cloneProject, MAX_CLIPS, validateProject } from './project.ts'
import { clipDuration, clipEnd, findClip, splitClipAtTimes, updateClip } from './timeline.ts'
import { rhythmTimelineTime } from './rhythm-assist.ts'
import { speedSegments } from './visual-animation.ts'
import type { EditorToolContext, PreparedEditorTool } from './editor-tool-service.ts'
import type { Clip, Project } from './types.ts'

export const REPEAT_CLIP_COLOR = '#e0b12e'
export interface IdleSplitOptions { clipId: string; minDuration?: number; freezeNoiseDb?: number }
export interface IdleSourceInterval { start: number; end: number; confidence?: number }
export interface IdleSplitSegment { clipId: string; start: number; end: number; sourceStart: number; sourceEnd: number; classification?: 'repeat'; detected: boolean }
export interface IdleSplitReport {
  clipId: string
  trackId: string
  minDuration: number
  freezeNoiseDb: number
  sourceIntervals: IdleSourceInterval[]
  segments: IdleSplitSegment[]
  repeatCount: number
  splitCount: number
  repeatDuration: number
}
const EPSILON = 1e-6
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function selectedVideo(project: Project, clipId: string, detect: boolean) {
  const selected = findClip(project, clipId)
  if (!selected) throw new Error('视频片段不存在，请重新选择。')
  const asset = project.assets.find(asset => asset.id === selected.clip.assetId)
  if (selected.track.kind !== 'video' || asset?.kind !== 'video') throw new Error('请选择视频轨道中的视频片段。')
  if (selected.track.locked) throw new Error('请先解锁此视频轨道。')
  if (detect && selected.clip.freezeFrame) throw new Error('主动定格片段不需要静止检测，可直接标记为 repeat。')
  return { ...selected, asset }
}
function optionsFor(options: IdleSplitOptions) {
  const minDuration = options.minDuration ?? 3, freezeNoiseDb = options.freezeNoiseDb ?? -60
  if (!finite(minDuration) || minDuration < .5 || minDuration > 3600) throw new Error('静止画面的最短持续时长需要在 0.5–3600 秒之间。')
  if (!finite(freezeNoiseDb) || freezeNoiseDb < -100 || freezeNoiseDb > -20) throw new Error('画面变化阈值需要在 -100 至 -20 dB 之间。')
  return { minDuration, freezeNoiseDb }
}

/** Ordinary classification is represented by omission, keeping old projects unchanged. */
export function classifyVideoClip(project: Project, clipId: string, classification: 'repeat' | 'normal'): PreparedEditorTool {
  const { clip, track } = selectedVideo(project, clipId, false)
  if (!['repeat', 'normal'].includes(classification)) throw new Error('片段类型无效。')
  const next = classification === 'repeat' ? 'repeat' : undefined
  return { project: clip.classification === next ? project : updateClip(project, clipId, { classification: next }),
    label: next ? '标记 repeat 片段' : '恢复普通片段', selection: { trackId: track.id, clipId },
    data: { clipId, trackId: track.id, classification, ...(next ? { color: REPEAT_CLIP_COLOR } : {}) } }
}

function detectedIntervals(value: unknown, clip: Clip, minimum: number): IdleSourceInterval[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { intervals?: unknown }).intervals)) throw new Error('静止检测未返回有效区间，请重新检测。')
  const intervals = (value as { intervals: unknown[] }).intervals.flatMap(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('静止检测区间格式无效。')
    const item = raw as { kind?: unknown; start?: unknown; end?: unknown; confidence?: unknown }
    if (item.kind !== 'freeze') return []
    if (!finite(item.start) || !finite(item.end) || item.start < 0 || item.end <= item.start) throw new Error('静止检测区间时间无效。')
    const start = Math.max(clip.trimIn, item.start), end = Math.min(clip.trimOut, item.end)
    return end > start + EPSILON ? [{ start, end, ...(finite(item.confidence) ? { confidence: Math.max(0, Math.min(1, item.confidence)) } : {}) }] : []
  }).sort((left, right) => left.start - right.start)
  const merged: IdleSourceInterval[] = []
  for (const item of intervals) {
    const previous = merged.at(-1)
    if (previous && item.start <= previous.end + EPSILON) {
      previous.end = Math.max(previous.end, item.end)
      if (item.confidence !== undefined) previous.confidence = Math.min(previous.confidence ?? 1, item.confidence)
    } else merged.push({ ...item })
  }
  // Minimum refers to what the editor plays, even for trimmed or speed-ramped clips.
  return merged.filter(item => rhythmTimelineTime(clip, item.end) - rhythmTimelineTime(clip, item.start) >= minimum - EPSILON)
}

/** Detector output is applied as one reversible edit; no source bytes or other tracks are changed. */
export function splitIdleVideoClip(project: Project, options: IdleSplitOptions, detection: unknown): PreparedEditorTool & { data: IdleSplitReport } {
  const { clip, track } = selectedVideo(project, options.clipId, true), settings = optionsFor(options)
  const sourceIntervals = detectedIntervals(detection, clip, settings.minDuration)
  const intervals = sourceIntervals.map(item => ({ start: rhythmTimelineTime(clip, item.start), end: rhythmTimelineTime(clip, item.end) }))
  const end = clipEnd(clip), minimumPart = .001
  const edge = (value: number) => value - clip.start < minimumPart + EPSILON ? clip.start : end - value < minimumPart + EPSILON ? end : value
  const times = [...new Set(intervals.flatMap(item => [edge(item.start), edge(item.end)]))].filter(time => time > clip.start + EPSILON && time < end - EPSILON).sort((left, right) => left - right)
  if (times.some((time, index) => index && time - times[index - 1]! < minimumPart - EPSILON)) throw new Error('检测到的切点间隔过短，请提高最短持续时长后重试。')
  if (project.tracks.reduce((count, track) => count + track.clips.length, 0) + times.length > MAX_CLIPS) throw new Error('分割后片段数量超过工程上限，请缩小检测范围。')
  // A cut inside a fade would restart its envelope. Do not silently alter the visual/audio result.
  if (times.some(time => time < clip.start + clip.fadeIn - EPSILON || time > end - clip.fadeOut + EPSILON)) throw new Error('静止区间切点位于已有淡入淡出范围内，请先缩短淡入淡出或手动分割。')
  let next = sourceIntervals.length ? splitClipAtTimes(project, clip.id, times) : project
  if (sourceIntervals.length) {
    next = next === project ? cloneProject(project) : next
    // Rebinding the last segment is expected, but shortening or dropping an existing transition is not.
    for (const oldTrack of project.tracks.filter(item => item.kind === 'transition')) for (const old of oldTrack.clips) {
      if (old.transition?.fromClipId !== clip.id && old.transition?.toClipId !== clip.id) continue
      const current = findClip(next, old.id)?.clip
      if (!current || Math.abs(current.start - old.start) > EPSILON || Math.abs(clipDuration(current) - clipDuration(old)) > EPSILON) throw new Error('静止区间切点会缩短已有转场，请先缩短该转场或手动分割。')
    }
  }
  const beforeIds = new Set(track.clips.map(item => item.id))
  const pieces = next.tracks.find(item => item.id === track.id)!.clips.filter(item => item.id === clip.id || !beforeIds.has(item.id)).sort((left, right) => left.start - right.start)
  const segments: IdleSplitSegment[] = pieces.map(piece => {
    const detected = intervals.some(item => piece.start >= edge(item.start) - EPSILON && clipEnd(piece) <= edge(item.end) + EPSILON)
    if (detected && sourceIntervals.length) piece.classification = 'repeat'
    return { clipId: piece.id, start: piece.start, end: clipEnd(piece), sourceStart: piece.trimIn, sourceEnd: piece.trimOut, ...(piece.classification ? { classification: piece.classification } : {}), detected }
  })
  const repeated = segments.filter(item => item.detected)
  const data: IdleSplitReport = { clipId: clip.id, trackId: track.id, ...settings, sourceIntervals, segments, repeatCount: repeated.length, splitCount: times.length, repeatDuration: repeated.reduce((sum, item) => sum + item.end - item.start, 0) }
  if (sourceIntervals.length) {
    next.updatedAt = new Date().toISOString()
    next = validateProject(next, { trusted: true })
  }
  return { ...(sourceIntervals.length ? { project: next } : {}), data, label: '分割静止画面并标记 repeat', selection: { trackId: track.id, clipId: repeated[0]?.clipId ?? clip.id } }
}

export async function prepareIdleSplit(args: Record<string, unknown>, context: EditorToolContext): Promise<PreparedEditorTool> {
  const options = { clipId: args.clipId as string, minDuration: args.minDuration as number | undefined, freezeNoiseDb: args.freezeNoiseDb as number | undefined }
  const { clip, asset } = selectedVideo(context.project, options.clipId, true), settings = optionsFor(options)
  context.signal.throwIfAborted()
  const minimumSpeed = Math.min(...speedSegments(clip).map(segment => segment.speed))
  const { runAssetTool } = await import('../native-asset-tools.ts')
  context.onProgress({ stage: '正在检测片段中的长时间静止画面', progress: 0 })
  const result = await runAssetTool('asset_detect_idle', { asset, start: clip.trimIn, end: clip.trimOut, freezeOnly: true,
    minDuration: Math.max(.05, Math.min(3600, settings.minDuration * minimumSpeed)), freezeNoiseDb: settings.freezeNoiseDb },
  { signal: context.signal, onProgress: progress => context.onProgress({ stage: progress.stage, progress: progress.progress === undefined ? undefined : progress.progress * .9 }) })
  context.signal.throwIfAborted()
  context.assertCurrent?.()
  context.onProgress({ stage: '正在分割静止区间并标记 repeat', progress: .95 })
  const prepared = splitIdleVideoClip(context.project, options, result)
  context.signal.throwIfAborted()
  return prepared
}
