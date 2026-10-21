import type { MediaAsset, Project, ProjectSummary } from './core/types.ts'
import { validateProject } from './core/project.ts'
import { projectDuration } from './core/timeline.ts'
import { isDesktop } from './native.ts'
import { materializeProjectAsset, restoreNativeProjectAsset, type NativeProjectPrepareOptions } from './native-project-files.ts'

export interface ProjectMediaPrepareOptions extends NativeProjectPrepareOptions {
  /** Reject a late result after switching projects or cancelling an external operation. */
  assertCurrent?: () => void
  /** Check disk files again when recovering a document from outside this session. */
  verifyFiles?: boolean
  /** Receive the actual draft write time when loading, independently of the last edit. */
  onSavedAt?: (savedAt: string) => void
}
export interface SavedManagedProject { directory: string; savedAt: string }
interface PreparedAsset { assetId: string; nativePath: string; size: number }
interface PreparedProjectMedia { directory: string; assets: PreparedAsset[] }

// Membership is granted only by successful native preparation or a verified disk load.
// Ordinary edits and autosaves then inspect metadata, without copying/reading media again.
const preparedProjects = new Map<string, Map<string, string>>()
function sourceKey(asset: MediaAsset): string { return JSON.stringify([asset.nativePath, asset.size]) }
function check(options: ProjectMediaPrepareOptions): void { options.signal?.throwIfAborted(); options.assertCurrent?.() }
function remember(project: Project): void {
  const assets = preparedProjects.get(project.id) ?? new Map<string, string>()
  for (const asset of project.assets) assets.set(asset.id, sourceKey(asset))
  preparedProjects.set(project.id, assets)
  // Keep the active libraries small while allowing undo/redo and recent-project switching.
  if (preparedProjects.size > 100) preparedProjects.delete(preparedProjects.keys().next().value!)
}

export function isProjectMediaPrepared(project: Project): boolean {
  if (!isDesktop()) return true
  const assets = preparedProjects.get(project.id)
  return !!assets && project.assets.every(asset => !!asset.nativePath && assets.get(asset.id) === sourceKey(asset))
}

/** Copy accepted source files into this project's directory before publishing an edit. */
export async function prepareProjectMedia(source: Project, options: ProjectMediaPrepareOptions = {}): Promise<Project> {
  check(options)
  const project = validateProject(source, { trusted: true })
  if (!isDesktop() || (!options.verifyFiles && isProjectMediaPrepared(project))) return project
  const { invoke, convertFileSrc } = await import('@tauri-apps/api/core')
  for (let index = 0; index < project.assets.length; index++) {
    check(options)
    options.onProgress?.(index, project.assets.length, project.assets[index]!.name)
    project.assets[index] = await materializeProjectAsset(project.id, project.assets[index]!, options)
    check(options)
  }
  // Even an empty project receives its own directory. Native copies stream on a worker.
  const prepared = await invoke<PreparedProjectMedia>('ensure_project_media', { projectId: project.id, assets: project.assets })
  check(options)
  const locations = new Map(prepared.assets.map(asset => [asset.assetId, asset]))
  if (locations.size !== project.assets.length) throw new Error('工程素材收录结果不完整，当前工程未被替换。')
  const owned: MediaAsset[] = []
  for (const asset of project.assets) {
    const stored = locations.get(asset.id)
    if (!stored?.nativePath || !Number.isSafeInteger(stored.size) || stored.size <= 0) throw new Error(`素材“${asset.name}”未能收录到工程目录。`)
    const originalUrl = convertFileSrc(stored.nativePath)
    if (asset.sourceUrl && /^(?:blob:|data:)/.test(asset.url)) {
      const restored = await restoreNativeProjectAsset({ ...asset, nativePath: stored.nativePath, size: stored.size }, options.signal)
      check(options)
      owned.push(restored)
      continue
    }
    // Preserve an existing compatible preview; its source now points to the owned original.
    owned.push(asset.sourceUrl
      ? { ...asset, nativePath: stored.nativePath, size: stored.size, sourceUrl: originalUrl }
      : { ...asset, nativePath: stored.nativePath, size: stored.size, url: originalUrl })
  }
  project.assets = owned
  check(options)
  remember(project)
  options.onProgress?.(project.assets.length, project.assets.length, project.title)
  return project
}

/** Disk mirror stores metadata and references to owned media, never an in-memory archive. */
export async function saveManagedProject(project: Project): Promise<SavedManagedProject> {
  if (!isDesktop()) return { directory: '', savedAt: new Date().toISOString() }
  if (!isProjectMediaPrepared(project)) throw new Error('工程素材尚未收录完成，请等待后再保存。')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<SavedManagedProject>('save_managed_project', { project, duration: projectDuration(project) })
}

export async function listManagedProjects(): Promise<ProjectSummary[]> {
  if (!isDesktop()) return []
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<ProjectSummary[]>('list_managed_projects')
}

export async function loadManagedProject(projectId: string, options: ProjectMediaPrepareOptions = {}): Promise<Project> {
  check(options)
  if (!isDesktop()) throw new Error('工程文件夹需要桌面端。')
  const { invoke } = await import('@tauri-apps/api/core')
  const value = await invoke<unknown>('load_managed_project', { projectId })
  check(options)
  const project = validateProject(value, { trusted: true })
  const metadataSavedAt = value && typeof value === 'object' ? (value as Record<string, unknown>).localDraftSavedAt : undefined
  const savedAt = typeof metadataSavedAt === 'string' && Number.isFinite(Date.parse(metadataSavedAt)) ? metadataSavedAt : project.updatedAt
  if (project.id !== projectId) throw new Error('工程标识与请求不一致。')
  for (let index = 0; index < project.assets.length; index++) {
    project.assets[index] = await restoreNativeProjectAsset(project.assets[index]!, options.signal)
    check(options)
  }
  options.onSavedAt?.(savedAt)
  remember(project)
  return project
}

/** Removing a draft deliberately retains owned assets for files, snapshots and history. */
export async function removeManagedProjectDraft(projectId: string): Promise<void> {
  if (!isDesktop()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('remove_managed_project_draft', { projectId })
  preparedProjects.delete(projectId)
}
