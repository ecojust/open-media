import { cloneProject, createClip, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS, validateProject } from './project.ts'
import { clipDuration, clipEnd, findClip } from './timeline.ts'
import type { Clip, MediaAsset, Project, Track } from './types.ts'
import { applySpeechAlignment } from './speech-alignment.ts'
import type { SpeechAlignmentSettings } from './speech-timing.ts'

export const MAX_SPEECH_TEXT_CHARS = 4000
const MIN_AUDIO_DURATION = 0.001

export interface SpeechSource {
  projectId: string
  clipId: string
  trackId: string
  name: string
  text: string
  start: number
  duration: number
  fingerprint: string
}

export interface SpeechPlan {
  sources: SpeechSource[]
  skipped: { clipId: string; name: string; reason: string }[]
}

export interface SpeechResult {
  source: SpeechSource
  asset: MediaAsset
  voiceId: string
  rate: number
}

export interface SpeechOverlap {
  firstClipId: string
  secondClipId: string
  start: number
  end: number
  kind: 'text' | 'speech'
}

export interface SpeechEdit {
  project: Project
  audioClipIds: string[]
  overlaps: SpeechOverlap[]
}

function sourceFingerprint(project: Project, track: Track, clip: Clip): string {
  return JSON.stringify([project.id, track.id, clip.id, clip.text, clip.start, clip.trimIn, clip.trimOut, clip.speed])
}

function linkedSpeech(project: Project, textClipId: string): { track: Track; clip: Clip } | undefined {
  for (const track of project.tracks) {
    const clip = track.clips.find((item) => item.speech?.textClipId === textClipId)
    if (clip) return { track, clip }
  }
  return undefined
}

function eligibleSource(project: Project, clipId: string, generating = true): SpeechSource {
  const current = findClip(project, clipId)
  if (!current || current.track.kind !== 'text') throw new Error('所选字幕片段不存在。')
  if (current.track.locked) throw new Error('字幕轨道已锁定，请先解锁。')
  const text = current.clip.text?.trim() ?? ''
  if (!text) throw new Error('字幕文字为空。')
  if (generating && [...text].length > MAX_SPEECH_TEXT_CHARS) throw new Error(`单段文字最多支持 ${MAX_SPEECH_TEXT_CHARS} 个字符，请拆分后生成。`)
  if (linkedSpeech(project, clipId)?.track.locked) throw new Error('此字幕的配音轨道已锁定，请先解锁。')
  return { projectId: project.id, clipId, trackId: current.track.id, name: current.clip.name, text, start: current.clip.start, duration: clipDuration(current.clip), fingerprint: sourceFingerprint(project, current.track, current.clip) }
}

export function planSpeech(project: Project, clipIds?: string[]): SpeechPlan {
  const selected = clipIds ?? project.tracks.filter((track) => track.kind === 'text').flatMap((track) => track.clips.map((clip) => clip.id))
  const plan: SpeechPlan = { sources: [], skipped: [] }
  for (const clipId of new Set(selected)) {
    try { plan.sources.push(eligibleSource(project, clipId)) } catch (error) {
      plan.skipped.push({ clipId, name: findClip(project, clipId)?.clip.name ?? '字幕片段', reason: error instanceof Error ? error.message : String(error) })
    }
  }
  plan.sources.sort((a, b) => a.start - b.start)
  return plan
}

function prepareSpeechTracks(project: Project, selected: Set<string>): { project: Project; preferredTracks: Map<string, string> } {
  const copy = cloneProject(project)
  const preferredTracks = new Map<string, string>()
  for (const track of copy.tracks) {
    track.clips = track.clips.filter((clip) => {
      const sourceId = clip.speech?.textClipId
      if (!sourceId || !selected.has(sourceId)) return true
      preferredTracks.set(sourceId, track.id)
      return false
    })
  }
  return { project: copy, preferredTracks }
}

