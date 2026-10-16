import type { BrowserCaptureSelection, BrowserCaptureSource } from './capture'

export const DEFAULT_SCREENSHOT_SHORTCUT = 'CommandOrControl+Shift+2'
export interface ScreenshotKeyboardEvent {
  key: string
  code?: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  repeat?: boolean
  isComposing?: boolean
}
export interface BrowserScreenshotResult { blob: Blob; name: string; width: number; height: number }
export interface BrowserScreenshotSelectionRequest { source: BrowserCaptureSource; imageUrl: string; signal: AbortSignal }
export interface BrowserScreenshotOptions {
  signal?: AbortSignal
  chooseSource?: (request: BrowserScreenshotSelectionRequest) => Promise<BrowserCaptureSelection | null>
}

export function isAppleKeyboard(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
}
function shortcutKey(event: ScreenshotKeyboardEvent): string | null {
  if (/^Key[A-Z]$/.test(event.code ?? '')) return event.code!.slice(3)
  if (/^Digit[0-9]$/.test(event.code ?? '')) return event.code!.slice(5)
  const key = event.key.toUpperCase()
  return /^[A-Z0-9]$/.test(key) || /^F(?:[1-9]|1[0-9]|20)$/.test(key) ? key : null
}
export function screenshotShortcutFromEvent(event: ScreenshotKeyboardEvent, apple = isAppleKeyboard()): string | null {
  if (event.isComposing || event.repeat || !(event.ctrlKey || event.altKey || event.metaKey)) return null
  const key = shortcutKey(event)
  if (!key) return null
  const modifiers: string[] = []
  if (event.metaKey) modifiers.push(apple ? 'Cmd' : 'Meta')
  if (event.ctrlKey) modifiers.push('Ctrl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  return [...modifiers, key].join('+')
}
export function screenshotShortcutValidationError(shortcut: string | null): string {
  if (!shortcut) return ''
  const parts = shortcut.toLowerCase().split('+').map(part => part.trim())
  const key = parts.pop()
  const primary = parts.some(part => ['control', 'ctrl', 'cmd', 'command', 'meta', 'super', 'commandorcontrol', 'cmdorctrl'].includes(part))
  if (!primary || parts.some(part => part === 'alt' || part === 'option')) return ''
  const action = key === 's' ? parts.includes('shift') ? '另存为' : '保存' : key === 'o' ? '打开' : key === 'z' ? parts.includes('shift') ? '重做' : '撤销' : key === 'y' ? '重做' : ''
  return action ? `此快捷键用于${action}，请选择其他组合。` : ''
}
export function screenshotShortcutLabel(shortcut: string | null, apple = isAppleKeyboard()): string {
  if (!shortcut) return '未启用'
  return shortcut.split('+').map(value => {
    if (/^(CommandOrControl|CmdOrCtrl)$/i.test(value)) return apple ? '⌘' : 'Ctrl'
    if (/^(Cmd|Command|Meta|Super)$/i.test(value)) return apple ? '⌘' : 'Win'
    if (/^(Control|Ctrl)$/i.test(value)) return apple ? '⌃' : 'Ctrl'
    if (/^(Option|Alt)$/i.test(value)) return apple ? '⌥' : 'Alt'
    if (/^Shift$/i.test(value)) return apple ? '⇧' : 'Shift'
    return value.toUpperCase()
  }).join(apple ? ' ' : ' + ')
}
export function matchesScreenshotShortcut(event: ScreenshotKeyboardEvent, shortcut: string | null, apple = isAppleKeyboard()): boolean {
  if (!shortcut || event.repeat || event.isComposing) return false
  const parts = shortcut.toLowerCase().split('+'), key = parts.pop()
  let ctrl = false, alt = false, shift = false, meta = false
  for (const modifier of parts) {
    if (modifier === 'commandorcontrol' || modifier === 'cmdorctrl') { if (apple) meta = true; else ctrl = true }
    else if (modifier === 'control' || modifier === 'ctrl') ctrl = true
    else if (modifier === 'alt' || modifier === 'option') alt = true
    else if (modifier === 'shift') shift = true
    else if (['cmd', 'command', 'meta', 'super'].includes(modifier)) meta = true
    else return false
  }
  return (ctrl || alt || meta) && event.ctrlKey === ctrl && event.altKey === alt && event.shiftKey === shift && event.metaKey === meta && shortcutKey(event)?.toLowerCase() === key
}
export function browserScreenshotAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia
}
export function screenshotErrorMessage(cause: unknown): string {
  if (cause instanceof DOMException) {
    if (cause.name === 'AbortError') return ''
    if (cause.name === 'NotAllowedError') return '未获得截屏权限，请允许共享需要截取的画面后重试。'
    if (cause.name === 'NotReadableError') return '无法读取截屏画面，请检查系统权限后重试。'
  }
  return cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '截屏失败，请重试。'
}
function abortedScreenshot(): DOMException { return new DOMException('已取消截屏。', 'AbortError') }

