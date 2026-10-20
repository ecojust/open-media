import type { MediaAsset, Project } from './core/types.ts'
import { validateProject } from './core/project.ts'
import { fetchAssetBlob, readStoredAssetBlob } from './core/storage.ts'
import { ensureMediaPreview } from './core/media-import.ts'
import { createMediaPreview, isDesktop } from './native.ts'

export const PROJECT_ASSET_CHUNK_BYTES = 1024 * 1024
export interface NativeProjectPrepareOptions {
  blobs?: Map<string, Blob>
  signal?: AbortSignal
  onProgress?: (completed: number, total: number, name: string) => void
}
const materializedBlobs = new WeakMap<Blob, MediaAsset>()
const materializedUrls = new Map<string, MediaAsset>()

function check(signal?: AbortSignal): void { signal?.throwIfAborted() }
function immutableSource(asset: MediaAsset): string | undefined {
  const source = asset.sourceUrl || asset.url
  // Object and data URLs identify immutable contents; network URLs can change.
  return /^(?:blob:|data:)/.test(source) ? `${source}\n${asset.size}\n${asset.mime}` : undefined
}
function withNativePath(asset: MediaAsset, stored: MediaAsset): MediaAsset {
  if (!stored.nativePath) throw new Error(`素材“${asset.name}”未返回本地文件路径。`)
  // Storage locations must not change editable metadata, history or dirty state.
  return { ...asset, nativePath: stored.nativePath }
}
async function uploadBlob(blob: Blob, name: string, signal?: AbortSignal): Promise<MediaAsset> {
  check(signal)
  if (!blob.size || !Number.isSafeInteger(blob.size)) throw new Error('素材为空或文件大小无效。')
  const cached = materializedBlobs.get(blob)
  if (cached) return cached
  const { invoke } = await import('@tauri-apps/api/core')
  const { id } = await invoke<{ id: string }>('project_asset_begin', { name, size: blob.size })
  try {
    for (let offset = 0; offset < blob.size; offset += PROJECT_ASSET_CHUNK_BYTES) {
      check(signal)
      const part = blob.slice(offset, Math.min(offset + PROJECT_ASSET_CHUNK_BYTES, blob.size))
      const bytes = new Uint8Array(await part.arrayBuffer())
      check(signal)
      if (bytes.byteLength !== part.size) throw new Error('素材分块内容不完整。')
      const packet = new Uint8Array(8 + bytes.byteLength)
      new DataView(packet.buffer).setBigUint64(0, BigInt(offset), true)
      packet.set(bytes, 8)
      await invoke('project_asset_write', packet, { headers: { 'x-upload-id': id } })
    }
    check(signal)
    const stored = await invoke<MediaAsset>('project_asset_finish', { id })
    if (!stored.nativePath) throw new Error('素材导入未返回本地文件路径。')
    materializedBlobs.set(blob, stored)
    check(signal)
    return stored
  } catch (cause) {
    await invoke('project_asset_cancel', { id }).catch(() => {})
    throw cause
  }
}

/** Materialize only browser-backed assets; ordinary desktop media never crosses IPC. */
export async function materializeProjectAsset(projectId: string, asset: MediaAsset, options: NativeProjectPrepareOptions = {}): Promise<MediaAsset> {
  check(options.signal)
  if (asset.nativePath) return { ...asset }
  if (!isDesktop()) throw new Error('原生项目文件需要桌面端。')
  const cached = options.blobs?.get(asset.id)
  const sourceKey = immutableSource(asset)
  if (cached && materializedBlobs.has(cached)) return withNativePath(asset, materializedBlobs.get(cached)!)
  if (!cached && sourceKey && materializedUrls.has(sourceKey)) return withNativePath(asset, materializedUrls.get(sourceKey)!)
  const sources: (() => Promise<Blob | undefined>)[] = [
    ...(cached ? [() => Promise.resolve(cached)] : []),
    () => fetchAssetBlob(asset, options.signal),
    () => readStoredAssetBlob(projectId, asset.id),
  ]
  let failure: unknown
  for (const source of sources) {
    check(options.signal)
    try {
      const blob = await source()
      check(options.signal)
      if (!blob) continue
      const stored = await uploadBlob(blob, asset.name, options.signal)
      check(options.signal)
      if (cached && blob !== cached) materializedBlobs.set(cached, stored)
      if (sourceKey) {
        materializedUrls.set(sourceKey, stored)
        if (materializedUrls.size > 1000) materializedUrls.delete(materializedUrls.keys().next().value!)
      }
      return withNativePath(asset, stored)
    } catch (cause) { check(options.signal); failure = cause }
  }
  throw new Error(`素材“${asset.name}”读取失败，原件与本地副本均不可用。请恢复原文件或重新导入后再保存；当前项目未被覆盖。`, { cause: failure })
}

/** The archive command receives metadata and authorized paths, never an in-memory ZIP. */
export async function prepareNativeProjectArchive(source: Project, options: NativeProjectPrepareOptions = {}): Promise<Project> {
  check(options.signal)
  const project = validateProject(source, { trusted: true })
  for (let index = 0; index < project.assets.length; index++) {
    const asset = project.assets[index]!
    options.onProgress?.(index, project.assets.length, asset.name)
    const stored = await materializeProjectAsset(project.id, asset, options)
    stored.url = ''; delete stored.sourceUrl
    project.assets[index] = stored
  }
  check(options.signal)
  options.onProgress?.(project.assets.length, project.assets.length, project.title)
  return project
}

export async function restoreNativeProjectAsset(asset: MediaAsset, signal?: AbortSignal): Promise<MediaAsset> {
  check(signal)
  if (!asset.nativePath) throw new Error(`项目素材“${asset.name}”缺少本地文件。`)
  const { convertFileSrc } = await import('@tauri-apps/api/core')
  const original = { ...asset, url: convertFileSrc(asset.nativePath) }
  delete original.sourceUrl
  const ready = await ensureMediaPreview(original, createMediaPreview)
  check(signal)
  return ready
}

/** Native extraction owns the media files; no large Blob copies enter local drafts. */
export async function restoreNativeProjectArchive(value: unknown, signal?: AbortSignal, completeImport = true): Promise<Project> {
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    check(signal)
    const project = validateProject(value, { trusted: true })
    for (let index = 0; index < project.assets.length; index++) {
      check(signal)
      project.assets[index] = await restoreNativeProjectAsset(project.assets[index]!, signal)
    }
    check(signal)
    if (completeImport) await invoke('complete_project_archive_import', { project: value, keep: true })
    return project
  } catch (cause) {
    if (completeImport) await invoke('complete_project_archive_import', { project: value, keep: false }).catch(() => {})
    throw cause
  }
}
