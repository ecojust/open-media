import { cloneProject, newId, validateProject } from './project.ts'
import { exportProjectFile, importProjectFile, MAX_PORTABLE_BYTES, type ProjectExportOptions } from './project-file.ts'
import type { ImportedProject, Project } from './types.ts'

const DATABASE = 'open-media-project-snapshots'
export const SNAPSHOT_LIMITS = Object.freeze({ count: 100, totalBytes: 1024 * 1024 * 1024, mediaBytes: MAX_PORTABLE_BYTES })
export interface ProjectSnapshotSummary {
  id: string; projectId: string; name: string; createdAt: string; bytes: number; assetCount: number; trackCount: number; clipCount: number
  sourceRevision?: number
}
interface SnapshotRecord extends ProjectSnapshotSummary { project: Project; assetHashes: Record<string, string>; storageBytes: number }
export interface SnapshotContext extends ProjectExportOptions { assertCurrent?: () => void; sourceRevision?: number }

function check(options: SnapshotContext = {}): void {
  if (options.signal?.aborted) throw new DOMException('项目版本操作已取消。', 'AbortError')
  options.assertCurrent?.()
}
function identifier(value: string): void { if (!/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error('项目或版本标识无效。') }
function summary(record: SnapshotRecord): ProjectSnapshotSummary {
  const { id, projectId, name, createdAt, bytes, assetCount, trackCount, clipCount, sourceRevision } = record
  return { id, projectId, name, createdAt, bytes, assetCount, trackCount, clipCount, ...(sourceRevision !== undefined ? { sourceRevision } : {}) }
}
async function database(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw new Error('当前环境不支持本地项目版本存储，请保存便携项目文件。')
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      const records = request.result.createObjectStore('versions', { keyPath: 'id' })
      records.createIndex('projectId', 'projectId')
      request.result.createObjectStore('archives')
    }
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result) }
    request.onerror = () => reject(request.error ?? new Error('无法打开本地项目版本存储。'))
    request.onblocked = () => reject(new Error('项目版本存储正在升级，请关闭其他旧窗口后重试。'))
  })
}
function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error('读取项目版本失败。')) })
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('项目版本存储事务已取消。'))
    transaction.onerror = () => {}
  })
}
function validatedRecord(value: unknown, projectId?: string): SnapshotRecord {
  if (!value || typeof value !== 'object') throw new Error('项目版本不存在或存储损坏。')
  const item = value as SnapshotRecord
  identifier(item.id); identifier(item.projectId)
  if (projectId && item.projectId !== projectId) throw new Error('该版本属于其他工程。')
  if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120 || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > MAX_PORTABLE_BYTES + 5 * 1024 * 1024 || !Number.isSafeInteger(item.storageBytes) || item.storageBytes < item.bytes || !item.assetHashes || typeof item.assetHashes !== 'object') throw new Error('项目版本存储损坏。')
  const project = validateProject(item.project)
  if (project.id !== item.projectId || project.assets.length !== item.assetCount || project.tracks.length !== item.trackCount || project.tracks.reduce((count, track) => count + track.clips.length, 0) !== item.clipCount) throw new Error('项目版本清单不一致。')
  if (project.assets.some(asset => !/^[a-f0-9]{64}$/.test(item.assetHashes[asset.id] ?? ''))) throw new Error('项目版本缺少素材校验信息。')
  return { ...item, project }
}
async function describeImported(imported: ImportedProject, options: SnapshotContext): Promise<{ project: Project; assetHashes: Record<string, string> }> {
  const assetHashes: Record<string, string> = Object.create(null)
  for (const [id, blob] of imported.blobs) {
    check(options)
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    assetHashes[id] = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  }
  const project = cloneProject(imported.project)
  for (const asset of project.assets) { asset.url = ''; delete asset.sourceUrl; delete asset.nativePath }
  return { project, assetHashes }
}
async function manifest(archive: Blob, options: SnapshotContext): Promise<{ project: Project; assetHashes: Record<string, string> }> {
  const imported = await importProjectFile(archive)
  try { return await describeImported(imported, options) } finally { imported.revoke() }
}

