import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { MAX_ASSETS, validateProject } from './project.ts'
import { fetchAssetBlob, readStoredAssetBlob } from './storage.ts'
import type { ImportedProject, MediaAsset, Project } from './types.ts'

export const PROJECT_EXTENSION = '.omedia'
export const MAX_PORTABLE_BYTES = 256 * 1024 * 1024
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024
const MANIFEST = 'project.json'

type Progress = (completed: number, total: number, name: string) => void
export interface ProjectExportOptions { blobs?: Map<string, Blob>; signal?: AbortSignal; onProgress?: Progress }

function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('操作已取消。') }

async function readPortableAsset(projectId: string, asset: MediaAsset, options: ProjectExportOptions, remaining: number): Promise<Uint8Array> {
  const cached = options.blobs?.get(asset.id)
  const sources: (() => Promise<Blob | undefined>)[] = [
    ...(cached ? [() => Promise.resolve(cached)] : []),
    () => fetchAssetBlob(asset, options.signal),
    () => readStoredAssetBlob(projectId, asset.id),
  ]
  let failure: unknown
  for (const source of sources) {
    aborted(options.signal)
    let blob: Blob | undefined
    try { blob = await source() } catch (cause) { failure = cause; continue }
    if (!blob) continue
    if (!blob.size) { failure = new Error('素材为空。'); continue }
    if (blob.size > remaining) throw new Error('便携项目超过 256 MB 内存容量限制，请减少素材后重试。')
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      aborted(options.signal)
      if (bytes.byteLength !== blob.size) throw new Error('素材内容不完整。')
      // Preserve a recovered copy so subsequent saves do not reuse an unreadable File/Blob.
      if (cached && blob !== cached) options.blobs?.set(asset.id, new Blob([bytes.buffer as ArrayBuffer], { type: blob.type || asset.mime }))
      return bytes
    } catch (cause) { failure = cause }
  }
  aborted(options.signal)
  throw new Error(`素材“${asset.name}”读取失败，原件与本地副本均不可用。请恢复原文件或重新导入后再保存；当前项目未被覆盖。`, { cause: failure })
}

export async function exportProjectFile(project: Project, options: ProjectExportOptions = {}): Promise<Blob> {
  const clean = validateProject(project, { trusted: true })
  const entries: Record<string, Uint8Array> = Object.create(null)
  let size = 0
  const declaredSize = clean.assets.reduce((sum, asset) => sum + asset.size, 0)
  if (declaredSize > MAX_PORTABLE_BYTES) throw new Error('便携项目最多包含 256 MB 素材，请减少素材后保存。原生视频导出不受此限制。')
  for (const [index, asset] of clean.assets.entries()) {
    aborted(options.signal)
    options.onProgress?.(index, clean.assets.length, asset.name)
    const bytes = await readPortableAsset(clean.id, asset, options, MAX_PORTABLE_BYTES - size)
    size += bytes.byteLength
    entries[`media/${asset.id}`] = bytes
    asset.size = bytes.byteLength
    asset.url = ''
    delete asset.sourceUrl
    delete asset.nativePath
  }
  aborted(options.signal)
  entries[MANIFEST] = strToU8(JSON.stringify({ format: 'open-media-project', version: 1, project: clean }))
  if (entries[MANIFEST]!.byteLength > MAX_MANIFEST_BYTES) throw new Error('项目描述过大，请减少字幕或片段数量。')
  const archive = zipSync(entries, { level: 0 })
  if (archive.byteLength > MAX_PORTABLE_BYTES + MAX_MANIFEST_BYTES) throw new Error('便携项目文件过大。')
  options.onProgress?.(clean.assets.length, clean.assets.length, clean.title)
  return new Blob([archive.buffer as ArrayBuffer], { type: 'application/x-open-media-project' })
}

interface ZipEntry { name: string; uncompressed: number; compressed: number; method: number; offset: number; crc: number }

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

