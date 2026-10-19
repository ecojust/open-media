import { isDesktop } from './native.ts'
import type { AiJob, AiRequest, AiStatus } from './core/ai.ts'
export type * from './core/ai.ts'

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Error('本地 AI 模型需要桌面端。')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}
async function prepareJob(job: AiJob): Promise<AiJob> {
  const { convertFileSrc } = await import('@tauri-apps/api/core')
  return { ...job, assets: job.assets.map(asset => asset.nativePath ? { ...asset, url: convertFileSrc(asset.nativePath) } : asset) }
}
async function prepareStatus(status: AiStatus): Promise<AiStatus> {
  return { ...status, jobs: await Promise.all(status.jobs.map(prepareJob)) }
}
export async function getAiStatus(probeRuntime = false): Promise<AiStatus> {
  return isDesktop() ? prepareStatus(await call('ai_get_status', { probeRuntime })) : { models: [], jobs: [], busy: false }
}
export async function downloadAiModel(modelId: string, acceptedLicense = false): Promise<AiStatus> { return prepareStatus(await call('ai_model_download', { modelId, acceptedLicense })) }
export async function cancelAiModelDownload(modelId: string): Promise<AiStatus> { return prepareStatus(await call('ai_model_cancel', { modelId })) }
export async function repairAiModel(modelId: string, acceptedLicense = false): Promise<AiStatus> { return prepareStatus(await call('ai_model_repair', { modelId, acceptedLicense })) }
export async function beginAiGeneration(request: AiRequest): Promise<AiJob> { return prepareJob(await call('ai_generate', { request })) }
export async function getAiJob(id: string): Promise<AiJob> { return prepareJob(await call('ai_job_get', { id })) }
export async function cancelAiJob(id: string): Promise<void> { return call('ai_job_cancel', { id }) }
