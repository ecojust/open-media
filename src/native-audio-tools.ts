import { isDesktop } from './native.ts'
import type { MediaAsset } from './core/types.ts'

export interface AudioToolJob {
  id: string
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  stage: string
  result?: Record<string, unknown> & { asset?: MediaAsset }
  error?: string
}
async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Error('离线音频处理需要桌面端。')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}
async function ready(job: AudioToolJob): Promise<AudioToolJob> {
  if (job.result?.asset?.nativePath) {
    const { convertFileSrc } = await import('@tauri-apps/api/core')
    job.result.asset = { ...job.result.asset, url: convertFileSrc(job.result.asset.nativePath) }
  }
  return job
}
export async function beginAudioTool(spec: Record<string, unknown>): Promise<AudioToolJob> { return ready(await call('audio_tool_begin', { spec })) }
export async function getAudioTool(id: string): Promise<AudioToolJob> { return ready(await call('audio_tool_status', { id })) }
export async function cancelAudioTool(id: string): Promise<void> { return call('audio_tool_cancel', { id }) }
export async function acceptAudioTool(id: string): Promise<void> { return call('audio_tool_accept', { id }) }
export async function discardAudioTool(id: string): Promise<void> { return call('audio_tool_discard', { id }) }
