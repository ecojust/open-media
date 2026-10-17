interface BrowserProjectWritable {
  write(data: Blob): Promise<void>
  close(): Promise<void>
  abort(reason?: unknown): Promise<void>
}

export class ProjectSaveLocationError extends Error {
  constructor(cause: unknown) {
    super('原保存位置已失效，文件或所在目录可能已移动、删除。请再次点击“保存”或使用“另存为”重新选择位置；当前项目仍保留。', { cause })
    this.name = 'ProjectSaveLocationError'
  }
}

function saveLocationError(cause: unknown): unknown {
  return !!cause && typeof cause === 'object' && 'name' in cause && cause.name === 'NotFoundError' ? new ProjectSaveLocationError(cause) : cause
}

export interface BrowserProjectFileHandle {
  readonly name: string
  getFile(): Promise<File>
  createWritable(): Promise<BrowserProjectWritable>
  requestPermission?(options: { mode: 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>
}

interface ProjectPickerOptions {
  types: { description: string; accept: Record<string, string[]> }[]
  excludeAcceptAllOption: boolean
}

interface BrowserProjectPickers {
  showOpenFilePicker?(options: ProjectPickerOptions & { multiple: false }): Promise<BrowserProjectFileHandle[]>
  showSaveFilePicker?(options: ProjectPickerOptions & { suggestedName: string }): Promise<BrowserProjectFileHandle>
}

function pickers(): BrowserProjectPickers | undefined {
  return typeof window === 'undefined' ? undefined : window as unknown as BrowserProjectPickers
}

function isCancelled(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
}

// Invoke the picker before yielding so the browser retains the user's click activation.
function choose<T>(open: () => Promise<T>): Promise<T | null> {
  try {
    return open().catch((error: unknown) => {
      if (isCancelled(error)) return null
      throw error
    })
  } catch (error) {
    return isCancelled(error) ? Promise.resolve(null) : Promise.reject(error)
  }
}

export function pickBrowserProjectFile(): Promise<{ file: File; handle: BrowserProjectFileHandle } | null> | undefined {
  const browser = pickers()
  if (typeof browser?.showOpenFilePicker !== 'function') return undefined
  return choose(() => browser.showOpenFilePicker!({
    multiple: false,
    excludeAcceptAllOption: true,
    types: [{ description: '媒体项目', accept: { 'application/zip': ['.omedia', '.zip'] } }],
  })).then(async (handles) => {
    const handle = handles?.[0]
    return handle ? { file: await handle.getFile(), handle } : null
  })
}

export function prepareBrowserProjectSave(name: string, existing?: BrowserProjectFileHandle): Promise<BrowserProjectFileHandle | null> | undefined {
  if (existing) {
    try {
      const permission = existing.requestPermission?.({ mode: 'readwrite' })
      return Promise.resolve(permission).then(async (state) => {
        if (permission && state !== 'granted') throw new Error('未获得项目文件的写入权限，请允许访问后重试，或使用另存为选择其他位置。')
        await existing.getFile()
        return existing
      }).catch(error => { throw saveLocationError(error) })
    } catch (error) { return Promise.reject(saveLocationError(error)) }
  }
  const browser = pickers()
  if (typeof browser?.showSaveFilePicker !== 'function') return undefined
  return choose(() => browser.showSaveFilePicker!({
    suggestedName: /\.omedia$/i.test(name) ? name : `${name}.omedia`,
    excludeAcceptAllOption: true,
    types: [{ description: '媒体项目', accept: { 'application/x-open-media-project': ['.omedia'] } }],
  }))
}

export async function writeBrowserProjectFile(handle: BrowserProjectFileHandle, blob: Blob): Promise<void> {
  let writable: BrowserProjectWritable | undefined
  try {
    writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
  } catch (error) {
    try { await writable?.abort(error) } catch { /* Preserve the original write or close failure. */ }
    throw saveLocationError(error)
  }
}
