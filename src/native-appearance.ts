type AppearanceTheme = 'light' | 'dark'
interface AppearanceWindow {
  label: string
  setBackgroundColor(color: string): Promise<void>
}
interface AppearanceOptions {
  getWindow?: () => Promise<AppearanceWindow | null>
  warn?: (cause: unknown) => void
}

async function mainWindow(): Promise<AppearanceWindow | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null
  const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  return getCurrentWebviewWindow()
}

export function createNativeAppearanceSync(options: AppearanceOptions = {}) {
  const getWindow = options.getWindow ?? mainWindow
  const warn = options.warn ?? ((cause: unknown) => console.warn('[Open Media] 窗口背景同步失败。', cause))
  let pending: AppearanceTheme | undefined
  let active: Promise<void> | undefined
  let applied: string | undefined
  let warned = false, disposed = false

  function sync(theme: AppearanceTheme): Promise<void> {
    if (disposed) return Promise.resolve()
    pending = theme
    if (!active) {
      active = Promise.resolve().then(async () => {
        while (!disposed && pending) {
          let selected = pending
          pending = undefined
          try {
            const target = await getWindow()
            if (disposed || !target || target.label !== 'main') { pending = undefined; return }
            // Keep only the newest theme while the native bridge is loading.
            selected = pending ?? selected
            pending = undefined
            const color = selected === 'dark' ? '#151923' : '#f7f9fc'
            if (color === applied) continue
            // This updates both the native window and its webview. Complete the pair
            // before applying another theme so a stale request cannot finish last.
            await target.setBackgroundColor(color)
            applied = color
          } catch (cause) {
            if (!warned) { warned = true; warn(cause) }
          }
        }
      }).finally(() => {
        active = undefined
        if (!disposed && pending) void sync(pending)
      })
    }
    return active
  }

  return { sync, dispose() { disposed = true; pending = undefined } }
}