/** Inspect central and local headers before allocation, rejecting duplicate and oversized entries. */
function inspectArchive(bytes: Uint8Array): Map<string, ZipEntry> {
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_PORTABLE_BYTES + MAX_MANIFEST_BYTES) throw new Error('项目文件为空、损坏或超过 256 MB 容量限制。')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break }
  }
  if (end < 0) throw new Error('项目文件目录损坏。')
  const count = view.getUint16(end + 10, true)
  const directorySize = view.getUint32(end + 12, true)
  const directoryOffset = view.getUint32(end + 16, true)
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || count === 65535 || count > MAX_ASSETS + 1 || directoryOffset + directorySize !== end) throw new Error('项目文件目录格式不受支持。')
  const entries = new Map<string, ZipEntry>()
  const intervals: { start: number; end: number }[] = []
  let offset = directoryOffset
  let totalSize = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('项目文件目录损坏。')
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const compressed = view.getUint32(offset + 20, true)
    const uncompressed = view.getUint32(offset + 24, true)
    const crc = view.getUint32(offset + 16, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const next = offset + 46 + nameLength + extraLength + commentLength
    if (next > end || flags & 1 || ![0, 8].includes(method) || compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) throw new Error('项目包含加密、过大或不支持的素材。')
    const name = strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if ((name !== MANIFEST && !/^media\/[a-zA-Z0-9_-]{1,160}$/.test(name)) || entries.has(name)) throw new Error('项目包含无效或重复的素材路径。')
    if (name === MANIFEST && uncompressed > MAX_MANIFEST_BYTES) throw new Error('项目描述过大。')
    totalSize += uncompressed
    if (totalSize > MAX_PORTABLE_BYTES + MAX_MANIFEST_BYTES) throw new Error('项目解压后超过 256 MB 容量限制。')
    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('项目素材索引损坏。')
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressed > directoryOffset || view.getUint16(localOffset + 8, true) !== method || view.getUint16(localOffset + 6, true) !== flags || strFromU8(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)) !== name) throw new Error('项目素材索引不一致。')
    if (!(flags & 8) && (view.getUint32(localOffset + 18, true) !== compressed || view.getUint32(localOffset + 22, true) !== uncompressed)) throw new Error('项目素材大小不一致。')
    intervals.push({ start: localOffset, end: dataStart + compressed })
    entries.set(name, { name, uncompressed, compressed, method, offset: localOffset, crc })
    offset = next
  }
  intervals.sort((a, b) => a.start - b.start)
  for (let index = 1; index < intervals.length; index++) if (intervals[index]!.start < intervals[index - 1]!.end) throw new Error('项目素材数据重叠。')
  if (offset !== end || !entries.has(MANIFEST)) throw new Error('项目文件缺少描述信息。')
  return entries
}

export async function importProjectFile(file: Blob | Uint8Array | ArrayBuffer): Promise<ImportedProject> {
  if (file instanceof Blob && file.size > MAX_PORTABLE_BYTES + MAX_MANIFEST_BYTES) throw new Error('项目文件超过 256 MB 容量限制。')
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(file instanceof Blob ? await file.arrayBuffer() : file)
  const entries = inspectArchive(bytes)
  let files: Record<string, Uint8Array>
  try { files = unzipSync(bytes) } catch { throw new Error('项目解压失败，文件可能已损坏。') }
  for (const [name, entry] of entries) if (!files[name] || files[name]!.byteLength !== entry.uncompressed || crc32(files[name]!) !== entry.crc) throw new Error('项目素材校验失败，文件内容可能已损坏。')
  let manifest: unknown
  try { manifest = JSON.parse(strFromU8(files[MANIFEST]!)) } catch { throw new Error('项目描述不是有效的 JSON 数据。') }
  if (!manifest || typeof manifest !== 'object' || (manifest as { format?: unknown }).format !== 'open-media-project' || (manifest as { version?: unknown }).version !== 1) throw new Error('此文件不是受支持的便携项目。')
  const project = validateProject((manifest as { project?: unknown }).project)
  if (entries.size !== project.assets.length + 1) throw new Error('项目素材清单与文件内容不一致。')
  const blobs = new Map<string, Blob>()
  const urls: string[] = []
  try {
    for (const asset of project.assets) {
      const data = files[`media/${asset.id}`]
      if (!data?.byteLength || data.byteLength !== asset.size) throw new Error(`素材“${asset.name}”缺失或文件大小不符。`)
      const blob = new Blob([new Uint8Array(data).buffer], { type: asset.mime || 'application/octet-stream' })
      blobs.set(asset.id, blob)
      asset.url = URL.createObjectURL(blob)
      urls.push(asset.url)
    }
    return { project, blobs, revoke: () => { urls.splice(0).forEach((url) => URL.revokeObjectURL(url)) } }
  } catch (error) { urls.forEach((url) => URL.revokeObjectURL(url)); throw error }
}

export const exportPortableProject = exportProjectFile
export const importPortableProject = importProjectFile