/** Persist a complete portable archive, never an object URL or a pointer to a temporary file. */
export async function createProjectSnapshot(project: Project, name: string, options: SnapshotContext = {}): Promise<ProjectSnapshotSummary> {
  if (typeof name !== 'string' || !name.trim() || name.length > 120 || /[\0-\x1f]/.test(name)) throw new Error('版本名称需要 1 至 120 个字符，不能包含控制字符。')
  if (options.sourceRevision !== undefined && (!Number.isSafeInteger(options.sourceRevision) || options.sourceRevision < 0)) throw new Error('项目版本号无效。')
  const source = validateProject(cloneProject(project), { trusted: true })
  const blobs = options.blobs ? new Map(options.blobs) : undefined
  check(options)
  const archive = await exportProjectFile(source, { ...options, blobs })
  const described = await manifest(archive, options)
  check(options)
  const record: SnapshotRecord = { id: newId('snapshot'), projectId: source.id, name: name.trim(), createdAt: new Date().toISOString(), bytes: archive.size,
    assetCount: described.project.assets.length, trackCount: described.project.tracks.length, clipCount: described.project.tracks.reduce((count, track) => count + track.clips.length, 0),
    ...(options.sourceRevision !== undefined ? { sourceRevision: options.sourceRevision } : {}), ...described, storageBytes: 0 }
  record.storageBytes = archive.size + new Blob([JSON.stringify(record)]).size + 64
  const db = await database()
  try {
    check(options)
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['versions', 'archives'], 'readwrite')
      let failure: unknown
      const abort = () => { failure = new DOMException('项目版本操作已取消。', 'AbortError'); try { transaction.abort() } catch {} }
      const cleanup = () => options.signal?.removeEventListener('abort', abort)
      transaction.oncomplete = () => { cleanup(); resolve() }
      transaction.onabort = () => { cleanup(); reject(failure ?? transaction.error ?? new Error('项目版本未写入，请检查本地存储空间。')) }
      transaction.onerror = () => {}
      options.signal?.addEventListener('abort', abort, { once: true })
      const request = transaction.objectStore('versions').getAll()
      request.onsuccess = () => {
        try {
          check(options)
          const existing = request.result.map(value => validatedRecord(value))
          if (existing.length >= SNAPSHOT_LIMITS.count) throw new Error('本地最多保留 100 个项目版本，请删除不再需要的版本后重试。')
          if (existing.reduce((total, item) => total + item.storageBytes, 0) + record.storageBytes > SNAPSHOT_LIMITS.totalBytes) throw new Error('本地项目版本总容量上限为 1 GiB，请删除不再需要的版本后重试。')
          transaction.objectStore('versions').add(record)
          transaction.objectStore('archives').add(archive, record.id)
        } catch (cause) { failure = cause; transaction.abort() }
      }
      if (options.signal?.aborted) abort()
    })
    return summary(record)
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'QuotaExceededError') throw new Error('本地存储空间不足，项目版本未保存。请清理旧版本或另存便携项目。', { cause })
    throw cause
  } finally { db.close() }
}