/** Unknown lengths use the shortest valid audio; measured lengths can be checked as each result arrives. */
export function validateSpeechPlanCapacity(project: Project, plan: SpeechPlan, knownDurations: ReadonlyMap<string, number> = new Map()): void {
  if (!plan.sources.length) return
  const selected = new Set<string>()
  for (const source of plan.sources) {
    const current = eligibleSource(project, source.clipId)
    if (selected.has(source.clipId)) throw new Error('同一字幕不能重复提交配音结果。')
    selected.add(source.clipId)
    if (source.projectId !== project.id || source.fingerprint !== current.fingerprint || source.text !== current.text) throw new Error(`字幕“${current.name}”已更改，请重新生成配音。`)
  }
  const availableAssets = Math.max(0, MAX_ASSETS - project.assets.length)
  if (plan.sources.length > availableAssets) throw new Error(`项目最多容纳 ${MAX_ASSETS} 个素材，目前还可添加 ${availableAssets} 个，本次需要 ${plan.sources.length} 个配音素材。请先移除不用的素材，或减少本次选择的字幕。`)
  const prepared = prepareSpeechTracks(project, selected)
  const retainedClips = prepared.project.tracks.reduce((total, track) => total + track.clips.length, 0)
  if (retainedClips + plan.sources.length > MAX_CLIPS) throw new Error(`项目最多容纳 ${MAX_CLIPS} 个片段，本次新增配音会超过数量限制。请先移除不用的片段，或减少本次选择的字幕。`)
  for (const source of [...plan.sources].sort((a, b) => a.start - b.start)) {
    const duration = knownDurations.get(source.clipId) ?? MIN_AUDIO_DURATION
    if (!Number.isFinite(duration) || duration < MIN_AUDIO_DURATION) throw new Error(`字幕“${source.name}”的配音时长无效。`)
    if (source.start + duration > MAX_PROJECT_DURATION + 1e-6) throw new Error(`字幕“${source.name}”的配音将超出 24 小时时间线，请缩短文字或将字幕向前移动。`)
    const track = speechTrack(prepared.project, source.start, duration, prepared.preferredTracks.get(source.clipId))
    const asset: MediaAsset = { id: `planned-${source.clipId}`, name: source.name, kind: 'audio', url: '', duration, width: 0, height: 0, size: 0, mime: 'audio/wav' }
    track.clips.push(createClip(asset, prepared.project, { start: source.start, speech: { textClipId: source.clipId, text: source.text, voiceId: 'pending', rate: 1 } }))
  }
}

function alignText(clip: Clip, start: number, duration: number): void {
  clip.start = start
  clip.trimIn = 0
  clip.trimOut = duration
  clip.speed = 1
  clip.fadeIn = Math.min(clip.fadeIn, duration)
  clip.fadeOut = Math.min(clip.fadeOut, duration)
}

function overlaps(project: Project, changedText: Set<string>, changedSpeech: Set<string>): SpeechOverlap[] {
  const result: SpeechOverlap[] = []
  const groups = [
    { kind: 'text' as const, clips: project.tracks.filter((track) => track.kind === 'text').flatMap((track) => track.clips), changed: changedText },
    { kind: 'speech' as const, clips: project.tracks.filter((track) => track.kind === 'audio').flatMap((track) => track.clips.filter((clip) => clip.speech)), changed: changedSpeech },
  ]
  for (const group of groups) {
    const ordered = [...group.clips].sort((a, b) => a.start - b.start)
    for (let first = 0; first < ordered.length; first++) {
      const a = ordered[first]!
      for (let second = first + 1; second < ordered.length; second++) {
        const b = ordered[second]!
        if (b.start >= clipEnd(a) - 1e-6) break
        if (!group.changed.has(a.id) && !group.changed.has(b.id)) continue
        const start = Math.max(a.start, b.start)
        const end = Math.min(clipEnd(a), clipEnd(b))
        if (end - start > 1e-6) result.push({ firstClipId: a.id, secondClipId: b.id, start, end, kind: group.kind })
      }
    }
  }
  return result
}

