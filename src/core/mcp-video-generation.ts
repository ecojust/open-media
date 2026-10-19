import { createClip, createTrack, newId } from './project.ts'
import { addAssets, addClips, addTrack, clipDuration } from './timeline.ts'
import { adoptFirstVideoSize } from './project-size.ts'
import { videoGenerationRequestError, type VideoGenerationJob, type VideoGenerationMode, type VideoGenerationRequest, type VideoGenerationShot } from './video-generation.ts'
import type { MediaAsset, Project } from './types.ts'

interface ShotInput {
  title?: string
  prompt: string
  seconds?: number
  firstFrameAssetId?: string
  lastFrameAssetId?: string
  references?: { assetId: string; kind: 'image' | 'video' | 'audio'; includeAudio?: boolean }[]
}
export interface McpVideoInsertion { trackId?: string; start: number; mode: 'shots' | 'combined' }

/** Resolve project capabilities locally. Remote callers never supply native paths. */
export function prepareMcpVideoGeneration(project: Project, args: Record<string, unknown>): { request: VideoGenerationRequest; insert?: McpVideoInsertion } {
  const asset = (id: string | undefined): MediaAsset | undefined => {
    if (id === undefined) return undefined
    const result = project.assets.find(item => item.id === id)
    if (!result) throw new Error(`生成参考素材不存在：${id}`)
    return { ...result }
  }
  const mode = args.mode as VideoGenerationMode
  const singleKeys = ['prompt', 'seconds', 'firstFrameAssetId', 'lastFrameAssetId', 'references']
  if (mode === 'storyboard' ? singleKeys.some(key => args[key] !== undefined) || !args.shots : args.shots !== undefined || !args.prompt) throw new Error('分镜模式仅使用 shots；其他模式需提供 prompt，并在顶层设置时长与参考素材。')
  const inputs = mode === 'storyboard' ? args.shots as ShotInput[] : [args as unknown as ShotInput]
  const shots: VideoGenerationShot[] = inputs.map((shot, index) => ({
    id: newId('shot'), title: shot.title ?? `镜头 ${index + 1}`, prompt: shot.prompt,
    seconds: shot.seconds ?? (shot.references?.some(ref => ref.kind === 'video' && ref.includeAudio) ? 2 : 1),
    ...(shot.firstFrameAssetId ? { firstFrame: asset(shot.firstFrameAssetId) } : {}),
    ...(shot.lastFrameAssetId ? { lastFrame: asset(shot.lastFrameAssetId) } : {}),
    ...(shot.references ? { references: shot.references.map(ref => ({ asset: asset(ref.assetId)!, kind: ref.kind, ...(ref.includeAudio !== undefined ? { includeAudio: ref.includeAudio } : {}) })) } : {}),
  }))
  const request: VideoGenerationRequest = {
    requestId: newId('video-generation'), modelId: args.modelId as string, mode,
    width: args.width as number | undefined ?? 512, height: args.height as number | undefined ?? 512,
    steps: args.steps as number | undefined ?? 20, seed: args.seed as number | undefined ?? 42,
    lowMemory: args.lowMemory as boolean | undefined ?? true, joinShots: args.joinShots as boolean | undefined ?? true, shots,
  }
  const error = videoGenerationRequestError(request)
  if (error) throw new Error(error)
  const insertion = args.insert as Partial<McpVideoInsertion> | undefined
  const insert = insertion ? { start: insertion.start ?? 0, mode: insertion.mode ?? 'shots', ...(insertion.trackId ? { trackId: insertion.trackId } : {}) } : undefined
  if (insert?.mode === 'combined' && !request.joinShots && request.shots.length > 1) throw new Error('插入合并视频需要 joinShots=true。')
  if (insert?.trackId) {
    const track = project.tracks.find(item => item.id === insert.trackId)
    if (!track || track.kind !== 'video') throw new Error('请选择已有视频轨道，或省略 trackId 自动新建生成视频轨道。')
    if (track.locked) throw new Error('请先解锁目标视频轨道。')
  }
  return { request, insert }
}

/** Build a detached transaction only after all requested shots have succeeded. */
export function applyMcpVideoGeneration(project: Project, job: VideoGenerationJob, request: VideoGenerationRequest, insert?: McpVideoInsertion) {
  if (job.state !== 'completed' || job.assets.length !== request.shots.length || job.assets.some(asset => asset.kind !== 'video')) throw new Error('生成结果不完整，未修改工程。')
  const assets = [...job.assets, ...(job.combinedAsset && !job.assets.some(asset => asset.id === job.combinedAsset!.id) ? [job.combinedAsset] : [])]
  let next = adoptFirstVideoSize(addAssets(project, assets), job.assets)
  const clipIds: string[] = []
  let trackId: string | undefined
  if (insert) {
    let items = job.assets
    if (insert.mode === 'combined') {
      const combined = job.combinedAsset ?? (job.assets.length === 1 ? job.assets[0] : undefined)
      if (!combined) throw new Error('合并视频尚未完成，未修改工程。')
      items = [combined]
    }
    trackId = insert.trackId
    if (!trackId) { const track = createTrack('video', '生成视频'); next = addTrack(next, track); trackId = track.id }
    let start = insert.start
    const clips = items.map(item => { const clip = createClip(item, next, { start }); start += clipDuration(clip); clipIds.push(clip.id); return clip })
    next = addClips(next, trackId, clips)
  }
  const metadata = assets.map(({ url: _url, sourceUrl: _sourceUrl, nativePath: _path, ...item }) => item)
  return { project: next, assets, result: { nativeJobId: job.id, assetIds: job.assets.map(asset => asset.id), ...(job.combinedAsset ? { combinedAssetId: job.combinedAsset.id } : {}), assets: metadata, clipIds, ...(trackId ? { trackId } : {}) } }
}
