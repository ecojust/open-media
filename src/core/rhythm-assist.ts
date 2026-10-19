import { cloneProject, newId, validateProject } from './project.ts'
import { clipEnd } from './timeline.ts'
import { speedSegments } from './visual-animation.ts'
import type { Clip, MediaAsset, Project, Track } from './types.ts'
import type { EditorToolRunner, EditorToolRunOptions } from './editor-tool-service.ts'

export type RhythmKind = 'black' | 'freeze' | 'silence' | 'repeat'
export type RhythmScope = 'selected' | 'project'
export interface RhythmEvidence { kind: RhythmKind; confidence: number; description: string }
export interface RhythmCandidate {
  id: string
  clipId: string
  clipName: string
  trackName: string
  start: number
  end: number
  sourceStart: number
  sourceEnd: number
  evidence: RhythmEvidence[]
  context: string[]
}
export interface RhythmReport {
  signature: string
  candidates: RhythmCandidate[]
  assetCount: number
  clipCount: number
  noAudioAssets: string[]
  errors: string[]
  repetitionLimited: boolean
}
export interface RhythmOptions { scope: RhythmScope; selectedClipId?: string; minimum: number; noiseDb: number }
interface VideoEntry { track: Track; clip: Clip; asset: MediaAsset }
interface SourceInterval { kind: RhythmKind; start: number; end: number; confidence: number; description: string }

export const RHYTHM_LABELS: Record<RhythmKind, string> = { black: '黑场', freeze: '近静止', silence: '静音', repeat: '相似画面' }
const EPSILON = 1e-7

/** Keep analysis valid across navigation and marker edits, but never across changed timing or media. */
export function rhythmSignature(project: Project): string {
  return JSON.stringify([project.id, project.fps,
    project.assets.map(asset => [asset.id, asset.name, asset.kind, asset.duration, asset.nativePath, asset.url, asset.size, asset.addedAt]),
    project.tracks.map(track => [track.id, track.name, track.kind, track.muted, track.locked,
      track.clips.map(clip => [clip.id, clip.name, clip.assetId, clip.start, clip.trimIn, clip.trimOut, clip.speed, clip.speedRamp, clip.freezeFrame, clip.opacity, clip.keyframes?.opacity, clip.text !== undefined, Boolean(clip.speech), clip.transition])]),
  ])
}

export function rhythmVideoEntries(project: Project, scope: RhythmScope = 'project', selectedClipId?: string): VideoEntry[] {
  const assets = new Map(project.assets.filter(asset => asset.kind === 'video' && !asset.libraryRole).map(asset => [asset.id, asset]))
  return project.tracks.filter(track => track.kind === 'video' && !track.muted).flatMap(track => track.clips.flatMap(clip => {
    const asset = assets.get(clip.assetId || '')
    if (!asset || clip.freezeFrame || clip.opacity === 0 && !clip.keyframes?.opacity?.some(frame => frame.value > 0) || scope === 'selected' && clip.id !== selectedClipId) return []
    return [{ track, clip, asset }]
  }))
}

function dataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  return record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : record
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }

function readIntervals(value: unknown): SourceInterval[] {
  const data = dataRecord(value)
  const entries = [
    ...(Array.isArray(data.intervals) ? data.intervals : []),
    ...(Array.isArray(data.repeatedIntervals) ? data.repeatedIntervals.map(value => ({ ...dataRecord(value), kind: 'repeat' })) : []),
  ]
  return entries.flatMap(value => {
    const item = dataRecord(value), kind = item.kind as RhythmKind
    if (!Object.hasOwn(RHYTHM_LABELS, kind) || !finite(item.start) || !finite(item.end) || item.start < 0 || item.end <= item.start) return []
    const evidence = dataRecord(item.evidence), confidence = finite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : 0
    const description = kind === 'black' ? '至少 98% 画面低于亮度阈值' : kind === 'freeze' ? '连续画面变化低于静止检测阈值' : kind === 'silence'
      ? `源声音持续低于 ${finite(evidence.noiseDb) ? evidence.noiseDb : -45} dB`
      : `与源素材 ${finite(item.referenceStart) ? rhythmTime(item.referenceStart) : '较早位置'} 的动态画面相似`
    return [{ kind, start: item.start, end: item.end, confidence, description }]
  })
}

/** Invert the exact piecewise source-time map used by playback and native export. */
export function rhythmTimelineTime(clip: Clip, sourceTime: number): number {
  const segments = speedSegments(clip), segment = segments.find(item => sourceTime <= item.sourceEnd + EPSILON) ?? segments.at(-1)
  if (!segment) return clip.start
  return clip.start + segment.timeStart + Math.max(0, Math.min(sourceTime, segment.sourceEnd) - segment.sourceStart) / segment.speed
}

