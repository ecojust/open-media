import type { MediaAsset, Project } from './core/types'
import { cloneProject } from './core/project'
import { prepareNativeProject } from './core/native-project'
import { cancelMediaJob, getMediaJobs, isDesktop, type MediaJob } from './native'
import { mediaToolError } from './core/media-tool-error'
import type { EditorToolProgress } from './core/editor-tool-service'

export interface TimelinePreviewOptions {
  audioOnly?: boolean
  width?: number
  fps?: number
  signal?: AbortSignal
  onProgress?: (update: EditorToolProgress) => void
}
export interface TimelinePreviewArtifact { asset: MediaAsset; discard: () => Promise<void> }
export interface TimelineFrameArtifact extends TimelinePreviewArtifact { pngBase64: string }
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
  if (![start, end].every(Number.isFinite) || start < 0 || end <= start || end-start > 60) throw new Error('预览区间需大于零且最多 60 秒。')
  return runPreview(project, start, end, options, false)
}
export async function runTimelineFrame(project: Project, time: number, options: Omit<TimelinePreviewOptions, 'audioOnly' | 'fps'> = {}): Promise<TimelineFrameArtifact> {
  if (!Number.isFinite(time) || time < 0) throw new Error('取帧时间无效。')
  return runPreview(project, time, time, options, true) as Promise<TimelineFrameArtifact>
}
async function runPreview(project: Project, start: number, end: number, options: TimelinePreviewOptions, frameOnly: boolean): Promise<TimelinePreviewArtifact & { pngBase64?: string }> {
  if (!isDesktop()) throw new Error('区间预览文件需要桌面端媒体引擎。')
  const { signal, onProgress } = options
  signal?.throwIfAborted(); onProgress?.({ progress: 0, stage: '正在准备预览素材' })
  const source = cloneProject(project)
  // Text/annotation layers contain no audio; omit rasterization for audio-only
  // requests while retaining video clips because they may contain source audio.
  let prepared: Awaited<ReturnType<typeof prepareNativeProject>>
  const maxEdge = frameOnly ? 1920 : 1280
  const rasterScale = Math.min(1, (options.width ?? Math.min(640, project.width)) / project.width, maxEdge / project.height, maxEdge / project.width)
  try { prepared = await prepareNativeProject(source, signal, {
    skipText: options.audioOnly, visualOnly: frameOnly, range: { start, ...(frameOnly ? {} : { end }) }, rasterScale,
    onProgress: update => onProgress?.({ ...update, progress: (update.progress ?? 0) * .1 }),
  }) }
  catch (cause) { throw previewError('素材及字幕准备', cause) }
  signal?.throwIfAborted()
  let jobId: string | undefined
  let accepted = false
  const cancel = () => { if (jobId) void cancelMediaJob(jobId).catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  let stage = '原生画面合成'
  try {
    onProgress?.({ progress: .1, stage: '正在建立区间合成任务' })
    const job = await call<MediaJob>('begin_tool_preview', { spec: { ...prepared, start, ...(frameOnly ? { frameOnly: true } : { end }), audioOnly: options.audioOnly ?? false, ...(options.width !== undefined ? { width: options.width } : {}), ...(options.fps !== undefined ? { fps: options.fps } : {}) } })
    jobId = job.id
    signal?.throwIfAborted()
    const deadline = Date.now() + 10 * 60_000
    let current = job
    while (current.state === 'running') {
      signal?.throwIfAborted()
      if (Date.now() > deadline) throw new Error('区间预览处理超时，请缩短区间后重试。')
      onProgress?.({ progress: .1 + .89 * Math.max(0, Math.min(1, current.progress)), stage: current.stage || '正在生成预览',
        ...(current.encodedFrames !== undefined ? { encodedFrames: current.encodedFrames } : {}),
        ...(current.outputTime !== undefined ? { outputTime: current.outputTime } : {}),
        ...(current.elapsedSeconds !== undefined ? { elapsedSeconds: current.elapsedSeconds } : {}),
      })
      await abortableDelay(signal)
      current = (await getMediaJobs()).find(item => item.id === job.id) ?? (() => { throw new Error('预览任务已丢失。') })()
    }
    if (current.state !== 'completed') throw current.state === 'cancelled' ? new DOMException('预览已取消', 'AbortError') : new Error(current.error || '预览生成失败。')
    signal?.throwIfAborted()
    stage = frameOnly ? 'PNG 字节读取' : '预览文件读取'
    const { pngBase64, ...asset } = await call<MediaAsset & { pngBase64?: string }>('tool_preview_result', { id: job.id })
    signal?.throwIfAborted()
    if (frameOnly) {
      if (typeof pngBase64 !== 'string' || !pngBase64 || pngBase64.length > Math.ceil(16 * 1024 * 1024 / 3) * 4) throw new Error('原生 PNG 数据缺失或超过大小上限。')
      asset.url = ''
    } else {
      const { convertFileSrc } = await import('@tauri-apps/api/core')
      signal?.throwIfAborted()
      if (!asset.nativePath) throw new Error('预览文件路径缺失。')
      asset.url = convertFileSrc(asset.nativePath)
    }
    onProgress?.({ progress: 1, stage: '预览已就绪',
      ...(current.encodedFrames !== undefined ? { encodedFrames: current.encodedFrames } : {}),
      ...(current.outputTime !== undefined ? { outputTime: current.outputTime } : {}),
      ...(current.elapsedSeconds !== undefined ? { elapsedSeconds: current.elapsedSeconds } : {}),
    })
    accepted = true
    let discarded = false
    return { asset, ...(frameOnly ? { pngBase64 } : {}), discard: async () => { if (discarded) return; await call('tool_preview_discard', { id: job.id }); discarded = true } }
  } catch (cause) { throw previewError(stage, cause) } finally {
    signal?.removeEventListener('abort', cancel)
    if (jobId && !accepted) { await cancelMediaJob(jobId).catch(() => {}); await call('tool_preview_discard', { id: jobId }).catch(() => {}) }
  }
}

function previewError(stage: string, cause: unknown): Error {
  return mediaToolError(stage, cause)
}
