import { newId, validateProject } from './project.ts'
import { projectDuration } from './timeline.ts'
import type { ImportedProject, MediaAsset, Project, ProjectSummary } from './types.ts'

const DATABASE_NAME = 'open-media-projects'
const DATABASE_VERSION = 1
const pendingSaves = new Map<string, Promise<string>>()
const committedBlobRevisions = new WeakMap<Blob, Map<string, string>>()
type StoredProject = Project & { localDraftRevision?: string }

function rememberStoredBlob(blob: Blob, key: string, revision: string | undefined): void {
  if (typeof revision !== 'string' || !revision) return
  let revisions = committedBlobRevisions.get(blob)
  if (!revisions) { revisions = new Map(); committedBlobRevisions.set(blob, revisions) }
  revisions.set(key, revision)
}

function storedSaveTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? value : undefined
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error ?? new Error('无法读取本地项目。')) })
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('本地保存已中断，项目未覆盖。'))
    transaction.onerror = () => { /* The abort event reports the atomic transaction failure. */ }
  })
}

async function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw new Error('当前环境不支持本地项目存储，请使用保存项目文件。')
  return new Promise((resolve, reject) => {
    const pending = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    pending.onupgradeneeded = () => {
      const db = pending.result
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs')
    }
    pending.onsuccess = () => { pending.result.onversionchange = () => pending.result.close(); resolve(pending.result) }
    pending.onerror = () => reject(pending.error ?? new Error('无法打开本地项目存储。'))
    pending.onblocked = () => reject(new Error('本地存储正被其他窗口使用，请关闭旧窗口后重试。'))
  })
}

const blobKey = (projectId: string, assetId: string): string => `${projectId}:${assetId}`

export async function fetchAssetBlob(asset: MediaAsset, signal?: AbortSignal): Promise<Blob> {
  const url = asset.sourceUrl || asset.url
  if (!url) throw new Error(`素材“${asset.name}”不可读取，请重新导入。`)
  try {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`素材“${asset.name}”读取失败（${response.status}）。`)
    const blob = await response.blob()
    if (!blob.size) throw new Error(`素材“${asset.name}”为空，项目未保存。`)
    return blob.type || !asset.mime ? blob : blob.slice(0, blob.size, asset.mime)
  } catch (cause) {
    signal?.throwIfAborted()
    throw new Error(`素材“${asset.name}”读取失败，请确认原文件仍可访问，或重新导入后再保存。`, { cause })
  }
}

/** Read a saved copy without changing the active project or its object URLs. */
export async function readStoredAssetBlob(projectId: string, assetId: string): Promise<Blob | undefined> {
  if (!globalThis.indexedDB) return undefined
  const db = await openDatabase()
  try {
    const reading = db.transaction('blobs', 'readonly')
    const [value] = await Promise.all([request(reading.objectStore('blobs').get(blobKey(projectId, assetId))), completed(reading)])
    return value instanceof Blob ? value : undefined
  } finally { db.close() }
}

/** Media reads finish before a single atomic database write begins. */
export function saveProject(project: Project, blobs: Map<string, Blob> = new Map()): Promise<string> {
  const snapshot = validateProject(project, { trusted: true })
  const suppliedBlobs = new Map(blobs)
  const previous = pendingSaves.get(project.id) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(() => saveProjectNow(snapshot, suppliedBlobs))
  pendingSaves.set(project.id, task)
  void task.then(() => { if (pendingSaves.get(project.id) === task) pendingSaves.delete(project.id) }, () => { if (pendingSaves.get(project.id) === task) pendingSaves.delete(project.id) })
  return task
}

