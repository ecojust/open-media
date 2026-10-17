import type { AssetKind, MediaAsset } from './types.ts'

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif', 'svg', 'ico'])
const audioExtensions = new Set(['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac', 'opus', 'aif', 'aiff', 'wma'])
const videoExtensions = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi', 'mpeg', 'mpg', 'wmv', 'ts'])

export function fileExtension(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase()
}

export function mediaKind(name: string, mime = ''): AssetKind {
  const extension = fileExtension(name)
  if (mime.startsWith('image/') || imageExtensions.has(extension)) return 'image'
  if (mime.startsWith('audio/') || audioExtensions.has(extension)) return 'audio'
  if (mime.startsWith('video/') || videoExtensions.has(extension)) return 'video'
  throw new Error(`无法识别「${name}」的媒体类型。`)
}

function mediaId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

async function probeImage(url: string): Promise<{ width: number; height: number; duration: number }> {
  const image = new Image()
  image.src = url
  await image.decode()
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('无法读取图片尺寸。')
  return { width: image.naturalWidth, height: image.naturalHeight, duration: 0 }
}

async function probeMedia(url: string, kind: AssetKind): Promise<{ width: number; height: number; duration: number }> {
  const media = document.createElement(kind === 'audio' ? 'audio' : 'video')
  media.preload = 'metadata'
  media.muted = true
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('读取媒体超时，请尝试其他文件或使用桌面版。')), 15_000)
      function finish(error?: Error) {
        clearTimeout(timer)
        media.onloadedmetadata = null
        media.onerror = null
        error ? reject(error) : resolve()
      }
      media.onloadedmetadata = () => finish()
      media.onerror = () => finish(new Error('当前环境无法解码这个媒体文件；桌面版可导入更多格式。'))
      media.src = url
    })
    if (!Number.isFinite(media.duration)) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('无法读取媒体时长。请先使用桌面版转换文件。')), 8000)
        function finish(error?: Error) {
          clearTimeout(timer)
          media.ondurationchange = null
          media.onseeked = null
          error ? reject(error) : resolve()
        }
        media.ondurationchange = () => { if (Number.isFinite(media.duration)) finish() }
        media.onseeked = () => { if (Number.isFinite(media.duration)) finish() }
        media.currentTime = 1e10
      })
    }
    if (!Number.isFinite(media.duration) || media.duration <= 0) throw new Error('媒体文件没有可用时长。')
    const video = media as HTMLVideoElement
    return { width: kind === 'video' ? video.videoWidth : 0, height: kind === 'video' ? video.videoHeight : 0, duration: media.duration }
  } finally {
    media.removeAttribute('src')
    media.load()
  }
}

export async function importMediaFile(file: File, nativePath?: string): Promise<MediaAsset> {
  if (!file.size) throw new Error(`「${file.name}」是空文件。`)
  const kind = mediaKind(file.name, file.type)
  const url = URL.createObjectURL(file)
  try {
    const dimensions = kind === 'image' ? await probeImage(url) : await probeMedia(url, kind)
    return { id: mediaId(), name: file.name, kind, url, size: file.size, mime: file.type, nativePath, ...dimensions }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw new Error(`导入「${file.name}」失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Check real decoding instead of inferring playback support from a filename. */
export function canPreviewMedia(asset: MediaAsset, timeoutMs = 12000): Promise<boolean> {
  if (asset.kind === 'image') {
    return new Promise(resolve => {
      const image = new Image()
      const timer = setTimeout(() => finish(false), timeoutMs)
      const finish = (supported: boolean) => {
        clearTimeout(timer)
        image.onload = null
        image.onerror = null
        image.removeAttribute('src')
        resolve(supported)
      }
      image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0)
      image.onerror = () => finish(false)
      image.crossOrigin = 'anonymous'
      image.src = asset.url
    })
  }
  return new Promise(resolve => {
    const media = document.createElement(asset.kind === 'audio' ? 'audio' : 'video')
    const timer = setTimeout(() => finish(false), timeoutMs)
    const finish = (supported: boolean) => {
      clearTimeout(timer)
      media.onloadeddata = null
      media.onerror = null
      media.pause()
      media.removeAttribute('src')
      media.load()
      resolve(supported)
    }
    media.onloadeddata = () => finish(true)
    media.onerror = () => finish(false)
    media.muted = true
    media.preload = 'auto'
    media.crossOrigin = 'anonymous'
    media.src = asset.url
  })
}

export type MediaPreviewFormat = 'mp4' | 'webm' | 'png' | 'wav'

export function mediaPreviewFormats(kind: AssetKind): MediaPreviewFormat[] {
  if (kind === 'image') return ['png']
  if (kind === 'audio') return ['wav']
  const player = document.createElement('video')
  const mp4 = player.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')
  const webm = player.canPlayType('video/webm; codecs="vp8, opus"')
  return !mp4 && webm ? ['webm', 'mp4'] : ['mp4', 'webm']
}

export async function ensureMediaPreview(asset: MediaAsset, makePreview: (asset: MediaAsset, format: MediaPreviewFormat) => Promise<string>): Promise<MediaAsset> {
  if (await canPreviewMedia(asset)) return asset
  let failure = ''
  for (const format of mediaPreviewFormats(asset.kind)) {
    try {
      const url = await makePreview(asset, format)
      const prepared: MediaAsset = { ...asset, sourceUrl: asset.sourceUrl || asset.url, url }
      if (await canPreviewMedia(prepared)) return prepared
      if (url.startsWith('blob:') && url !== asset.url && url !== asset.sourceUrl) URL.revokeObjectURL(url)
      failure = `${format.toUpperCase()} 预览无法解码。`
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(`「${asset.name}」无法生成当前环境可播放的兼容预览。${failure}原始素材未修改。`)
}

export function revokeMediaAsset(asset: MediaAsset): void {
  if (asset.url.startsWith('blob:')) URL.revokeObjectURL(asset.url)
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