/** A screenshot owns its display stream and releases every track once the PNG is ready. */
export async function takeBrowserScreenshot(options: BrowserScreenshotOptions = {}): Promise<BrowserScreenshotResult> {
  if (options.signal?.aborted) throw abortedScreenshot()
  if (!browserScreenshotAvailable()) throw new Error('此浏览器无法截屏，请在桌面端使用截屏功能。')
  // Request sharing synchronously so a click or keyboard activation is still available.
  const request = navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
  const stopStream = (stream: MediaStream) => stream.getTracks().forEach(track => track.stop())
  const abort = new AbortController()
  const cancel = () => abort.abort(abortedScreenshot())
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) cancel()
  function wait<T>(pending: Promise<T>, discard?: (value: T) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false
      const cancelled = () => { if (!settled) { settled = true; reject(abortedScreenshot()) } }
      pending.then(value => {
        abort.signal.removeEventListener('abort', cancelled)
        if (settled) { discard?.(value); return }
        settled = true; resolve(value)
      }, cause => {
        abort.signal.removeEventListener('abort', cancelled)
        if (!settled) { settled = true; reject(cause) }
      })
      abort.signal.addEventListener('abort', cancelled, { once: true })
      if (abort.signal.aborted) cancelled()
    })
  }
  let stream: MediaStream | undefined
  let video: HTMLVideoElement | undefined
  let track: MediaStreamTrack | undefined
  let previewUrl: string | undefined
  try {
    stream = await wait(request, stopStream)
    track = stream.getVideoTracks().find(value => value.readyState === 'live')
    if (!track) throw new Error('没有可用的截屏画面，请重新选择来源。')
    track.addEventListener('ended', cancel, { once: true })
    video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    const sourceVideo = video
    await new Promise<void>((resolve, reject) => {
      const clear = () => {
        clearTimeout(timer)
        sourceVideo.removeEventListener('loadeddata', ready)
        sourceVideo.removeEventListener('error', failed)
        abort.signal.removeEventListener('abort', cancelled)
      }
      const ready = () => { if (sourceVideo.readyState >= 2 && sourceVideo.videoWidth > 0 && sourceVideo.videoHeight > 0) { clear(); resolve() } }
      const failed = () => { clear(); reject(new Error('无法读取截屏画面，请重新选择来源。')) }
      const cancelled = () => { clear(); reject(abortedScreenshot()) }
      const timer = setTimeout(failed, 15000)
      sourceVideo.addEventListener('loadeddata', ready)
      sourceVideo.addEventListener('error', failed)
      abort.signal.addEventListener('abort', cancelled, { once: true })
      void sourceVideo.play().then(ready, failed)
      if (abort.signal.aborted) cancelled()
      else ready()
    })
    const settings = track.getSettings()
    const source = {
      type: settings.displaySurface === 'monitor' ? 'screen' as const : settings.displaySurface === 'window' ? 'window' as const : settings.displaySurface === 'browser' ? 'tab' as const : 'unknown' as const,
      label: track.label || '所选截屏来源', width: video.videoWidth, height: video.videoHeight,
      outputWidth: video.videoWidth, outputHeight: video.videoHeight,
    }
    const original = document.createElement('canvas')
    original.width = source.width; original.height = source.height
    const originalContext = original.getContext('2d')
    if (!originalContext) throw new Error('无法创建截屏图片。')
    originalContext.drawImage(video, 0, 0)
    track.removeEventListener('ended', cancel)
    stopStream(stream)
    video.pause(); video.srcObject = null
    let selected: BrowserCaptureSelection | undefined
    if (options.chooseSource) {
      const previewBlob = await wait(new Promise<Blob>((resolve, reject) => original.toBlob(value => value ? resolve(value) : reject(new Error('无法生成截屏预览。')), 'image/png')))
      previewUrl = URL.createObjectURL(previewBlob)
      const result = await wait(options.chooseSource({ source, imageUrl: previewUrl, signal: abort.signal }))
      if (!result) throw abortedScreenshot()
      selected = result
    }
    if (abort.signal.aborted) throw abortedScreenshot()
    const { width: sourceWidth, height: sourceHeight } = original
    const region = selected?.region ?? { x: 0, y: 0, width: sourceWidth, height: sourceHeight }
    if (![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 || region.x + region.width > sourceWidth || region.y + region.height > sourceHeight) throw new Error('截屏范围已超出当前画面，请重新选择。')
    const canvas = document.createElement('canvas')
    canvas.width = region.width; canvas.height = region.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建截屏图片。')
    context.drawImage(original, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height)
    const blob = await wait(new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法生成截屏图片。')), 'image/png')))
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return { blob, name: `截屏-${stamp}.png`, width: region.width, height: region.height }
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    track?.removeEventListener('ended', cancel)
    if (video) { video.pause(); video.srcObject = null; video.remove() }
    if (stream) stopStream(stream)
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    if (!abort.signal.aborted) abort.abort(abortedScreenshot())
  }
}
