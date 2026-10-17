import { isDesktop, writeClipboardImage } from '../native'

const MAX_CLIPBOARD_PIXELS = 40_000_000
type ImageSource = string | Blob | Promise<Blob>
let activeCopy: AbortController | undefined
let nativeWriteQueue: Promise<void> = Promise.resolve()

function waitForCopy<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason) }
    pending.then(value => { signal.removeEventListener('abort', cancel); resolve(value) }, cause => { signal.removeEventListener('abort', cancel); reject(cause) })
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
}

async function withImageCanvas<T>(source: Promise<string | Blob>, signal: AbortSignal, use: (canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) => Promise<T>): Promise<T> {
  const value = await waitForCopy(source, signal)
  signal.throwIfAborted()
  const ownedUrl = typeof value !== 'string'
  const url = ownedUrl ? URL.createObjectURL(value) : value
  const image = new Image()
  image.decoding = 'async'
  image.crossOrigin = 'anonymous'
  let canvas: HTMLCanvasElement | undefined
  try {
    image.src = url
    await waitForCopy(image.decode(), signal)
    signal.throwIfAborted()
    const width = image.naturalWidth, height = image.naturalHeight
    if (!width || !height) throw new Error('图片没有有效像素，请重新选择图片。')
    if (width * height > MAX_CLIPBOARD_PIXELS) throw new Error('复制图片最多支持 4000 万像素，请减小尺寸后重试。')
    canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('无法读取图片像素，请重新打开图片。')
    context.drawImage(image, 0, 0)
    return await use(canvas, context)
  } finally {
    image.src = ''
    if (ownedUrl) URL.revokeObjectURL(url)
    if (canvas) { canvas.width = 0; canvas.height = 0 }
  }
}

/** Start the browser write during the click, while image preparation resolves asynchronously. */
export async function copyImageToClipboard(source: ImageSource, native = isDesktop(), signal?: AbortSignal): Promise<void> {
  const pending = Promise.resolve(source)
  // A supplied conversion can fail even if clipboard access is unavailable or cancelled.
  void pending.catch(() => {})
  signal?.throwIfAborted()
  activeCopy?.abort()
  const controller = new AbortController()
  activeCopy = controller
  const cancel = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', cancel, { once: true })
  const copySignal = controller.signal
  try {
    if (native) {
      await withImageCanvas(pending, copySignal, async (canvas, context) => {
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
        // Finish any dispatched write first, then skip superseded requests before IPC.
        const write = nativeWriteQueue.then(async () => {
          copySignal.throwIfAborted()
          await writeClipboardImage(pixels.width, pixels.height, pixels.data, copySignal)
        })
        nativeWriteQueue = write.catch(() => {})
        await waitForCopy(write, copySignal)
      })
      copySignal.throwIfAborted()
      return
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      throw new Error('当前环境不支持复制图片，请使用桌面端或支持剪贴板的安全网页。')
    }
    const png = withImageCanvas(pending, copySignal, async canvas => {
      const blob = await waitForCopy(new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法生成剪贴板图片，请减小尺寸后重试。')), 'image/png')), copySignal)
      copySignal.throwIfAborted()
      return blob
    })
    void png.catch(() => {})
    await waitForCopy(navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]), copySignal)
    copySignal.throwIfAborted()
  } finally {
    // Clipboard permission can fail before its promised PNG has finished decoding.
    // Stop that preparation even when the platform rejects the write immediately.
    controller.abort()
    signal?.removeEventListener('abort', cancel)
    if (activeCopy === controller) activeCopy = undefined
  }
}

export function imageClipboardError(cause: unknown): string {
  if (cause instanceof DOMException) {
    if (cause.name === 'NotAllowedError') return '未获准写入剪贴板，请回到当前窗口点击“复制图片”重试。'
    if (cause.name === 'SecurityError') return '无法读取这张图片的像素，请导入本地图片后重试。'
    if (cause.name === 'AbortError') return '已取消复制。'
    if (cause.name === 'EncodingError') return '无法读取图片内容，请重新打开图片后重试。'
  }
  return cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '复制图片失败，请重试。'
}
