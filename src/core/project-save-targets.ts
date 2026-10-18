import type { ProjectFileTarget } from '../native.ts'
import type { BrowserProjectFileHandle } from './browser-project-files.ts'

export type ProjectSaveTarget = { kind: 'native'; target: ProjectFileTarget } | { kind: 'browser'; handle: BrowserProjectFileHandle }

const DATABASE_NAME = 'open-media-file-targets'
const STORE = 'targets'
// File capabilities belong to this installation, never to an exported project document.
const sessionTargets = new Map<string, ProjectSaveTarget | undefined>()

function checkedId(projectId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(projectId)) throw new Error('项目保存位置关联无效。')
  return projectId
}

function checkedTarget(value: unknown): ProjectSaveTarget {
  if (!value || typeof value !== 'object') throw new Error('本机项目保存位置记录无效，请使用另存为重新选择位置。')
  const entry = value as Partial<ProjectSaveTarget>
  if (entry.kind === 'native' && entry.target && typeof entry.target === 'object') {
    const { name, path, token } = entry.target
    if (typeof name === 'string' && name.length > 0 && name.length <= 1000
      && typeof path === 'string' && path.length > 0 && path.length <= 32768 && !path.includes('\0')
      && typeof token === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(token)) return { kind: 'native', target: { name, path, token } }
  }
  if (entry.kind === 'browser' && entry.handle && typeof entry.handle.name === 'string'
    && typeof entry.handle.getFile === 'function' && typeof entry.handle.createWritable === 'function') {
    return { kind: 'browser', handle: entry.handle }
  }
  throw new Error('本机项目保存位置记录无效，请使用另存为重新选择位置。')
}

function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('当前环境无法记住项目保存位置。'))
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result) }
    request.onerror = () => reject(request.error ?? new Error('无法读取本机项目保存位置。'))
    request.onblocked = () => reject(new Error('项目保存位置记录正被其他窗口使用，请关闭旧窗口后重试。'))
  })
}

export async function loadProjectSaveTarget(projectId: string): Promise<ProjectSaveTarget | undefined> {
  const key = checkedId(projectId)
  if (sessionTargets.has(key)) return sessionTargets.get(key)
  const db = await openDatabase()
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('无法恢复项目保存位置。'))
    })
    const target = value === undefined ? undefined : checkedTarget(value)
    sessionTargets.set(key, target)
    return target
  } finally { db.close() }
}

export async function storeProjectSaveTarget(projectId: string, value: ProjectSaveTarget | undefined): Promise<void> {
  const key = checkedId(projectId), target = value === undefined ? undefined : checkedTarget(value)
  // A persistence failure must not lose a successful save target in the current session.
  sessionTargets.set(key, target)
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('无法记住项目保存位置。'))
      transaction.onerror = () => { /* The abort event reports the failed atomic write. */ }
      try {
        const store = transaction.objectStore(STORE)
        if (target) store.put(target, key)
        else store.delete(key)
      } catch (error) {
        try { transaction.abort() } catch { /* The transaction may already be aborted. */ }
        reject(error)
      }
    })
  } finally { db.close() }
}
