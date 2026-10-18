import { newId } from './project.ts'

const DATABASE = 'open-media-tool-artifacts'
const STORE = 'files'
const MAX_FILE = 64 * 1024 * 1024
const MAX_TOTAL = 256 * 1024 * 1024
const LIFETIME = 24 * 60 * 60 * 1000
export interface ToolArtifact { artifactId: string; name: string; mimeType: string; bytes: number; sha256: string; createdAt: number; expiresAt: number }
interface Record extends ToolArtifact { blob: Blob }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'artifactId' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开预览文件缓存。'))
  })
}
export function bytesBase64(bytes: Uint8Array): string {
  let value = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(value)
}
export function base64Blob(data: string, mimeType: string): Blob {
  const raw = atob(data), bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index)
  return new Blob([bytes], { type: mimeType })
}
export async function storeToolArtifact(blob: Blob, name: string, signal?: AbortSignal): Promise<ToolArtifact> {
  signal?.throwIfAborted()
  if (!blob.size || blob.size > MAX_FILE) throw new Error('预览文件为空或超过 64 MB，请缩短范围或降低预览尺寸。')
  const bytes = await blob.arrayBuffer()
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
  signal?.throwIfAborted()
  const createdAt = Date.now()
  const metadata: ToolArtifact = { artifactId: newId('preview'), name, mimeType: blob.type || 'application/octet-stream', bytes: blob.size, sha256, createdAt, expiresAt: createdAt + LIFETIME }
  const db = await open()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite'), store = transaction.objectStore(STORE)
      const abort = () => { try { transaction.abort() } catch {} }
      signal?.addEventListener('abort', abort, { once: true })
      transaction.oncomplete = () => { signal?.removeEventListener('abort', abort); resolve() }
      transaction.onerror = transaction.onabort = () => { signal?.removeEventListener('abort', abort); reject(signal?.aborted ? new DOMException('预览已取消。', 'AbortError') : transaction.error ?? new Error('预览文件缓存写入失败。')) }
      const request = store.getAll()
      request.onsuccess = () => {
        const rows = (request.result as Record[]).sort((a, b) => a.createdAt - b.createdAt)
        let total = rows.reduce((sum, row) => sum + row.bytes, blob.size), count = rows.length + 1
        for (const row of rows) if (row.expiresAt <= createdAt || total > MAX_TOTAL || count > 20) { store.delete(row.artifactId); total -= row.bytes; count-- }
        store.put({ ...metadata, blob: new Blob([bytes], { type: metadata.mimeType }) })
      }
      if (signal?.aborted) abort()
    })
    return metadata
  } finally { db.close() }
}
export async function getToolArtifact(artifactId: string): Promise<{ metadata: ToolArtifact; blob: Blob }> {
  const db = await open()
  try {
    const row = await new Promise<Record | undefined>((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(artifactId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    if (!row || row.expiresAt <= Date.now()) throw new Error('预览文件不存在或已过期，请重新生成。')
    const { blob, ...metadata } = row
    return { metadata, blob }
  } finally { db.close() }
}
export async function readToolArtifact(artifactId: string, offset = 0, length = 262144) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 262144) throw new Error('预览读取位置或分块长度无效。')
  const { metadata, blob } = await getToolArtifact(artifactId)
  if (offset > blob.size) throw new Error('读取位置超出预览文件。')
  const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
  return { ...metadata, offset, nextOffset: offset + bytes.length, done: offset + bytes.length >= blob.size, encoding: 'base64', data: bytesBase64(bytes) }
}
