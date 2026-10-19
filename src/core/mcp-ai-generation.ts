import { createClip, createTrack, newId } from './project.ts'
import { addAssets, addClips, addTrack, clipDuration } from './timeline.ts'
import type { AiGenerationRequest, AiJob, AiStatus } from './ai.ts'
import type { MediaAsset, Project } from './types.ts'

export interface McpAiDestination {
  destination: 'generated' | 'assets' | 'timeline'
  trackId?: string
  start: number
  duration?: number
}
export interface PreparedMcpAiGeneration { request: { provider: 'image' | 'music'; request: AiGenerationRequest }; insertion: McpAiDestination }

/** Resolve references from the current project; callers cannot inject native file paths. */
export function prepareMcpAiGeneration(project: Project, provider: 'image' | 'music', args: Record<string, unknown>): PreparedMcpAiGeneration {
  const request: AiGenerationRequest = { requestId: newId('ai-generation'), modelId: args.modelId as string, prompt: args.prompt as string }
  const keys = provider === 'image'
    ? ['negativePrompt', 'width', 'height', 'steps', 'guidance', 'strength', 'seed', 'lowMemory']
    : ['lyrics', 'instrumental', 'seconds', 'bpm', 'language', 'keyScale', 'steps', 'guidance', 'seed', 'lowMemory']
  for (const key of keys) if (args[key] !== undefined) Object.assign(request, { [key]: args[key] })
  if (provider === 'image') {
    const reference = args.inputAssetId as string | undefined
    const mode = args.mode ?? (reference ? 'image-to-image' : 'text-to-image')
    if (mode === 'image-to-image' ? !reference : !!reference) throw new Error('图生图需提供 inputAssetId；文生图不接受参考图片。')
    if (reference) {
      const asset = project.assets.find(item => item.id === reference)
      if (!asset || asset.kind !== 'image') throw new Error('参考图片必须是当前项目中已有的图片素材。')
      request.inputAsset = structuredClone(asset)
    }
    for (const dimension of [request.width ?? 1024, request.height ?? 1024]) if (dimension % 16) throw new Error('图片宽高必须是 16 的倍数。')
    if (request.strength !== undefined && request.strength <= 0) throw new Error('参考图强度必须大于 0。')
    if (request.modelId === 'z-image-turbo' && (request.negativePrompt?.trim() || request.guidance !== undefined && request.guidance !== 0)) throw new Error('所选快速图像模型不支持负面提示词，引导强度必须为 0。')
    if (reference && Math.floor((request.steps ?? (request.modelId === 'z-image-turbo' ? 9 : 50)) * (request.strength ?? .75)) < 1) throw new Error('参考图强度与步数至少需保留一个有效生成步。')
  } else {
    const hasLyrics = !!request.lyrics?.trim() && request.lyrics.trim() !== '[Instrumental]'
    request.instrumental ??= !hasLyrics
    if (request.instrumental && hasLyrics) throw new Error('纯音乐模式不能同时提供歌词，请关闭 instrumental 或移除歌词。')
    if (!request.instrumental && !hasLyrics) throw new Error('歌曲生成需要歌词；仅生成配乐请设置 instrumental=true。')
    if (request.modelId === 'ace-step-1.5-turbo' && request.guidance !== undefined && request.guidance !== 1) throw new Error('所选快速音乐模型不支持调整引导强度，请省略 guidance 或设置为 1。')
  }
  const destination = (args.destination ?? 'generated') as McpAiDestination['destination']
  const insert = args.insert as { trackId?: string; start?: number; duration?: number } | undefined
  if (insert && destination !== 'timeline') throw new Error('insert 仅适用于 destination=timeline。')
  if (provider === 'music' && insert?.duration !== undefined) throw new Error('歌曲片段使用真实生成时长，不接受图片展示时长。')
  const insertion: McpAiDestination = { destination, start: insert?.start ?? 0, ...(insert?.trackId ? { trackId: insert.trackId } : {}), ...(insert?.duration !== undefined ? { duration: insert.duration } : {}) }
  if (insertion.trackId) {
    const track = project.tracks.find(item => item.id === insertion.trackId)
    if (!track || track.kind !== (provider === 'image' ? 'video' : 'audio')) throw new Error(provider === 'image' ? '图片应插入视频轨道。' : '歌曲应插入音频轨道。')
    if (track.locked) throw new Error('请先解锁目标轨道。')
  }
  return { request: { provider, request }, insertion }
}

export function publicAiAsset(asset: MediaAsset) {
  const { id, name, kind, duration, width, height, size, mime, addedAt } = asset
  return { id, name, kind, duration, width, height, size, mime, ...(addedAt ? { addedAt } : {}) }
}
export function publicAiJob(job: AiJob) {
  return { ...job, assets: job.assets.map(publicAiAsset), nativeJobId: job.id,
    poll: { tool: 'open_media_ai_job_get', arguments: { id: job.id } },
    cancel: job.cancelable ? { tool: 'open_media_ai_job_cancel', arguments: { id: job.id } } : null }
}
export function publicAiStatus(status: AiStatus) { return { ...status, jobs: status.jobs.map(publicAiJob) } }

/** Prepare a detached result; the controller commits it once after revision validation. */
export function applyMcpAiGeneration(project: Project, job: AiJob, prepared: PreparedMcpAiGeneration) {
  const expectedKind = prepared.request.provider === 'image' ? 'image' : 'audio'
  if (job.state !== 'completed' || job.provider !== prepared.request.provider || job.assets.length !== 1 || job.assets.some(asset => asset.kind !== expectedKind || !asset.id || !asset.url || !Number.isFinite(asset.duration) || expectedKind === 'audio' && asset.duration <= 0)) throw new Error('生成结果不完整，未修改工程。')
  const assets = job.assets.map(asset => structuredClone(asset))
  const { insertion } = prepared
  let next: Project | undefined
  let trackId: string | undefined
  const clipIds: string[] = []
  if (insertion.destination !== 'generated') next = addAssets(project, assets)
  if (insertion.destination === 'timeline') {
    trackId = insertion.trackId
    if (!trackId) { const track = createTrack(expectedKind === 'image' ? 'video' : 'audio', expectedKind === 'image' ? '生成图片' : '生成歌曲'); next = addTrack(next!, track); trackId = track.id }
    let start = insertion.start
    const clips = assets.map(asset => { const clip = createClip(asset, next!, { start, ...(expectedKind === 'image' ? { trimOut: insertion.duration ?? 5 } : {}) }); start += clipDuration(clip); clipIds.push(clip.id); return clip })
    next = addClips(next!, trackId, clips)
  }
  return { project: next, assets, result: { nativeJobId: job.id, destination: insertion.destination, assetIds: assets.map(asset => asset.id), assets: assets.map(publicAiAsset), clipIds, ...(trackId ? { trackId } : {}) } }
}