function contextAt(project: Project, target: Clip, start: number, end: number): string[] {
  const labels = new Set<string>()
  for (const track of project.tracks) for (const clip of track.clips) {
    if (clip.id === target.id || track.muted || clip.start >= end - EPSILON || clipEnd(clip) <= start + EPSILON) continue
    if (track.kind === 'text') labels.add('同期有字幕 / 标注')
    if (track.kind === 'audio') labels.add(clip.speech ? '同期有配音' : '同期有音频')
    if (track.kind === 'transition') labels.add('同期有转场')
    if (track.kind === 'video') labels.add('同期有其他画面')
  }
  return [...labels]
}

/** Split overlapping evidence at its real boundaries; a silent source never labels the whole clip frozen. */
export function rhythmCandidates(project: Project, values: ReadonlyMap<string, unknown>, options: RhythmOptions): RhythmCandidate[] {
  if (!finite(options.minimum) || options.minimum < .5 || options.minimum > 60) throw new Error('最短持续时长需要在 0.5–60 秒之间。')
  const output: RhythmCandidate[] = []
  const sourceIntervals = new Map([...values].map(([id, value]) => [id, readIntervals(value)]))
  for (const { track, clip, asset } of rhythmVideoEntries(project, options.scope, options.selectedClipId)) {
    const intervals = (sourceIntervals.get(asset.id) || []).flatMap(item => {
      const sourceStart = Math.max(item.start, clip.trimIn), sourceEnd = Math.min(item.end, clip.trimOut)
      if (sourceEnd <= sourceStart + EPSILON) return []
      const start = rhythmTimelineTime(clip, sourceStart), end = rhythmTimelineTime(clip, sourceEnd)
      // Duration qualifies the continuous detection, before overlapping evidence splits it.
      return end - start >= options.minimum - EPSILON ? [{ ...item, sourceStart, sourceEnd, start, end }] : []
    })
    const edges = intervals.flatMap((interval, index) => [{ time: interval.start, index, start: true }, { time: interval.end, index, start: false }]).sort((a, b) => a.time - b.time)
    const active = new Map<number, typeof intervals[number]>()
    const parts: { start: number; end: number; evidence: RhythmEvidence[] }[] = []
    for (let index = 0; index < edges.length;) {
      const start = edges[index]!.time
      while (index < edges.length && Math.abs(edges[index]!.time - start) < EPSILON) {
        const edge = edges[index++]!
        if (edge.start) active.set(edge.index, intervals[edge.index]!)
        else active.delete(edge.index)
      }
      const end = edges[index]?.time
      if (end === undefined || end <= start + EPSILON || !active.size) continue
      const evidence = [...new Map([...active.values()].map(item => [item.kind, { kind: item.kind, confidence: item.confidence, description: item.description }])).values()].sort((a, b) => a.kind.localeCompare(b.kind))
      const previous = parts.at(-1)
      if (previous && Math.abs(previous.end - start) < EPSILON && JSON.stringify(previous.evidence) === JSON.stringify(evidence)) previous.end = end
      else parts.push({ start, end, evidence })
    }
    for (const part of parts) {
      const segments = speedSegments(clip)
      const sourceAt = (time: number) => {
        const local = time - clip.start, segment = segments.find(item => local <= item.timeEnd + EPSILON) ?? segments.at(-1)!
        return Math.min(clip.trimOut, segment.sourceStart + Math.max(0, local - segment.timeStart) * segment.speed)
      }
      output.push({ ...part, id: `${clip.id}:${part.start.toFixed(6)}:${part.end.toFixed(6)}`, clipId: clip.id, clipName: clip.name, trackName: track.name, sourceStart: sourceAt(part.start), sourceEnd: sourceAt(part.end), context: [...(track.locked ? ['所在轨道已锁定'] : []), ...contextAt(project, clip, part.start, part.end)] })
    }
  }
  return output.sort((a, b) => a.start - b.start || a.end - b.end || a.clipId.localeCompare(b.clipId))
}

