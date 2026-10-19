import type { Project } from './types.ts'
import { TimelinePreview, previewDuration } from './preview.ts'

export interface BrowserVideoExportOptions {
  width?: number
  height?: number
  fps?: number
  videoBitsPerSecond?: number
  signal?: AbortSignal
  onProgress?: (progress: number) => void
}

export function browserVideoExportSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function'
}

/** Browser encoding runs in real time and produces an actual WebM container. */
export async function exportTimelineWebM(project: Project, options: BrowserVideoExportOptions = {}): Promise<Blob> {
  if (!browserVideoExportSupported()) throw new Error('当前浏览器不支持视频导出，请使用桌面端')
  if (options.signal?.aborted) throw new DOMException('已取消导出', 'AbortError')
  const duration = previewDuration(project)
  if (!(duration > 0)) throw new Error('请先将素材添加到时间线')
  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type))
  if (!mimeType) throw new Error('当前浏览器没有可用的视频编码器，请使用桌面端')
  const width = Math.round(options.width || project.width)
  const height = Math.round(options.height || project.height)
  const fps = options.fps || project.fps
  if (width < 16 || width > 7680 || height < 16 || height > 7680 || fps < 1 || fps > 120) throw new Error('导出尺寸或帧率超出支持范围')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  let mediaError: string | undefined
  const preview = new TimelinePreview(canvas, project, error => { mediaError = error })
  let stream: MediaStream | undefined
  let recorder: MediaRecorder | undefined
  let frame = 0
  let abortListener: (() => void) | undefined
  let visibilityListener: (() => void) | undefined
  try {
    await preview.prepare(options.signal)
    await preview.seekReady(0, options.signal)
    if (options.signal?.aborted) throw new DOMException('已取消导出', 'AbortError')
    const audioStream = await preview.enableAudio(false, options.signal)
    await preview.playReady(0, options.signal)
    if (options.signal?.aborted) throw new DOMException('已取消导出', 'AbortError')
    stream = canvas.captureStream(fps)
    const audibleAssetIds = new Set(project.assets.filter(asset => asset.kind === 'audio' || asset.kind === 'video').map(asset => asset.id))
    const hasAudibleMedia = project.tracks.some(track => !track.muted && track.kind !== 'text'
      && track.clips.some(clip => clip.volume > 0 && !!clip.assetId && audibleAssetIds.has(clip.assetId)))
    // An unconnected audio destination produces no packets and can stall video-only recordings.
    if (hasAudibleMedia) for (const track of audioStream.getAudioTracks()) stream.addTrack(track)
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: options.videoBitsPerSecond || 8_000_000, audioBitsPerSecond: 192_000 })
    const chunks: BlobPart[] = []
    const recording = recorder
    const blob = await new Promise<Blob>((resolve, reject) => {
      let completed = false
      const stop = (error?: Error | DOMException) => {
        if (completed) return
        completed = true
        cancelAnimationFrame(frame)
        preview.pause()
        if (recording.state !== 'inactive') recording.stop()
        if (error) reject(error)
      }
      abortListener = () => stop(new DOMException('已取消导出', 'AbortError'))
      options.signal?.addEventListener('abort', abortListener, { once: true })
      visibilityListener = () => { if (document.visibilityState === 'hidden') stop(new Error('浏览器导出需要保持页面前台，请返回页面后重新导出')) }
      document.addEventListener('visibilitychange', visibilityListener)
      recording.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
      recording.onerror = () => stop(new Error('视频编码失败，请尝试较低的分辨率'))
      recording.onstop = () => {
        if (options.signal?.aborted) reject(new DOMException('已取消导出', 'AbortError'))
        else if (!chunks.length) reject(new Error('没有生成视频数据，请重试'))
        else resolve(new Blob(chunks, { type: 'video/webm' }))
      }
      recording.start(250)
      const started = performance.now()
      const tick = () => {
        if (completed) return
        if (mediaError) { stop(new Error(mediaError)); return }
        const time = Math.min(duration, (performance.now() - started) / 1000)
        preview.render(Math.min(time, Math.max(0, duration - 0.001)), time < duration)
        options.onProgress?.(Math.min(1, time / duration))
        if (time >= duration) stop()
        else frame = requestAnimationFrame(tick)
      }
      tick()
    })
    options.onProgress?.(1)
    return blob
  } finally {
    cancelAnimationFrame(frame)
    if (abortListener) options.signal?.removeEventListener('abort', abortListener)
    if (visibilityListener) document.removeEventListener('visibilitychange', visibilityListener)
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    stream?.getTracks().forEach(track => track.stop())
    preview.dispose()
  }
}
