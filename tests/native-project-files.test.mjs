import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { createProject } from '../src/core/project.ts'

const boundaryExports = new Map([
  [new URL('../src/native.ts', import.meta.url).href, ['createMediaPreview', 'isDesktop']],
  [new URL('../src/core/storage.ts', import.meta.url).href, ['fetchAssetBlob', 'readStoredAssetBlob']],
  [new URL('../src/core/media-import.ts', import.meta.url).href, ['ensureMediaPreview']],
  ['native-project-test:core', ['invoke', 'convertFileSrc']],
])
registerHooks({
  resolve(specifier, context, nextResolve) { return specifier === '@tauri-apps/api/core' ? { url: 'native-project-test:core', shortCircuit: true } : nextResolve(specifier, context) },
  load(url, context, nextLoad) {
    const exports = boundaryExports.get(url)
    return exports ? { format: 'module', shortCircuit: true, source: exports.map(name => `export function ${name}(...args) { return globalThis.__nativeProjectFilesIo.${name}(...args) }`).join('\n') } : nextLoad(url, context)
  },
})
const { prepareNativeProjectArchive, restoreNativeProjectArchive, PROJECT_ASSET_CHUNK_BYTES } = await import('../src/native-project-files.ts')
const asset = (extra = {}) => ({ id: 'video', name: '录屏.mp4', kind: 'video', url: 'blob:original', mime: 'video/mp4', duration: 600, width: 1920, height: 1080, size: 100, ...extra })
function projectWith(value) { const project = createProject('大型剪辑项目'); project.assets = [value]; return project }
function fixture() {
  const calls = [], uploads = new Map()
  let sequence = 0
  const io = {
    isDesktop: () => true,
    fetchAssetBlob: async () => { throw new Error('原件暂不可读') },
    readStoredAssetBlob: async () => undefined,
    createMediaPreview: async () => 'asset://preview',
    ensureMediaPreview: async value => value,
    convertFileSrc: path => `asset://${path}`,
    async invoke(command, args, options) {
      calls.push({ command, args: command === 'project_asset_write' ? undefined : args, options })
      if (command === 'project_asset_begin') { const id = `upload-${++sequence}`; uploads.set(id, { received: 0, chunks: [], size: args.size }); return { id } }
      if (command === 'project_asset_write') {
        assert(args instanceof Uint8Array, '分块必须使用二进制 IPC')
        assert(args.byteLength <= PROJECT_ASSET_CHUNK_BYTES + 8)
        const upload = uploads.get(options.headers['x-upload-id'])
        assert.equal(Number(new DataView(args.buffer, args.byteOffset, 8).getBigUint64(0, true)), upload.received)
        upload.chunks.push(args.byteLength - 8); upload.received += args.byteLength - 8
        return
      }
      if (command === 'project_asset_finish') {
        const upload = uploads.get(args.id)
        assert.equal(upload.received, upload.size)
        return asset({ nativePath: `/media/${args.id}.mp4`, size: upload.size })
      }
      if (command === 'project_asset_cancel' || command === 'complete_project_archive_import') return
      throw new Error(`unexpected command ${command}`)
    },
  }
  globalThis.__nativeProjectFilesIo = io
  return { io, calls, uploads }
}

test('native project preparation accepts multi-gigabyte files without fetching or transferring original bytes', async () => {
  const f = fixture(), project = projectWith(asset({ size: 8 * 1024 ** 3, nativePath: '/authorized/录屏.mp4' })), original = structuredClone(project)
  f.io.fetchAssetBlob = async () => assert.fail('原生素材不能重新读取到网页内存')
  const prepared = await prepareNativeProjectArchive(project)
  assert.deepEqual(prepared, { ...original, assets: original.assets.map(asset => ({ ...asset, url: '' })) })
  assert.deepEqual(project, original)
  assert.deepEqual(f.calls, [])
})

test('a Blob larger than 256 MiB is materialized with bounded chunks and reused on repeated saves', async () => {
  const f = fixture(), size = 257 * 1024 ** 2 + 19
  class LargeBlob extends Blob {
    get size() { return size }
    async arrayBuffer() { assert.fail('不能一次读取完整大文件') }
    slice(start, end) { assert(end - start <= PROJECT_ASSET_CHUNK_BYTES); return new Blob([new Uint8Array(end - start)]) }
  }
  const blob = new LargeBlob(), project = projectWith(asset({ url: 'blob:large-chunk-test', size })), original = structuredClone(project)
  const options = { blobs: new Map([['video', blob]]) }
  const prepared = await prepareNativeProjectArchive(project, options)
  assert.equal(prepared.assets[0].nativePath, '/media/upload-1.mp4')
  assert.deepEqual(project, original, '准备保存不能修改编辑历史')
  assert.equal(f.uploads.get('upload-1').received, size)
  assert.equal(f.uploads.get('upload-1').chunks.length, 258)
  assert.equal(f.uploads.get('upload-1').chunks.at(-1), 19)
  await prepareNativeProjectArchive(project, options)
  assert.equal(f.calls.filter(call => call.command === 'project_asset_begin').length, 1)
})