export async function analyzeRhythm(project: Project, options: RhythmOptions, run: EditorToolRunner, control: EditorToolRunOptions): Promise<RhythmReport> {
  if (!finite(options.minimum) || options.minimum < .5 || options.minimum > 60) throw new Error('最短持续时长需要在 0.5–60 秒之间。')
  if (!finite(options.noiseDb) || options.noiseDb < -80 || options.noiseDb > -10) throw new Error('静音阈值需要在 -80 至 -10 dB 之间。')
  control.signal.throwIfAborted()
  const entries = rhythmVideoEntries(project, options.scope, options.selectedClipId)
  if (!entries.length) throw new Error('请选择可见视频轨道中的普通视频片段；主动定格和内置装饰素材不参与等待检测。')
  const assets = [...new Map(entries.map(entry => [entry.asset.id, entry.asset])).values()]
  const values = new Map<string, unknown>(), errors: string[] = [], noAudioAssets: string[] = []
  let repetitionLimited = false
  for (let index = 0; index < assets.length; index++) {
    control.signal.throwIfAborted()
    const asset = assets[index]!
    let minimumSpeed = Infinity
    for (const entry of entries) if (entry.asset.id === asset.id) for (const segment of speedSegments(entry.clip)) minimumSpeed = Math.min(minimumSpeed, segment.speed)
    const minDuration = Math.max(.05, Math.min(3600, options.minimum * minimumSpeed))
    const stage = `正在分析素材 ${index + 1} / ${assets.length} · ${asset.name}`
    control.onProgress({ stage, progress: index / assets.length })
    try {
      const value = await run('open_media_asset_detect_idle', { assetId: asset.id, asset, minDuration, noiseDb: options.noiseDb }, { signal: control.signal, onProgress: update => control.onProgress({ stage: `${stage} · ${update.stage}`, progress: (index + (finite(update.progress) ? Math.max(0, Math.min(1, update.progress)) : 0)) / assets.length, cancelable: update.cancelable }) })
      control.signal.throwIfAborted()
      values.set(asset.id, value)
      const data = dataRecord(value)
      if (Array.isArray(data.detectors) && !data.detectors.includes('silence')) noAudioAssets.push(asset.name)
      if (dataRecord(data.repetitionScope).truncated === true) repetitionLimited = true
    } catch (cause) {
      control.signal.throwIfAborted()
      errors.push(`${asset.name}：${cause instanceof Error ? cause.message : String(cause)}`)
    }
    control.onProgress({ stage: `已分析 ${index + 1} / ${assets.length} 个素材`, progress: (index + 1) / assets.length })
  }
  control.signal.throwIfAborted()
  return { signature: rhythmSignature(project), candidates: rhythmCandidates(project, values, options), assetCount: assets.length, clipCount: entries.length, noAudioAssets, errors, repetitionLimited }
}

/** Union selected timeline spans, so stacked clips and overlapping detections are counted only once. */
export function rhythmSelectedDuration(candidates: readonly RhythmCandidate[]): number {
  let total = 0, until = -Infinity
  for (const item of [...candidates].sort((a, b) => a.start - b.start)) {
    total += Math.max(0, item.end - Math.max(item.start, until))
    until = Math.max(until, item.end)
  }
  return total
}

export function rhythmTime(seconds: number): string {
  const milliseconds = Math.round(Math.max(0, seconds) * 1000), wholeSeconds = Math.floor(milliseconds / 1000)
  return `${Math.floor(wholeSeconds / 60).toString().padStart(2, '0')}:${(wholeSeconds % 60).toString().padStart(2, '0')}.${(milliseconds % 1000).toString().padStart(3, '0')}`
}

export function addRhythmMarkers(project: Project, report: RhythmReport, selected: readonly string[]): Project {
  if (report.signature !== rhythmSignature(project)) throw new Error('工程时间线已改变，请重新分析后添加标记。')
  const chosen = new Set(selected), candidates = report.candidates.filter(item => chosen.has(item.id))
  if (candidates.length !== chosen.size) throw new Error('所选候选区间已失效，请重新分析。')
  if (!candidates.length) throw new Error('请先勾选需要检查的区间。')
  const copy = cloneProject(project), markers = [...(copy.markers || [])]
  for (const candidate of candidates) {
    const label = `节奏检查 · ${candidate.evidence.map(item => RHYTHM_LABELS[item.kind]).join(' / ')} · ${rhythmTime(candidate.start)}–${rhythmTime(candidate.end)} · ${candidate.clipName}`.slice(0, 300)
    if (markers.some(marker => marker.kind === 'review' && Math.abs(marker.time - candidate.start) < EPSILON && marker.label === label)) continue
    markers.push({ id: newId('rhythm'), time: candidate.start, label, kind: 'review', color: '#dba155' })
  }
  if (markers.length === (project.markers?.length || 0)) return project
  if (markers.length > 1000) throw new Error('项目标记最多 1000 个，请减少选择或移除已有标记。')
  copy.markers = markers.sort((a, b) => a.time - b.time)
  copy.updatedAt = new Date().toISOString()
  return validateProject(copy, { trusted: true })
}