export async function listProjectSnapshots(projectId: string): Promise<ProjectSnapshotSummary[]> {
  identifier(projectId)
  const db = await database()
  try {
    const transaction = db.transaction('versions', 'readonly')
    const [records] = await Promise.all([requested(transaction.objectStore('versions').index('projectId').getAll(projectId)), completed(transaction)])
    return records.map(item => summary(validatedRecord(item, projectId))).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  } finally { db.close() }
}
async function readSnapshot(projectId: string, id: string, withArchive = false): Promise<{ record: SnapshotRecord; archive?: Blob }> {
  identifier(projectId); identifier(id)
  const db = await database()
  try {
    const transaction = db.transaction(withArchive ? ['versions', 'archives'] : ['versions'], 'readonly')
    const [value, archive] = await Promise.all([requested(transaction.objectStore('versions').get(id)), withArchive ? requested(transaction.objectStore('archives').get(id)) : Promise.resolve(undefined), completed(transaction)])
    const record = validatedRecord(value, projectId)
    if (withArchive && (!(archive instanceof Blob) || archive.size !== record.bytes)) throw new Error('项目版本的素材包缺失或损坏。')
    return { record, archive }
  } finally { db.close() }
}
export async function loadProjectSnapshot(projectId: string, id: string, options: SnapshotContext = {}): Promise<ImportedProject> {
  check(options)
  const { record, archive } = await readSnapshot(projectId, id, true)
  check(options)
  const imported = await importProjectFile(archive!)
  try {
    const actual = await describeImported(imported, options)
    if (JSON.stringify(actual.assetHashes) !== JSON.stringify(record.assetHashes) || JSON.stringify(actual.project) !== JSON.stringify(record.project)) throw new Error('项目版本的内容与校验清单不一致。')
    check(options)
    return imported
  } catch (cause) { imported.revoke(); throw cause }
}

/**
 * Consume a loaded snapshot and assign fresh media IDs before committing a restoration.
 * This prevents a restored byte stream from overwriting a same-ID asset still used by undo.
 * The input's temporary URLs are released here. On failure the caller has nothing to adopt.
 * On success the caller owns the returned URLs: revoke on rejection, or transfer ownership
 * to the editor after commit. Do not revoke adopted URLs while the project/history uses them.
 */
export function prepareSnapshotRestore(imported: ImportedProject): ImportedProject {
  const urls: string[] = []
  try {
    const project = cloneProject(imported.project), ids = new Map<string, string>(), blobs = new Map<string, Blob>()
    for (const asset of project.assets) {
      const blob = imported.blobs.get(asset.id)
      if (!blob || blob.size !== asset.size || !blob.size) throw new Error(`版本素材“${asset.name}”缺失或大小不符，无法恢复。`)
      const id = newId('restored-asset')
      ids.set(asset.id, id); blobs.set(id, blob); asset.id = id
      asset.url = URL.createObjectURL(blob); urls.push(asset.url)
      delete asset.sourceUrl; delete asset.nativePath
    }
    for (const track of project.tracks) for (const clip of track.clips) if (clip.assetId !== undefined) {
      const id = ids.get(clip.assetId)
      if (!id) throw new Error('版本中的片段引用了缺失素材。')
      clip.assetId = id
    }
    return { project: validateProject(project, { trusted: true }), blobs, revoke: () => { urls.splice(0).forEach(url => URL.revokeObjectURL(url)) } }
  } catch (cause) { urls.forEach(url => URL.revokeObjectURL(url)); throw cause }
  finally { imported.revoke() }
}

export async function deleteProjectSnapshot(projectId: string, id: string, options: SnapshotContext = {}): Promise<void> {
  check(options); identifier(projectId); identifier(id)
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['versions', 'archives'], 'readwrite')
      let failure: unknown
      const abort = () => { failure = new DOMException('项目版本操作已取消。', 'AbortError'); try { transaction.abort() } catch {} }
      const cleanup = () => options.signal?.removeEventListener('abort', abort)
      transaction.oncomplete = () => { cleanup(); resolve() }
      transaction.onabort = () => { cleanup(); reject(failure ?? transaction.error ?? new Error('项目版本删除失败。')) }
      transaction.onerror = () => {}
      options.signal?.addEventListener('abort', abort, { once: true })
      const request = transaction.objectStore('versions').get(id)
      request.onsuccess = () => {
        try { check(options); validatedRecord(request.result, projectId); transaction.objectStore('versions').delete(id); transaction.objectStore('archives').delete(id) }
        catch (cause) { failure = cause; transaction.abort() }
      }
      if (options.signal?.aborted) abort()
    })
  } finally { db.close() }
}

