type AppearanceTheme = 'light' | 'dark'
interface AppearanceWindow {
  label: string
  setTheme(theme: AppearanceTheme | null): Promise<void>
  setBackgroundColor(color: string): Promise<void>
}
interface AppearanceRequest {
  theme: AppearanceTheme
  nativeTheme: AppearanceTheme | null
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
  const warn = options.warn ?? ((cause: unknown) => console.warn('[Open Media] 窗口外观同步失败。', cause))
  let pending: AppearanceRequest | undefined
  let active: Promise<void> | undefined
  let applied: AppearanceRequest | undefined
  let warned = false, disposed = false

  function sync(theme: AppearanceTheme, followSystem = false): Promise<void> {
    if (disposed) return Promise.resolve()
    pending = { theme, nativeTheme: followSystem ? null : theme }
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
            if (selected.theme === applied?.theme && selected.nativeTheme === applied.nativeTheme) continue
            const color = selected.theme === 'dark' ? '#151923' : '#f7f9fc'
            // A partial failure must not leave an older successful theme cached.
            applied = undefined
            // Native title contrast needs the appearance as well as the background.
            // System mode clears the override so native media queries keep following it.
            await target.setTheme(selected.nativeTheme)
            if (disposed) return
            // Finish the window/webview background update before the next appearance.
            await target.setBackgroundColor(color)
            applied = selected
          } catch (cause) {
            if (!warned) { warned = true; warn(cause) }
          }
        }
      }).finally(() => {
        active = undefined
        if (!disposed && pending) return sync(pending.theme, pending.nativeTheme === null)
      })
    }
    return active
  }

  return { sync, dispose() { disposed = true; pending = undefined } }
}
