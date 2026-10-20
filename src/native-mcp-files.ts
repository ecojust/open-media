import type { MediaAsset, Project } from './core/types'
import { ensureMediaPreview } from './core/media-import'
import { createMediaPreview, importBlobAsset, isDesktop, type MediaJob, type MediaJobSpec, type ProjectFileTarget, type NativeProjectArchive } from './native'

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Error('MCP 文件操作需要桌面端。')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

async function readyAsset(asset: MediaAsset): Promise<MediaAsset> {
  if (!asset.nativePath) return asset
  const { convertFileSrc } = await import('@tauri-apps/api/core')
  return ensureMediaPreview({ ...asset, url: convertFileSrc(asset.nativePath) }, createMediaPreview)
}

/** Import only paths explicitly supplied to an authenticated editing request. */
export async function importMcpMediaPaths(paths: string[]): Promise<MediaAsset[]> {
  const assets = await call<MediaAsset[]>('mcp_import_media_paths', { paths })
  const ready: MediaAsset[] = []
  for (const asset of assets) ready.push(await readyAsset(asset))
  return ready
}

export interface McpProjectSaveOptions { token?: string; path?: string; overwrite?: boolean }
export async function saveMcpProjectFile(project: Project, options: McpProjectSaveOptions = {}): Promise<ProjectFileTarget> {
  return call('mcp_save_project_archive', {
    project, token: options.token ?? null, path: options.path ?? null, overwrite: options.overwrite ?? false,
  })
}

export async function openMcpProjectFile(path: string): Promise<NativeProjectArchive> {
  return call('mcp_open_project_archive', { path })
}

async function localAsset(asset: MediaAsset): Promise<MediaAsset> {
  if (asset.nativePath) return asset
  const response = await fetch(asset.sourceUrl || asset.url)
  if (!response.ok) throw new Error(`无法读取素材：${asset.name}`)
  const imported = await importBlobAsset(new Uint8Array(await response.arrayBuffer()), asset.name)
  return { ...imported, id: asset.id }
}

/** Uses an explicit path and never opens a system save dialog. */
export async function beginMcpMediaJob(spec: MediaJobSpec, outputPath: string, overwrite = false): Promise<MediaJob> {
  if (spec.kind !== 'timeline') throw new Error('MCP 导出需要当前视频项目。')
  const assets: MediaAsset[] = []
  for (const asset of spec.project.assets) assets.push(await localAsset(asset))
  const textAssets: Record<string, MediaAsset> = {}
  for (const [id, asset] of Object.entries(spec.textAssets ?? {})) textAssets[id] = await localAsset(asset)
  return call('mcp_begin_media_job', {
    spec: { ...spec, project: { ...spec.project, assets }, textAssets }, outputPath, overwrite,
  })
}