function differences<T extends { id: string }>(before: T[], after: T[]) {
  const left = new Map(before.map(item => [item.id, item])), right = new Map(after.map(item => [item.id, item]))
  return { added: after.filter(item => !left.has(item.id)).map(item => item.id), removed: before.filter(item => !right.has(item.id)).map(item => item.id),
    changed: after.filter(item => left.has(item.id) && JSON.stringify(left.get(item.id)) !== JSON.stringify(item)).map(item => item.id) }
}
/** Compare two persisted versions, or a persisted version against the current project including asset bytes. */
export async function compareProjectSnapshot(project: Project, id: string, comparisonId?: string, options: SnapshotContext = {}) {
  check(options)
  const current = cloneProject(project)
  const before = (await readSnapshot(current.id, id)).record
  const after = comparisonId ? (await readSnapshot(current.id, comparisonId)).record : await manifest(await exportProjectFile(current, options), options)
  check(options)
  // Restoration intentionally gives media fresh IDs to protect undo ownership.
  // Match unchanged bytes/metadata back to their prior identity for a useful diff.
  const afterProject = cloneProject(after.project), afterHashes = { ...after.assetHashes }
  const afterIds = new Set(afterProject.assets.map(asset => asset.id))
  const available = before.project.assets.filter(asset => !afterIds.has(asset.id))
  const aliases = new Map<string, string>()
  const signature = (asset: Project['assets'][number], hashes: Record<string, string>) => { const { id: _id, ...properties } = asset; return JSON.stringify({ ...properties, sha256: hashes[asset.id] }) }
  for (const asset of afterProject.assets) {
    if (before.project.assets.some(previous => previous.id === asset.id)) continue
    const index = available.findIndex(previous => signature(previous, before.assetHashes) === signature(asset, after.assetHashes))
    if (index < 0) continue
    const previous = available.splice(index, 1)[0]!
    aliases.set(asset.id, previous.id); afterHashes[previous.id] = afterHashes[asset.id]!; delete afterHashes[asset.id]; asset.id = previous.id
  }
  for (const track of afterProject.tracks) for (const clip of track.clips) if (clip.assetId && aliases.has(clip.assetId)) clip.assetId = aliases.get(clip.assetId)
  const comparedAfter = { project: afterProject, assetHashes: afterHashes }
  const fields = ['title', 'width', 'height', 'fps', 'background', 'autoSizeFromVideo', 'subtitleStyle'] as const
  const settings = fields.filter(key => JSON.stringify(before.project[key]) !== JSON.stringify(after.project[key])).map(key => ({ field: key, before: before.project[key] ?? null, after: after.project[key] ?? null }))
  const assetItems = (item: typeof after) => item.project.assets.map(asset => ({ ...asset, sha256: item.assetHashes[asset.id] }))
  const tracks = (value: Project) => value.tracks.map(({ clips: _clips, ...track }, index) => ({ ...track, index }))
  const clips = (value: Project) => value.tracks.flatMap(track => track.clips.map((clip, index) => ({ ...clip, trackId: track.id, index })))
  const markerItems = (value: Project) => (value as Project & { markers?: { id: string }[] }).markers ?? []
  const result = { from: summary(before), to: comparisonId ? summary(after as SnapshotRecord) : { projectId: project.id, current: true as const }, settings,
    assets: differences(assetItems(before), assetItems(comparedAfter)), tracks: differences(tracks(before.project), tracks(afterProject)), clips: differences(clips(before.project), clips(afterProject)), markers: differences(markerItems(before.project), markerItems(afterProject)), contentCompared: true }
  return { ...result, identical: !settings.length && [result.assets, result.tracks, result.clips, result.markers].every(group => !group.added.length && !group.removed.length && !group.changed.length) }
}