test('failed cached Blob cancels its partial upload and recovers the original instead of the preview', async () => {
  const f = fixture(), cached = new Blob(['cached']), source = new Blob(['original-video']), project = projectWith(asset({ url: 'blob:preview-fallback', sourceUrl: 'blob:source-fallback', size: source.size }))
  cached.slice = () => ({ size: cached.size, arrayBuffer: async () => { throw new DOMException('The object can not be found here.', 'NotFoundError') } })
  f.io.fetchAssetBlob = async value => { assert.equal(value.sourceUrl, 'blob:source-fallback'); return source }
  const options = { blobs: new Map([['video', cached]]) }
  const prepared = await prepareNativeProjectArchive(project, options)
  assert.equal(prepared.assets[0].nativePath, '/media/upload-2.mp4')
  assert.equal(f.calls.filter(call => call.command === 'project_asset_cancel').length, 1)
  await prepareNativeProjectArchive(project, options)
  assert.equal(f.calls.filter(call => call.command === 'project_asset_begin').length, 2)
})

test('cancelled preparation removes its partial transfer and never falls back to another source', async () => {
  const f = fixture(), controller = new AbortController(), blob = new Blob([new Uint8Array(PROJECT_ASSET_CHUNK_BYTES * 2)])
  const originalInvoke = f.io.invoke
  f.io.invoke = async (...args) => { const result = await originalInvoke(...args); if (args[0] === 'project_asset_write') controller.abort(); return result }
  f.io.fetchAssetBlob = async () => assert.fail('取消后不能继续回源')
  await assert.rejects(prepareNativeProjectArchive(projectWith(asset({ url: 'blob:cancel-test', size: blob.size })), { blobs: new Map([['video', blob]]), signal: controller.signal }), { name: 'AbortError' })
  assert.equal(f.calls.filter(call => call.command === 'project_asset_write').length, 1)
  assert.equal(f.calls.filter(call => call.command === 'project_asset_cancel').length, 1)
  assert.equal(f.calls.filter(call => call.command === 'project_asset_finish').length, 0)
})

test('stored draft fallback remains available when both the File and original URL are missing', async () => {
  const f = fixture(), stored = new Blob(['draft-content'])
  f.io.readStoredAssetBlob = async (projectId, id) => { assert(projectId); assert.equal(id, 'video'); return stored }
  const prepared = await prepareNativeProjectArchive(projectWith(asset({ url: 'blob:missing-draft-fallback', size: stored.size })))
  assert.equal(prepared.assets[0].nativePath, '/media/upload-1.mp4')
})

test('native opening replaces archive URLs with authorized local paths and accepts extracted files only after preview validation', async () => {
  const f = fixture(), project = projectWith(asset({ nativePath: '/extracted/original.mp4', url: 'https://untrusted.invalid/preview', sourceUrl: 'https://untrusted.invalid/original', size: 3 * 1024 ** 3 }))
  f.io.ensureMediaPreview = async value => {
    assert.equal(value.url, 'asset:///extracted/original.mp4')
    assert.equal(value.sourceUrl, undefined)
    assert.equal(f.calls.length, 0)
    return value
  }
  const opened = await restoreNativeProjectArchive(project)
  assert.equal(opened.assets[0].size, 3 * 1024 ** 3)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].command, 'complete_project_archive_import')
  assert.equal(f.calls[0].args.keep, true)
  assert.equal(project.assets[0].url, 'https://untrusted.invalid/preview')
})

test('invalid or unreadable opened projects discard pending extracted files while preserving the original error', async () => {
  for (const mode of ['invalid', 'preview', 'cancel']) {
    const f = fixture(), controller = new AbortController(), project = projectWith(asset({ nativePath: '/extracted/original.mp4' }))
    if (mode === 'invalid') project.width = -1
    if (mode === 'preview') f.io.ensureMediaPreview = async () => { throw new Error('素材无法解码') }
    if (mode === 'cancel') controller.abort()
    await assert.rejects(restoreNativeProjectArchive(project, controller.signal))
    assert.deepEqual(f.calls.map(call => [call.command, call.args.keep]), [['complete_project_archive_import', false]])
  }
})
