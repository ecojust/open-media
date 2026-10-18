import type { MediaAsset, Project } from './core/types'
import { cloneProject } from './core/project'
import { prepareNativeProject } from './core/native-project'
import { cancelMediaJob, getMediaJobs, isDesktop, type MediaJob } from './native'

export interface TimelinePreviewOptions {
  audioOnly?: boolean
  width?: number
  fps?: number
  signal?: AbortSignal
  onProgress?: (update: { progress?: number; stage: string }) => void
}
export interface TimelinePreviewArtifact { asset: MediaAsset; discard: () => Promise<void> }
async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Error('区间预览文件需要桌面端媒体引擎。')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}
function abortableDelay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = window.setTimeout(done, 160)
    const abort = () => { window.clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('预览已取消', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
  })
}
/** Generates a temporary artifact; it is never registered as project media. */
export async function runTimelinePreview(project: Project, start: number, end: number, options: TimelinePreviewOptions = {}): Promise<TimelinePreviewArtifact> {
  if (!isDesktop()) throw new Error('区间预览文件需要桌面端媒体引擎。')
  if (![start, end].every(Number.isFinite) || start < 0 || end <= start || end-start > 60) throw new Error('预览区间需大于零且最多 60 秒。')
  const { signal, onProgress } = options
  signal?.throwIfAborted(); onProgress?.({ progress: 0, stage: '正在准备预览素材' })
  const source = cloneProject(project)
  // Text/annotation layers contain no audio; omit rasterization for audio-only
  // requests while retaining video clips because they may contain source audio.
  const prepared = await prepareNativeProject(source, signal, { skipText: options.audioOnly })
  signal?.throwIfAborted()
  let jobId: string | undefined
  let accepted = false
  const cancel = () => { if (jobId) void cancelMediaJob(jobId).catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const job = await call<MediaJob>('begin_tool_preview', { spec: { ...prepared, start, end, audioOnly: options.audioOnly ?? false, ...(options.width !== undefined ? { width: options.width } : {}), ...(options.fps !== undefined ? { fps: options.fps } : {}) } })
    jobId = job.id
    signal?.throwIfAborted()
    const deadline = Date.now() + 10 * 60_000
    let current = job
    while (current.state === 'running') {
      signal?.throwIfAborted()
      if (Date.now() > deadline) throw new Error('区间预览处理超时，请缩短区间后重试。')
      onProgress?.({ progress: Math.max(0, Math.min(.99, current.progress)), stage: current.stage || '正在生成预览' })
      await abortableDelay(signal)
      current = (await getMediaJobs()).find(item => item.id === job.id) ?? (() => { throw new Error('预览任务已丢失。') })()
    }
    if (current.state !== 'completed') throw current.state === 'cancelled' ? new DOMException('预览已取消', 'AbortError') : new Error(current.error || '预览生成失败。')
    signal?.throwIfAborted()
    const asset = await call<MediaAsset>('tool_preview_result', { id: job.id })
    signal?.throwIfAborted()
    const { convertFileSrc } = await import('@tauri-apps/api/core')
    signal?.throwIfAborted()
    if (!asset.nativePath) throw new Error('预览文件路径缺失。')
    asset.url = convertFileSrc(asset.nativePath)
    onProgress?.({ progress: 1, stage: '预览已就绪' })
    accepted = true
    let discarded = false
    return { asset, discard: async () => { if (discarded) return; await call('tool_preview_discard', { id: job.id }); discarded = true } }
  } finally {
    signal?.removeEventListener('abort', cancel)
    if (jobId && !accepted) { await cancelMediaJob(jobId).catch(() => {}); await call('tool_preview_discard', { id: jobId }).catch(() => {}) }
  }
}
