export type DesktopPlatform = 'windows' | 'macos' | 'linux' | 'other'

/** Read the desktop host instead of inferring it from the webview's user agent. */
export async function getDesktopPlatform(): Promise<DesktopPlatform | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const platform = await invoke<unknown>('get_desktop_platform')
    if (platform === 'windows' || platform === 'macos' || platform === 'linux') return platform
    return typeof platform === 'string' && platform ? 'other' : null
  } catch {
    // Retain the in-app identity when a host cannot report its native platform.
    return null
  }
}