function speechTrack(project: Project, start: number, duration: number, preferredId?: string): Track {
  const canUse = (track: Track): boolean => track.kind === 'audio' && !track.locked
    && track.clips.every((clip) => clipEnd(clip) <= start + 1e-6 || clip.start >= start + duration - 1e-6)
  const preferred = project.tracks.find((track) => track.id === preferredId && canUse(track))
  if (preferred) return preferred
  const existing = project.tracks.find((track) => !track.muted && canUse(track) && (track.name === '文字配音' || track.clips.length > 0 && track.clips.every((clip) => clip.speech)))
  if (existing) return existing
  if (project.tracks.length >= MAX_TRACKS) throw new Error(`项目最多容纳 ${MAX_TRACKS} 条轨道，没有足够的配音轨道空间。请移除不用的轨道，或调整重叠字幕后再生成。`)
  const track = createTrack('audio', '文字配音')
  project.tracks.push(track)
  return track
}

/** Results are applied atomically so a batch can be one undo operation. */
export function applySpeechResults(project: Project, results: SpeechResult[], options: { alignText?: boolean; alignment?: SpeechAlignmentSettings } = {}): SpeechEdit {
  if (!results.length) return { project, audioClipIds: [], overlaps: [] }
  validateSpeechPlanCapacity(project, { sources: results.map((result) => result.source), skipped: [] }, new Map(results.map((result) => [result.source.clipId, result.asset.duration])))
  const seen = new Set(results.map((result) => result.source.clipId))
  for (const result of results) {
    if (result.asset.kind !== 'audio' || !Number.isFinite(result.asset.duration) || result.asset.duration < 0.001 || result.asset.size <= 0 || !result.asset.url) throw new Error('合成结果不是可用的音频素材。')
    if (project.assets.some((asset) => asset.id === result.asset.id)) throw new Error('合成音频的素材标识已经存在。')
  }
  const { project: copy, preferredTracks } = prepareSpeechTracks(project, seen)
  const audioClipIds: string[] = []
  const changedText = new Set<string>()
  for (const result of [...results].sort((a, b) => a.source.start - b.source.start)) {
    const source = findClip(copy, result.source.clipId)!
    const asset = { ...result.asset }
    copy.assets.push(asset)
    const track = speechTrack(copy, source.clip.start, asset.duration, preferredTracks.get(source.clip.id))
    const clip = createClip(asset, copy, { start: source.clip.start, name: `${source.clip.name.slice(0, 990)} · 配音`, speech: { textClipId: source.clip.id, text: result.source.text, voiceId: result.voiceId, rate: result.rate } })
    track.clips.push(clip)
    audioClipIds.push(clip.id)
    if (options.alignText !== false) {
      alignText(source.clip, source.clip.start, asset.duration)
      changedText.add(source.clip.id)
    }
  }
  copy.updatedAt = new Date().toISOString()
  const validated = validateProject(copy, { trusted: true })
  const next = options.alignText !== false && options.alignment ? applySpeechAlignment(validated, results, options.alignment) : validated
  return { project: next, audioClipIds, overlaps: overlaps(next, changedText, new Set(audioClipIds)) }
}

/** Current audio trims and speed determine the visible subtitle duration. */
export function alignTextToSpeech(project: Project, clipIds?: string[]): SpeechEdit {
  const selected = clipIds ?? project.tracks.flatMap((track) => track.clips.flatMap((clip) => clip.speech?.textClipId ? [clip.speech.textClipId] : []))
  const ids = [...new Set(selected)]
  if (!ids.length) throw new Error('请先为字幕生成配音。')
  const copy = cloneProject(project)
  const audioClipIds: string[] = []
  for (const id of ids) {
    const source = eligibleSource(copy, id, false)
    const audio = linkedSpeech(copy, id)
    if (!audio) throw new Error(`字幕“${source.name}”还没有关联的配音。`)
    if (audio.clip.speech!.text !== source.text) throw new Error(`字幕“${source.name}”的文字已更改，请重新生成配音。`)
    alignText(findClip(copy, id)!.clip, audio.clip.start, clipDuration(audio.clip))
    audioClipIds.push(audio.clip.id)
  }
  copy.updatedAt = new Date().toISOString()
  const next = validateProject(copy, { trusted: true })
  return { project: next, audioClipIds, overlaps: overlaps(next, new Set(ids), new Set()) }
}
