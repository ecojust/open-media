import type * as native from '../native.ts'
import type * as audioNative from '../native-audio-tools.ts'
import type * as asrNative from '../native-transcription.ts'
import type { EditorToolContext, PreparedEditorTool } from './editor-tool-service.ts'
import type { Clip, MediaAsset, Project } from './types.ts'
import { cloneProject, validateProject } from './project.ts'
import { clipDuration, clipEnd, findClip } from './timeline.ts'
import { getSpeechSettings, validateSpeechSettings } from './speech-settings.ts'
import { applySpeechPronunciation, getSpeechPronunciation, setSpeechPronunciation, validateSpeechPronunciation } from './speech-pronunciation.ts'
import { getSpeechAlignment, setSpeechAlignment, speechTimingPlan, validateSpeechAlignment } from './speech-timing.ts'
import { exportSubtitles, importSubtitles, importSubtitleCues, type SubtitleFormat, type SubtitleFileOptions } from './subtitle-files.ts'
import { voiceReady } from './voice-downloads.ts'

const NAMES = new Set(['speech_generate_preview', 'speech_pronunciation_get', 'speech_pronunciation_set', 'speech_timing_plan', 'speech_alignment_get', 'speech_alignment_set', 'subtitle_import_export', 'audio_loudness_analyze', 'audio_normalize', 'audio_ducking', 'audio_process', 'music_fit_duration', 'audio_transcribe', 'audio_balance'])
export function isAudioEditorTool(name: string): boolean { return NAMES.has(name.replace(/^open_media_/, '')) }
export interface AudioEditorDependencies {
  native: Pick<typeof native, 'getSpeechStatus' | 'beginSpeechJob' | 'getSpeechJob' | 'cancelSpeechJob' | 'discardSpeechJob' | 'acceptSpeechJobs' | 'importBlobAsset'>
  audio: typeof audioNative
  asr?: typeof asrNative
  pollMs?: number
}
async function defaults(): Promise<AudioEditorDependencies> {
  return { native: await import('../native.ts'), audio: await import('../native-audio-tools.ts') }
}
function check(context: EditorToolContext) { context.signal.throwIfAborted() }
function wait(signal: AbortSignal, delay: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(done, delay)
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason || new Error('操作已取消。')) }
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
  })
}
function textArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少有效 ${key}。`)
  return value
}
export function speechIntervals(project: Project, target: Clip, ids?: string[]): { start: number; end: number }[] {
  if (ids && (!Array.isArray(ids) || !ids.length || ids.some(id => !project.tracks.some(track => track.id === id && track.kind === 'audio')))) throw new Error('人声轨道不存在或不是音频轨道。')
  const intervals = project.tracks.filter(track => track.kind === 'audio' && !track.muted && (!ids || ids.includes(track.id))).flatMap(track => track.clips.filter(clip => clip.id !== target.id && clip.volume > 0 && (ids || clip.speech)).map(clip => ({ start: Math.max(0, clip.start - target.start), end: Math.min(clipDuration(target), clipEnd(clip) - target.start) }))).filter(interval => interval.end > interval.start).sort((a, b) => a.start - b.start)
  const merged: typeof intervals = []
  for (const interval of intervals) {
    const previous = merged.at(-1)
    if (previous && interval.start <= previous.end + .001) previous.end = Math.max(previous.end, interval.end)
    else merged.push({ ...interval })
  }
  if (!merged.length) throw new Error('背景音频范围内没有可用的人声片段，请选择人声轨道。')
  if (merged.length > 256) throw new Error('独立人声区间超过 256 段，请分段处理。')
  return merged
}
async function localAsset(asset: MediaAsset, context: EditorToolContext, dependencies: AudioEditorDependencies): Promise<MediaAsset> {
  if (asset.nativePath) return asset
  let blob = context.blobs.get(asset.id)
  if (!blob && /^(blob:|data:)/.test(asset.sourceUrl || asset.url)) {
    const response = await fetch(asset.sourceUrl || asset.url, { signal: context.signal })
    if (!response.ok) throw new Error('无法读取音频素材。')
    blob = await response.blob()
  }
  if (!blob) throw new Error('素材缺少本地音频，请重新导入后再处理。')
  check(context)
  const imported = await dependencies.native.importBlobAsset(new Uint8Array(await blob.arrayBuffer()), asset.name)
  check(context)
  return { ...imported, id: asset.id }
}
async function previewSpeech(args: Record<string, unknown>, context: EditorToolContext, deps: AudioEditorDependencies): Promise<PreparedEditorTool> {
  const text = textArg(args, 'text').trim()
  if ([...text].length > 4000) throw new Error('单段配音最多支持 4000 字。')
  const status = await deps.native.getSpeechStatus(); check(context)
  const saved = getSpeechSettings()
  const settings = validateSpeechSettings({ voiceId: args.voiceId ?? saved.voiceId, rate: args.rate ?? saved.rate, alignText: true })
  const voice = settings.voiceId ? status.voices.find(voice => voice.id === settings.voiceId) : status.voices.find(voiceReady)
  if (!voiceReady(voice)) throw new Error('所选配音模型尚未就绪，请先下载模型及运行组件。')
  let id: string = crypto.randomUUID()
  const abort = () => { void deps.native.cancelSpeechJob(id).catch(() => {}) }
  context.signal.addEventListener('abort', abort, { once: true })
  try {
    let job = await deps.native.beginSpeechJob({ requestId: id, text: applySpeechPronunciation(text), voiceId: voice!.id, speed: settings.rate })
    id = job.id
    for (;;) {
      check(context)
      context.onProgress({ stage: job.stage || '正在合成试听', progress: job.progress })
      if (job.state === 'failed' || job.state === 'cancelled') throw new Error(job.error || '试听生成已取消。')
      if (job.state === 'completed') {
        if (!job.asset || job.asset.kind !== 'audio' || !job.asset.nativePath || !Number.isFinite(job.asset.duration) || job.asset.duration <= 0) throw new Error('配音结果没有有效音频。')
        return { data: { asset: job.asset, text, voiceId: voice!.id, rate: settings.rate, addedToTimeline: false }, accept: () => deps.native.acceptSpeechJobs([id]), discard: () => deps.native.discardSpeechJob(id) }
      }
      await wait(context.signal, deps.pollMs ?? 300)
      job = await deps.native.getSpeechJob(id)
    }
  } catch (error) { await Promise.allSettled([deps.native.cancelSpeechJob(id), deps.native.discardSpeechJob(id)]); throw error }
  finally { context.signal.removeEventListener('abort', abort) }
}
async function processAudio(name: string, args: Record<string, unknown>, context: EditorToolContext, deps: AudioEditorDependencies): Promise<PreparedEditorTool> {
  const found = findClip(context.project, textArg(args, 'clipId'))
  if (!found || found.track.kind !== 'audio') throw new Error('请选择音频轨道中的片段。')
  const readonly = name === 'audio_loudness_analyze'
  if (found.track.locked && !readonly) throw new Error('音频轨道已锁定。')
  if (found.clip.speedRamp || found.clip.keyframes?.volume?.length) throw new Error('此音频包含变速曲线或音量关键帧，请先导出并重新导入后处理，以保留听感。')
  const asset = context.project.assets.find(asset => asset.id === found.clip.assetId)
  if (!asset || asset.kind !== 'audio') throw new Error('音频素材不存在。')
  const source = await localAsset(asset, context, deps); check(context)
  const action = ({ audio_loudness_analyze: 'analyze', audio_normalize: 'normalize', audio_process: 'process', audio_ducking: 'ducking', music_fit_duration: 'music_fit' } as Record<string, string>)[name]
  const spec: Record<string, unknown> = { ...args, action, asset: source, trimIn: found.clip.trimIn, trimOut: found.clip.trimOut, speed: found.clip.speed, volume: found.clip.volume }
  if (action === 'ducking') spec.intervals = speechIntervals(context.project, found.clip, args.speechTrackIds as string[] | undefined)
  let id: string | undefined
  const abort = () => { if (id) void deps.audio.cancelAudioTool(id).catch(() => {}) }
  context.signal.addEventListener('abort', abort, { once: true })
  try {
    let job = await deps.audio.beginAudioTool(spec); id = job.id
    for (;;) {
      check(context); context.onProgress({ stage: job.stage, progress: job.progress })
      if (job.state === 'failed' || job.state === 'cancelled') throw new Error(job.error || '音频处理已取消。')
      if (job.state === 'completed') break
      await wait(context.signal, deps.pollMs ?? 250); job = await deps.audio.getAudioTool(id)
    }
    if (!job.result) throw new Error('音频任务未返回结果。')
    const accept = () => deps.audio.acceptAudioTool(id!)
    const discard = () => { void deps.audio.discardAudioTool(id!).catch(() => {}) }
    if (readonly) return { data: { ...job.result, scope: '片段音量后、淡入淡出前；未混合其他轨道。' }, accept, discard }
    const output = job.result.asset
    if (!output || output.kind !== 'audio' || !output.nativePath || !Number.isFinite(output.duration) || output.duration <= 0) throw new Error('音频处理未生成有效文件。')
    const copy = cloneProject(context.project), target = findClip(copy, found.clip.id)!.clip
    output.name = `${found.clip.name.slice(0, 960)} · ${name === 'music_fit_duration' ? '时长适配' : '音频处理'}`
    output.addedAt = new Date().toISOString()
    copy.assets.push(output)
    target.assetId = output.id; target.trimIn = 0; target.trimOut = output.duration; target.speed = 1; target.volume = 1
    target.fadeIn = Math.min(target.fadeIn, output.duration); target.fadeOut = action === 'music_fit' ? 0 : Math.min(target.fadeOut, output.duration)
    target.generatedAt = output.addedAt; copy.updatedAt = output.addedAt
    return { project: validateProject(copy, { trusted: true }), data: { ...job.result, clipId: target.id }, label: '音频处理已应用', selection: { clipId: target.id, trackId: found.track.id }, assets: [{ asset: output }], accept, discard }
  } catch (error) { if (id) await Promise.allSettled([deps.audio.cancelAudioTool(id), deps.audio.discardAudioTool(id)]); throw error }
  finally { context.signal.removeEventListener('abort', abort) }
}
export async function prepareAudioEditorTool(toolName: string, args: Record<string, unknown>, context: EditorToolContext, dependencies?: AudioEditorDependencies): Promise<PreparedEditorTool> {
  check(context)
  const name = toolName.replace(/^open_media_/, '')
  if (!isAudioEditorTool(toolName)) throw new Error('未知音频或字幕工具。')
  if (name === 'speech_pronunciation_get') return { data: { entries: getSpeechPronunciation() } }
  if (name === 'speech_pronunciation_set') { const entries = validateSpeechPronunciation(args.entries); return { data: { entries }, accept: async () => { setSpeechPronunciation(entries) } } }
  if (name === 'speech_alignment_get') return { data: getSpeechAlignment() }
  if (name === 'speech_alignment_set') { const policy = validateSpeechAlignment({ mode: args.mode, gap: args.gap ?? 0 }); return { data: policy, accept: async () => { setSpeechAlignment(policy) } } }
  if (name === 'speech_timing_plan') return { data: speechTimingPlan(context.project, args as { clipIds?: string[]; rate?: number }) }
  if (name === 'speech_generate_preview') return previewSpeech(args, context, dependencies ?? await defaults())
  if (name === 'audio_balance') {
    const { prepareAudioBalance } = await import('./audio-balance.ts')
    const deps = dependencies ?? await defaults()
    return prepareAudioBalance(context.project, args as unknown as import('./audio-balance.ts').AudioBalanceOptions, context, (clipId, child) => processAudio('audio_loudness_analyze', { clipId }, child, deps))
  }
  if (name === 'subtitle_import_export') {
    const format = textArg(args, 'format') as SubtitleFormat
    const options = args as SubtitleFileOptions & { trackId?: string }
    if (args.action === 'import') return importSubtitles(context.project, textArg(args, 'text'), format, options)
    if (args.action === 'export') return { data: exportSubtitles(context.project, format, options) }
    throw new Error('请选择导入或导出字幕。')
  }
  if (name === 'audio_transcribe') return transcribeAudio(args, context, dependencies ?? await defaults())
  return processAudio(name, args, context, dependencies ?? await defaults())
}

async function transcribeAudio(args: Record<string, unknown>, context: EditorToolContext, deps: AudioEditorDependencies): Promise<PreparedEditorTool> {
  const allowed: Record<string, string[]> = {
    status: [], download: ['modelId'], cancel: ['jobId'],
    transcribe: ['modelId', 'clipId', 'assetId', 'language', 'granularity', 'createSubtitles'],
  }
  const fields = allowed[String(args.action)]
  if (!fields) throw new Error('未知识别操作。')
  if (Object.keys(args).some(key => !['action', 'expectedRevision', ...fields].includes(key))) throw new Error('当前识别操作包含不适用的参数。')
  const asr = deps.asr ?? await import('../native-transcription.ts')
  if (args.action === 'status') return { data: await asr.getAsrStatus() }
  if (args.action === 'cancel') { await asr.cancelAsrJob(textArg(args, 'jobId')); return { data: { cancelled: true, jobId: args.jobId } } }
  if (!['download', 'transcribe'].includes(String(args.action))) throw new Error('未知识别操作。')
  let start = 0
  let pending: Promise<asrNative.AsrJob>
  if (args.action === 'download') pending = asr.beginAsrDownload(args.modelId as string | undefined)
  else {
    const clip = args.clipId ? findClip(context.project, textArg(args, 'clipId'))?.clip : undefined
    if (args.clipId && !clip) throw new Error('待识别片段不存在。')
    if (clip?.speedRamp) throw new Error('此片段有变速曲线，请先导出并重新导入后识别，以保持字幕时间准确。')
    const asset = context.project.assets.find(asset => asset.id === (clip?.assetId || args.assetId))
    if (!asset || !['audio', 'video'].includes(asset.kind)) throw new Error('请选择有效音频或视频素材。')
    if (args.assetId && clip && args.assetId !== clip.assetId) throw new Error('片段和素材标识不对应。')
    const source = await localAsset(asset, context, deps); check(context)
    start = clip?.start ?? 0
    pending = asr.beginAsrTranscription({ asset: source, modelId: args.modelId as string | undefined, language: args.language as string | undefined, granularity: args.granularity as 'sentence' | 'word' | undefined, trimIn: clip?.trimIn ?? 0, trimOut: clip?.trimOut ?? asset.duration, speed: clip?.speed ?? 1 })
  }
  let id: string | undefined
  const abort = () => { if (id) void asr.cancelAsrJob(id).catch(() => {}) }
  context.signal.addEventListener('abort', abort, { once: true })
  try {
    let job = await pending; id = job.id
    for (;;) {
      check(context); context.onProgress({ stage: job.stage, progress: job.progress })
      if (job.state === 'failed' || job.state === 'cancelled') throw new Error(job.error || '识别任务已取消。')
      if (job.state === 'completed') break
      await wait(context.signal, deps.pollMs ?? 300); job = await asr.getAsrJob(id)
    }
    if (!job.result) throw new Error('识别任务未返回结果。')
    if (args.action === 'download') return { data: job.result }
    const result = job.result as asrNative.AsrResult
    if (result.timestampKind !== 'model' || !Array.isArray(result.segments)) throw new Error('识别结果缺少模型时间戳。')
    const shift = (item: asrNative.AsrTimedText) => ({ ...item, start: item.start + start, end: item.end + start })
    const segments = result.segments.map(segment => ({ ...shift(segment), words: (segment.words || []).map(shift), tokens: (segment.tokens || []).map(shift) }))
    const data = { ...result, segments, tokens: (result.tokens || []).map(shift), timeOrigin: args.clipId ? 'timeline' : 'asset', addedSubtitles: false }
    if (!args.createSubtitles) return { data }
    const cues = args.granularity === 'word' ? segments.flatMap(segment => segment.words) : segments
    if (!cues.length) throw new Error('识别完成，但没有可用文字时间戳，未添加字幕。')
    const imported = importSubtitleCues(context.project, cues)
    return { ...imported, data: { ...data, addedSubtitles: true, subtitleCount: imported.data.count, clipIds: imported.data.clipIds } }
  } catch (error) { if (id) await asr.cancelAsrJob(id).catch(() => {}); throw error }
  finally { context.signal.removeEventListener('abort', abort) }
}
