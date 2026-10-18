import { cloneProject, validateProject } from './project.ts'
import { clipEnd, projectDuration } from './timeline.ts'
import { trackSubtitleIssues } from './subtitle-validation.ts'
import type { MediaAsset, Project } from './types.ts'
import type { EditorToolContext, PreparedEditorTool } from './editor-tool-service.ts'
import { base64Blob, bytesBase64, storeToolArtifact } from './tool-artifacts.ts'

export interface ExportIssue { severity: 'error' | 'warning'; code: string; message: string; clipId?: string; trackId?: string; time?: number }
export function inspectExportStructure(project: Project): ExportIssue[] {
  const issues: ExportIssue[] = []
  try { validateProject(project, { trusted: true }) } catch (cause) { issues.push({ severity: 'error', code: 'invalid_project', message: cause instanceof Error ? cause.message : String(cause) }) }
  const assets = new Set(project.assets.map(asset => asset.id))
  for (const track of project.tracks) {
    for (const issue of trackSubtitleIssues(track)) issues.push({ severity: 'warning', code: `subtitle_${issue.reason}`, message: issue.message, clipId: issue.clipId, trackId: track.id })
    for (const clip of track.clips) {
      if (clip.assetId && !assets.has(clip.assetId)) issues.push({ severity: 'error', code: 'missing_media', message: `“${clip.name}”缺少源素材。`, clipId: clip.id, trackId: track.id, time: clip.start })
      if (track.kind === 'text' && clip.text && (clip.x < 0 || clip.y < 0 || clip.x + clip.width > project.width + .5 || clip.y + clip.height > project.height + .5)) issues.push({ severity: 'warning', code: 'subtitle_bounds', message: `“${clip.name}”文字区域超出项目画面，请检查是否有意移出画面。`, clipId: clip.id, trackId: track.id, time: clip.start })
    }
  }
  const voices = project.tracks.filter(track => !track.muted && track.kind === 'audio').flatMap(track => track.clips.filter(clip => clip.speech && clip.volume > 0).map(clip => ({ clip, trackId: track.id }))).sort((a, b) => a.clip.start - b.clip.start)
  for (let index = 0; index < voices.length; index++) for (let next = index + 1; next < voices.length; next++) {
    const a = voices[index]!, b = voices[next]!
    if (b.clip.start >= clipEnd(a.clip) - .005) break
    if (Math.min(clipEnd(a.clip), clipEnd(b.clip)) > b.clip.start + .005) issues.push({ severity: 'warning', code: 'speech_overlap', message: `“${a.clip.name}”与“${b.clip.name}”的配音重叠。`, clipId: b.clip.id, trackId: b.trackId, time: b.clip.start })
  }
  if (!projectDuration(project)) issues.push({ severity: 'error', code: 'empty_timeline', message: '时间线没有可导出的内容。' })
  return issues
}
export function audioPreviewProject(source: Project, args: Record<string, unknown>): Project {
  const project = cloneProject(source), mode = args.mode ?? 'mix'
  const clipIds = args.clipIds as string[] | undefined, trackIds = args.trackIds as string[] | undefined
  if (mode === 'solo' && !clipIds?.length && !trackIds?.length) throw new Error('独听需要指定片段或轨道。')
  if (mode === 'mix' && (clipIds || trackIds)) throw new Error('指定片段或轨道时请选择独听模式。')
  for (const id of clipIds ?? []) if (!project.tracks.some(track => ['audio', 'video'].includes(track.kind) && track.clips.some(clip => clip.id === id))) throw new Error('独听片段不存在或不含音频。')
  for (const id of trackIds ?? []) if (!project.tracks.some(track => track.id === id && ['audio', 'video'].includes(track.kind))) throw new Error('独听轨道不存在或不含音频。')
  // Keep the original duration, including silent tails and visual-only sections.
  project.tracks = project.tracks.map(track => ({ ...track,
    muted: mode === 'solo' && ['audio', 'video'].includes(track.kind) ? false : track.muted,
    clips: track.clips.map(clip => {
      const silent = !!clip.freezeFrame || mode === 'solo' && !clipIds?.includes(clip.id) && !trackIds?.includes(track.id)
      if (silent) { clip.volume = 0; if (clip.keyframes) delete clip.keyframes.volume }
      return clip
    }),
  }))
  if (!project.tracks.some(track => ['audio', 'video'].includes(track.kind) && !track.muted && track.clips.some(clip => (clip.volume > 0 || clip.keyframes?.volume?.some(frame => frame.value > 0)) && project.assets.some(asset => asset.id === clip.assetId && asset.kind !== 'image')))) throw new Error('所选范围没有可听的音频片段。')
  return project
}
export function previewRange(project: Project, args: Record<string, unknown>): { start: number; end: number } {
  const duration = projectDuration(project), start = Number(args.start ?? 0), end = Number(args.end ?? Math.min(duration, start + 10))
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + .001 || end - start > 60 + .001) throw new Error('预览范围必须位于时间线内，且时长不能超过 60 秒。')
  return { start, end }
}
export async function artifactFromAsset(asset: MediaAsset, context: EditorToolContext) {
  const response = await fetch(asset.sourceUrl || asset.url, { signal: context.signal })
  if (!response.ok) throw new Error('无法读取已生成的媒体文件。')
  const blob = await response.blob()
  context.signal.throwIfAborted()
  return storeToolArtifact(blob.type ? blob : new Blob([blob], { type: asset.mime }), asset.name, context.signal)
}
function frameError(stage: string, cause: unknown): Error {
  if (cause && typeof cause === 'object' && 'name' in cause && cause.name === 'AbortError') return cause as Error
  return new Error(`时间线取帧（${stage}）失败：${cause instanceof Error ? cause.message : String(cause)}`, { cause })
}
async function frameFonts(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DOMException('取帧已取消。', 'AbortError')) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('字体准备超时，请待字体加载完成后重试。')) }, 10000)
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    signal.addEventListener('abort', abort, { once: true })
    document.fonts.ready.then(() => { cleanup(); resolve() }, error => { cleanup(); reject(error) })
    if (signal.aborted) abort()
  })
}
export async function timelineFrame(context: EditorToolContext, time: number, width = Math.min(1280, context.project.width)) {
  if (!Number.isFinite(time) || time < 0 || time >= projectDuration(context.project)) throw new Error('取帧时间必须位于时间线内。')
  if (!Number.isFinite(width) || width < 16 || width > 1920) throw new Error('取帧宽度需介于 16 和 1920 之间。')
  context.signal.throwIfAborted()
  try { await frameFonts(context.signal) } catch (cause) { throw frameError('字体准备', cause) }
  const { isDesktop } = await import('../native.ts')
  if (isDesktop()) {
    const { runTimelineFrame } = await import('../native-preview-tools.ts')
    let stage = '原生合成'
    let rendered: Awaited<ReturnType<typeof runTimelineFrame>> | undefined, failed = false
    try {
      rendered = await runTimelineFrame(context.project, time, { width, signal: context.signal, onProgress: context.onProgress })
      context.signal.throwIfAborted()
      stage = 'PNG 字节读取'
      const blob = base64Blob(rendered.pngBase64, 'image/png')
      stage = '预览缓存'
      const artifact = await storeToolArtifact(blob, `时间线-${time.toFixed(3)}秒.png`, context.signal)
      return { ...artifact, time, width: rendered.asset.width, height: rendered.asset.height, base64: rendered.pngBase64 }
    } catch (cause) { failed = true; throw frameError(stage, cause) }
    finally {
      try { await rendered?.discard() } catch (cause) { if (!failed) throw frameError('临时文件清理', cause) }
    }
  }
  const { TimelinePreview } = await import('./preview.ts')
  const canvas = document.createElement('canvas')
  const scale = Math.min(width / context.project.width, 1920 / context.project.width, 1920 / context.project.height)
  canvas.width = Math.max(1, Math.round(context.project.width * scale)); canvas.height = Math.max(1, Math.round(context.project.height * scale))
  const errors: string[] = []
  let preview: InstanceType<typeof TimelinePreview> | undefined, stage = '画面合成'
  try {
    preview = new TimelinePreview(canvas, context.project, error => errors.push(error))
    context.onProgress({ stage: '正在合成时间线画面' })
    await preview.prepare(context.signal)
    await preview.seekReady(time, context.signal)
    if (errors.length) throw new Error(errors.join('；'))
    context.signal.throwIfAborted()
    stage = '画布 PNG 导出'
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法生成合成画面。')), 'image/png'))
    stage = '预览缓存'
    const artifact = await storeToolArtifact(blob, `时间线-${time.toFixed(3)}秒.png`, context.signal)
    stage = 'PNG 字节读取'
    return { ...artifact, time, width: canvas.width, height: canvas.height, base64: bytesBase64(new Uint8Array(await blob.arrayBuffer())) }
  } catch (cause) { throw frameError(stage, cause) }
  finally { preview?.dispose(); canvas.width = canvas.height = 1 }
}
export async function storyboardSheet(frames: { base64: string; requestedTime: number; width: number; height: number }[], context: EditorToolContext) {
  const cellWidth = 320, columns = Math.min(4, frames.length), cellHeight = 210
  const canvas = document.createElement('canvas'); canvas.width = columns * cellWidth; canvas.height = Math.ceil(frames.length / columns) * cellHeight
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#151923'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.font = '15px sans-serif'
  try {
    for (const [index, frame] of frames.entries()) {
      context.signal.throwIfAborted()
      const image = await createImageBitmap(base64Blob(frame.base64, 'image/png'))
      const x = index % columns * cellWidth, y = Math.floor(index / columns) * cellHeight, scale = Math.min((cellWidth - 12) / image.width, 176 / image.height)
      ctx.drawImage(image, x + (cellWidth - image.width * scale) / 2, y + (180 - image.height * scale) / 2, image.width * scale, image.height * scale); image.close()
      ctx.fillStyle = '#f1f3f8'; ctx.fillText(`${frame.requestedTime.toFixed(2)} 秒`, x + 10, y + 199)
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('联系表生成失败。')), 'image/png'))
    const artifact = await storeToolArtifact(blob, '素材联系表.png', context.signal)
    return { ...artifact, width: canvas.width, height: canvas.height, base64: bytesBase64(new Uint8Array(await blob.arrayBuffer())) }
  } finally { canvas.width = canvas.height = 1 }
}
export async function preparePreviewTool(name: string, args: Record<string, unknown>, context: EditorToolContext): Promise<PreparedEditorTool> {
  if (name === 'open_media_timeline_get_frame') return { data: await timelineFrame(context, args.time as number, args.width as number | undefined) }
  const { runTimelinePreview } = await import('../native-preview-tools.ts')
  if (name === 'open_media_export_validate') {
    const issues = inspectExportStructure(context.project), scope: Record<string, unknown> = { projectStructure: true, mediaAnalyzed: false }
    if (!args.analyzeMedia || issues.some(issue => issue.severity === 'error')) return { data: { valid: !issues.some(issue => issue.severity === 'error'), issues, scope } }
    const range = previewRange(context.project, args), { runAssetTool } = await import('../native-asset-tools.ts')
    const used = new Set(context.project.tracks.flatMap(track => track.clips.map(clip => clip.assetId).filter(Boolean)))
    for (const asset of context.project.assets.filter(asset => used.has(asset.id))) {
      try { await runAssetTool('asset_probe', { asset }, context) } catch (cause) { context.signal.throwIfAborted(); issues.push({ severity: 'error', code: 'unreadable_media', message: `“${asset.name}”无法读取：${cause instanceof Error ? cause.message : String(cause)}` }) }
    }
    if (issues.some(issue => issue.severity === 'error')) return { data: { valid: false, issues, scope } }
    const rendered = await runTimelinePreview(context.project, range.start, range.end, { width: 640, fps: Math.min(30, context.project.fps), signal: context.signal, onProgress: context.onProgress })
    try {
      const evidence = await runAssetTool<{ decoded: boolean; blackIntervals: { start: number; end: number }[]; audio?: { possibleClipping?: boolean; peakDbfs?: number }; warnings?: string[]; errors?: string[] }>('validate_export', { asset: rendered.asset, start: 0, end: range.end - range.start }, context)
      for (const interval of evidence.blackIntervals ?? []) issues.push({ severity: 'warning', code: 'black_interval', message: `${(range.start + interval.start).toFixed(3)}–${(range.start + interval.end).toFixed(3)} 秒检测到黑场，请检查是否为预期画面。`, time: range.start + interval.start })
      if (evidence.audio?.possibleClipping) issues.push({ severity: 'warning', code: 'audio_peak', message: `音频峰值接近满幅（${evidence.audio.peakDbfs} dBFS），可能存在削波。` })
      for (const error of evidence.errors ?? []) issues.push({ severity: 'error', code: 'decode_error', message: error })
      if (!evidence.decoded && !evidence.errors?.length) issues.push({ severity: 'error', code: 'decode_error', message: '渲染结果未能完整解码。' })
      const artifact = await artifactFromAsset(rendered.asset, context)
      return { data: { valid: !issues.some(issue => issue.severity === 'error'), issues, scope: { ...scope, mediaAnalyzed: true, ...range, width: 640, fps: Math.min(30, context.project.fps), note: '仅检测所选范围的低清合成结果；完整导出文件仍需检查。' }, evidence, preview: artifact } }
    } finally { await rendered.discard() }
  }
  const project = name === 'open_media_audio_preview' ? audioPreviewProject(context.project, args) : context.project, range = previewRange(project, args)
  const rendered = await runTimelinePreview(project, range.start, range.end, { audioOnly: name === 'open_media_audio_preview', width: args.width as number | undefined, fps: args.fps as number | undefined, signal: context.signal, onProgress: context.onProgress })
  try { return { data: { ...await artifactFromAsset(rendered.asset, context), ...range, duration: range.end - range.start } } }
  finally { await rendered.discard() }
}
