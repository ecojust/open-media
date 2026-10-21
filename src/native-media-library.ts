import type { MediaAsset } from './core/types'
import { isDesktop } from './native'

export type WorkspaceMediaCategory = 'recording' | 'screenshot' | 'videogen' | 'imagegen' | 'musicgen'
export interface WorkspaceMediaLibrary {
  directories: Partial<Record<WorkspaceMediaCategory, string>>
  assets: MediaAsset[]
  warnings: string[]
}

export async function listWorkspaceAssets(categories: readonly WorkspaceMediaCategory[]): Promise<WorkspaceMediaLibrary> {
  if (!isDesktop()) throw new Error('本机素材目录由桌面端提供。')
  const { invoke, convertFileSrc } = await import('@tauri-apps/api/core')
  const result = await invoke<Omit<WorkspaceMediaLibrary, 'assets'> & { assets: (Omit<MediaAsset, 'addedAt'> & { addedAt?: number | string })[] }>('list_workspace_assets', { categories: [...new Set(categories)] })
  return { ...result, assets: result.assets.map(asset => ({ ...asset,
    addedAt: typeof asset.addedAt === 'number' && Number.isFinite(asset.addedAt) ? new Date(asset.addedAt).toISOString() : typeof asset.addedAt === 'string' ? asset.addedAt : undefined,
    url: asset.nativePath ? convertFileSrc(asset.nativePath) : asset.url,
  })) }
}

export async function openWorkspaceDirectory(category: WorkspaceMediaCategory): Promise<void> {
  if (!isDesktop()) throw new Error('本机素材目录由桌面端提供。')
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('open_workspace_directory', { category })
}
