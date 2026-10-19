import { isDesktop } from './native.ts'
import type { MediaAsset } from './core/types.ts'
import type { VideoGenerationJob, VideoGenerationRequest, VideoGenerationStatus } from './core/video-generation.ts'
export type * from './core/video-generation.ts'

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Error('本地视频生成需要桌面端。')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}
async function assetUrl(asset: MediaAsset): Promise<MediaAsset> {
  if (!asset.nativePath) return asset
  const { convertFileSrc } = await import('@tauri-apps/api/core')
  return { ...asset, url: convertFileSrc(asset.nativePath) }
}
async function prepareJob(job: VideoGenerationJob): Promise<VideoGenerationJob> {
  return { ...job, assets: await Promise.all(job.assets.map(assetUrl)), combinedAsset: job.combinedAsset ? await assetUrl(job.combinedAsset) : undefined }
}
export async function getVideoGenerationStatus(): Promise<VideoGenerationStatus> {
  return isDesktop() ? call('get_video_generation_status') : { supported: false, runtimeReady: false, reason: '本地视频生成需要 Apple 芯片 Mac 桌面端。', models: [] }
}
export async function beginVideoModelDownload(modelId: string, acceptedLicense: boolean): Promise<VideoGenerationStatus> { return call('begin_video_model_download', { modelId, acceptedLicense }) }
export async function cancelVideoModelDownload(modelId: string): Promise<VideoGenerationStatus> { return call('cancel_video_model_download', { modelId }) }
export async function beginVideoGeneration(request: VideoGenerationRequest): Promise<VideoGenerationJob> { return prepareJob(await call('begin_video_generation', { request })) }
export async function getVideoGenerationJob(id: string): Promise<VideoGenerationJob> { return prepareJob(await call('get_video_generation_job', { id })) }
export async function listVideoGenerationJobs(): Promise<VideoGenerationJob[]> { return isDesktop() ? Promise.all((await call<VideoGenerationJob[]>('list_video_generation_jobs')).map(prepareJob)) : [] }
export async function cancelVideoGeneration(id: string): Promise<void> { return call('cancel_video_generation', { id }) }
