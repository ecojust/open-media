import type { Project, MediaAsset } from './core/types.ts'
import type { EditorToolProgress } from './core/editor-tool-service.ts'
import { prepareNativeProject } from './core/native-project.ts'
import { mediaToolError } from './core/media-tool-error.ts'
import { cancelMediaJob, getMediaJobs, isDesktop, type MediaJob } from './native.ts'

export interface RenderedMotionClip {
  asset: MediaAsset
  accept: () => Promise<void>
  discard: () => Promise<void>
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Error('原生效果片段编码需要桌面端。')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

function delay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(done, 160)
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new DOMException('已取消生成效果片段', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

/** Encodes an isolated composition; the caller commits the returned video once. */
export async function renderMotionClip(project: Project, signal?: AbortSignal, onProgress?: (update: EditorToolProgress) => void): Promise<RenderedMotionClip> {
  if (!isDesktop()) throw new Error('原生效果片段编码需要桌面端。')
  signal?.throwIfAborted()
  let scopeId: string | undefined, jobId: string | undefined
  let handedOff = false, accepted = false, discarded = false
  let stage = '准备效果片段素材'
  const cancel = () => { if (jobId) void cancelMediaJob(jobId).catch(() => {}) }
  const discard = async () => {
    if (accepted || discarded || !scopeId) return
    await call('discard_motion_clip', { id: jobId ?? scopeId })
    discarded = true
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    onProgress?.({ stage, progress: 0 })
    // Always await allocation before checking abort so a late scope can be discarded.
    scopeId = await call<string>('create_motion_clip_scope', {})
    signal?.throwIfAborted()
    const prepared = await prepareNativeProject(project, signal, {
      importAsset: async (bytes, name) => {
        signal?.throwIfAborted()
        const asset = await call<MediaAsset>('import_motion_clip_asset', { scopeId, bytes: Array.from(bytes), name })
        signal?.throwIfAborted()
        return asset
      },
      onProgress: update => onProgress?.({ ...update, progress: (update.progress ?? 0) * .12 }),
    })
    signal?.throwIfAborted()
    stage = '编码效果片段'
    onProgress?.({ stage, progress: .12 })
    const launched = await call<MediaJob>('begin_motion_clip_render', { spec: {
      scopeId, ...prepared,
      config: { format: 'mp4', width: Math.floor(project.width / 2) * 2, height: Math.floor(project.height / 2) * 2, fps: project.fps, quality: 'high' },
    } })
    // A cancellation during launch must still cancel and clean the eventual child.
    jobId = launched.id
    signal?.throwIfAborted()
    let job = launched
    const deadline = Date.now() + 60 * 60_000
    while (job.state === 'running') {
      signal?.throwIfAborted()
      if (Date.now() > deadline) throw new Error('效果片段生成超时，请减少素材数量或时长后重试。')
      onProgress?.({ stage: job.stage ? `效果片段 · ${job.stage}` : stage, progress: .12 + .84 * Math.max(0, Math.min(1, job.progress)),
        ...(job.encodedFrames !== undefined ? { encodedFrames: job.encodedFrames } : {}),
        ...(job.outputTime !== undefined ? { outputTime: job.outputTime } : {}),
        ...(job.elapsedSeconds !== undefined ? { elapsedSeconds: job.elapsedSeconds } : {}),
      })
      await delay(signal)
      job = (await getMediaJobs()).find(item => item.id === jobId) ?? (() => { throw new Error('效果片段编码任务已丢失。') })()
    }
    if (job.state !== 'completed') throw job.state === 'cancelled' ? new DOMException('已取消生成效果片段', 'AbortError') : new Error(job.error || '效果片段编码失败。')
    signal?.throwIfAborted()
    stage = '校验效果片段'
    onProgress?.({ stage, progress: .97 })
    const asset = await call<MediaAsset>('motion_clip_result', { id: jobId })
    signal?.throwIfAborted()
    if (!asset.nativePath || asset.kind !== 'video' || !asset.id || !(asset.duration > 0) || !(asset.size > 0)) throw new Error('效果片段没有返回完整的视频文件。')
    const { convertFileSrc } = await import('@tauri-apps/api/core')
    signal?.throwIfAborted()
    asset.url = convertFileSrc(asset.nativePath)
    onProgress?.({ stage: '效果片段已生成', progress: 1 })
    signal?.throwIfAborted()
    handedOff = true
    return { asset, discard, accept: async () => {
      if (discarded) throw new Error('效果片段已取消，不能添加到工程。')
      if (accepted) return
      await call('accept_motion_clip', { id: jobId })
      accepted = true
    } }
  } catch (cause) { throw mediaToolError(stage, cause) }
  finally {
    signal?.removeEventListener('abort', cancel)
    if (!handedOff) {
      if (jobId) await cancelMediaJob(jobId).catch(() => {})
      await discard().catch(() => {})
    }
  }
}