async function saveProjectNow(project: Project, blobs: Map<string, Blob>): Promise<string> {
  const clean = project
  const db = await openDatabase()
  try {
    const durable = new Set(clean.assets.filter((asset) => asset.nativePath && asset.url && !asset.url.startsWith('blob:') && !asset.sourceUrl?.startsWith('blob:')).map((asset) => asset.id))
    const unsupplied = clean.assets.filter((asset) => !blobs.has(asset.id) && !durable.has(asset.id))
    const existing = new Set<string>()
    if (unsupplied.length) {
      const reading = db.transaction('blobs', 'readonly')
      const readDone = completed(reading)
      // Existence checks must not deserialize every original media file on each edit.
      const keys = unsupplied.map((asset) => request(reading.objectStore('blobs').getKey(blobKey(clean.id, asset.id))))
      const [values] = await Promise.all([Promise.all(keys), readDone])
      values.forEach((key, index) => { if (key !== undefined) existing.add(unsupplied[index]!.id) })
    }
    const pending = new Map<string, Blob>()
    for (const asset of clean.assets) {
      const provided = blobs.get(asset.id)
      if (provided) {
        if (!provided.size) throw new Error(`素材“${asset.name}”为空，项目未保存。`)
        pending.set(asset.id, provided)
      } else if (!durable.has(asset.id) && !existing.has(asset.id)) pending.set(asset.id, await fetchAssetBlob(asset))
      if (!durable.has(asset.id)) { asset.url = ''; delete asset.sourceUrl; delete asset.nativePath }
    }
    const writing = db.transaction(['projects', 'blobs'], 'readwrite')
    const writeDone = completed(writing)
    const blobStore = writing.objectStore('blobs')
    try {
      const projectStore = writing.objectStore('projects')
      const oldProject = await request(projectStore.get(clean.id)) as StoredProject | undefined
      // Blobs are immutable. Reuse only an identical instance from the current committed
      // revision, checked inside this write transaction so another window cannot race it.
      const reusable = [...pending].filter(([assetId, blob]) => oldProject?.localDraftRevision && committedBlobRevisions.get(blob)?.get(blobKey(clean.id, assetId)) === oldProject.localDraftRevision)
      const reusableKeys = await Promise.all(reusable.map(([assetId]) => request(blobStore.getKey(blobKey(clean.id, assetId)))))
      const retainedBlobs = new Set(reusable.filter((_, index) => reusableKeys[index] !== undefined).map(([assetId]) => assetId))
      for (const [assetId, blob] of pending) if (!retainedBlobs.has(assetId)) blobStore.put(blob, blobKey(clean.id, assetId))
      const retained = new Set(clean.assets.map((asset) => asset.id))
      for (const asset of oldProject?.assets ?? []) if (!retained.has(asset.id)) blobStore.delete(blobKey(clean.id, asset.id))
      const savedAt = new Date().toISOString(), revision = newId()
      projectStore.put({ ...clean, localDraftSavedAt: savedAt, localDraftRevision: revision })
      await writeDone
      for (const [assetId, blob] of pending) rememberStoredBlob(blob, blobKey(clean.id, assetId), revision)
      return savedAt
    } catch (error) {
      try { writing.abort() } catch { /* A failed write may have already aborted the transaction. */ }
      await writeDone.catch(() => {})
      throw error
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if ((error as DOMException)?.name === 'QuotaExceededError') throw new Error('本地存储空间不足，项目未覆盖。请清理旧项目，或保存便携项目文件。', { cause: error })
    throw new Error(`保存失败：${reason}`, { cause: error })
  } finally { db.close() }
}

export async function loadProject(id: string): Promise<ImportedProject & { savedAt?: string }> {
  const db = await openDatabase()
  const urls: string[] = []
  try {
    const reading = db.transaction(['projects', 'blobs'], 'readonly')
    const done = completed(reading)
    const raw = await request(reading.objectStore('projects').get(id))
    if (!raw) { await done; throw new Error('未找到此本地项目。') }
    const project = validateProject(raw, { trusted: true })
    const values = await Promise.all(project.assets.map((asset) => request(reading.objectStore('blobs').get(blobKey(id, asset.id)))))
    await done
    const blobs = new Map<string, Blob>()
    project.assets.forEach((asset, index) => {
      const blob = values[index] as Blob | undefined
      if (blob) {
        blobs.set(asset.id, blob)
        if (!asset.nativePath || !asset.url || asset.url.startsWith('blob:')) {
          asset.url = URL.createObjectURL(blob)
          if (!asset.nativePath) delete asset.sourceUrl
          urls.push(asset.url)
        }
      } else if (!asset.nativePath || !asset.url) throw new Error(`素材“${asset.name}”在本地存储中缺失，无法完整打开项目。`)
    })
    for (const [assetId, blob] of blobs) rememberStoredBlob(blob, blobKey(id, assetId), raw.localDraftRevision)
    const savedAt = storedSaveTime(raw.localDraftSavedAt)
    return { project, blobs, ...(savedAt ? { savedAt } : {}), revoke: () => { urls.splice(0).forEach((url) => URL.revokeObjectURL(url)) } }
  } catch (error) { urls.forEach((url) => URL.revokeObjectURL(url)); throw error } finally { db.close() }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const db = await openDatabase()
  try {
    const transaction = db.transaction('projects', 'readonly')
    const done = completed(transaction)
    const projects = await request(transaction.objectStore('projects').getAll()) as Project[]
    await done
    return projects.map((project) => ({ id: project.id, title: project.title, width: project.width, height: project.height, duration: projectDuration(project), updatedAt: project.updatedAt, assetCount: project.assets.length })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } finally { db.close() }
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDatabase()
  try {
    const transaction = db.transaction(['projects', 'blobs'], 'readwrite')
    const done = completed(transaction)
    const project = await request(transaction.objectStore('projects').get(id)) as Project | undefined
    for (const asset of project?.assets ?? []) transaction.objectStore('blobs').delete(blobKey(id, asset.id))
    transaction.objectStore('projects').delete(id)
    await done
  } finally { db.close() }
}
