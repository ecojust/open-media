const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { webkit } = require('@playwright/test')

// Real WebKit IndexedDB transactions; synthetic PCM files exercise byte persistence.
// Linux WebKit coverage does not substitute for a macOS desktop application run.
async function main() {
  const { createServer } = await import('vite')
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'open-media-storage-webkit-'))
  const server = await createServer({
    root: path.resolve(__dirname, '../..'), configFile: false, cacheDir, appType: 'custom',
    plugins: [{ name: 'storage-test-page', configureServer(server) {
      server.middlewares.use('/__storage-webkit', (_request, response) => {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end('<!doctype html><meta charset="utf-8"><title>草稿存储验证</title>')
      })
    } }],
    server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null, hmr: false },
  })
  let context
  try {
    await server.listen()
    // Ephemeral WebKit contexts reject Blob persistence even for a raw one-request
    // IndexedDB transaction. Use a disposable persistent profile, as the app does.
    context = await webkit.launchPersistentContext(path.join(cacheDir, 'profile'), { headless: true })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      const state = window.storageCheck = { fault: '', counts: {} }
      state.reset = () => { state.counts = { blobGets: 0, blobKeys: 0, blobPuts: 0, blobBytes: 0, projectPuts: 0 } }
      state.reset()
      const get = IDBObjectStore.prototype.get, getKey = IDBObjectStore.prototype.getKey, put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.get = function (...args) { if (this.name === 'blobs') state.counts.blobGets++; return get.apply(this, args) }
      IDBObjectStore.prototype.getKey = function (...args) { if (this.name === 'blobs') state.counts.blobKeys++; return getKey.apply(this, args) }
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'blobs') { state.counts.blobPuts++; state.counts.blobBytes += args[0].size }
        if (this.name === 'projects') {
          state.counts.projectPuts++
          const fault = state.fault
          state.fault = ''
          if (fault === 'quota') throw new DOMException('测试：本地存储配额不足', 'QuotaExceededError')
          if (fault === 'abort') { const result = put.apply(this, args); this.transaction.abort(); return result }
        }
        return put.apply(this, args)
      }
    })
    const url = `http://127.0.0.1:${server.httpServer.address().port}/__storage-webkit`
    await page.goto(url)
    const initial = await page.evaluate(async () => {
      const { createProject } = await import('/src/core/project.ts')
      const { saveProject, deleteProject } = await import('/src/core/storage.ts')
      const state = window.storageCheck
      const empty = createProject('空项目事务验证')
      await saveProject(empty)
      await saveProject({ ...empty, title: '空项目再次保存' })
      await deleteProject(empty.id)
      const project = createProject('六十份原件'), blobs = new Map(), expectedHashes = []
      const byteLength = 1024 * 1024, sampleRate = 48000
      for (let index = 0; index < 60; index++) {
        const bytes = new Uint8Array(byteLength), view = new DataView(bytes.buffer)
        const ascii = (offset, value) => [...value].forEach((character, i) => { bytes[offset + i] = character.charCodeAt(0) })
        ascii(0, 'RIFF'); view.setUint32(4, byteLength - 8, true); ascii(8, 'WAVEfmt ')
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
        view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
        view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data')
        view.setUint32(40, byteLength - 44, true); view.setInt16(44, index + 1, true)
        const id = `asset-${index}`, blob = new Blob([bytes], { type: 'audio/wav' })
        blobs.set(id, blob)
        expectedHashes.push([...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join(''))
        project.assets.push({ id, name: `${index}.wav`, kind: 'audio', url: `blob:unused-${index}`, duration: (byteLength - 44) / sampleRate / 2, width: 0, height: 0, size: byteLength, mime: blob.type })
      }
      state.reset()
      await saveProject(project, blobs)
      const first = { ...state.counts }
      state.reset()
      for (let index = 0; index < 10; index++) await saveProject({ ...project, title: `元数据修改 ${index}` }, blobs)
      return { id: project.id, expectedHashes, first, metadata: { ...state.counts }, userAgent: navigator.userAgent }
    })
    assert.deepEqual(initial.first, { blobGets: 0, blobKeys: 0, blobPuts: 60, blobBytes: 60 * 1024 * 1024, projectPuts: 1 })
    assert.deepEqual(initial.metadata, { blobGets: 0, blobKeys: 600, blobPuts: 0, blobBytes: 0, projectPuts: 10 })
    console.log('PASS WebKit：60 MiB 首次保存及十次元数据保存；空复用列表与 60 个请求的事务均完成')

    // A new document loses the in-memory cache; loadProject must register restored Blobs.
    await page.reload()
    const result = await page.evaluate(async ({ id }) => {
      const { saveProject, loadProject } = await import('/src/core/storage.ts')
      const state = window.storageCheck
      const summarize = async restored => ({
        title: restored.project.title, savedAt: restored.savedAt,
        hashes: await Promise.all(restored.project.assets.map(async asset => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await restored.blobs.get(asset.id).arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join(''))),
      })
      const snapshot = async () => { const restored = await loadProject(id); try { return await summarize(restored) } finally { restored.revoke() } }
      let restored = await loadProject(id)
      const reopened = await summarize(restored)
      state.reset()
      await saveProject({ ...restored.project, title: '重开后保存' }, restored.blobs)
      const reopenedSave = { ...state.counts }
      state.reset()
      await saveProject({ ...restored.project, title: '仅有元数据时保存' })
      const withoutBlobMap = { ...state.counts }
      restored.revoke()
      const faults = []
      for (const mode of ['quota', 'abort']) {
        restored = await loadProject(id)
        const previous = await summarize(restored), firstId = restored.project.assets[0].id
        const bytes = new Uint8Array(await restored.blobs.get(firstId).arrayBuffer())
        bytes[44] = mode === 'quota' ? 100 : 101
        const replacement = new Blob([bytes], { type: 'audio/wav' })
        const changed = { ...restored.project, title: `${mode} 后重试`, assets: restored.project.assets.slice(0, -1) }
        const changedBlobs = new Map(restored.blobs)
        changedBlobs.set(firstId, replacement)
        state.reset(); state.fault = mode
        let failure
        try { await saveProject(changed, changedBlobs) } catch (error) { failure = { message: error.message, cause: error.cause?.name } }
        if (!failure) throw new Error(`${mode} 故障未阻止保存`)
        const attempted = { ...state.counts }, rollback = await snapshot()
        state.reset()
        await saveProject(changed, changedBlobs)
        const retried = { ...state.counts }, committed = await snapshot()
        const replacementHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
        faults.push({ mode, previous, failure, attempted, rollback, retried, committed, replacementHash })
        restored.revoke()
      }
      return { reopened, reopenedSave, withoutBlobMap, faults }
    }, { id: initial.id })
    assert.deepEqual(result.reopened.hashes, initial.expectedHashes)
    const metadataCounts = { blobGets: 0, blobKeys: 60, blobPuts: 0, blobBytes: 0, projectPuts: 1 }
    assert.deepEqual(result.reopenedSave, metadataCounts)
    assert.deepEqual(result.withoutBlobMap, metadataCounts)
    for (const fault of result.faults) {
      assert.deepEqual(fault.rollback, fault.previous, `${fault.mode} 后保留全部原件、标题与保存时间`)
      assert.equal(fault.attempted.blobPuts, 1)
      assert.equal(fault.retried.blobPuts, 1, '中止事务不得将新原件标记为已保存')
      assert.equal(fault.committed.title, `${fault.mode} 后重试`)
      assert.deepEqual(fault.committed.hashes, [fault.replacementHash, ...fault.previous.hashes.slice(1, -1)])
      if (fault.mode === 'quota') assert.equal(fault.failure.cause, 'QuotaExceededError')
    }
    assert.deepEqual(errors, [])
    console.log('PASS WebKit：重开后零原件读写；配额异常及真实事务中止保留全部字节，重试正确提交替换与删除')
    console.log(JSON.stringify({ environment: `Playwright WebKit on ${process.platform}; not a macOS desktop run`, userAgent: initial.userAgent, originalAssets: 60, originalBytes: 60 * 1024 * 1024, first: initial.first, tenMetadataSaves: initial.metadata, reopenedSave: result.reopenedSave, rollbackAndRetry: result.faults.map(fault => fault.mode) }, null, 2))
  } finally {
    await context?.close()
    await server.close()
    await rm(cacheDir, { recursive: true, force: true })
  }
}

const timeout = setTimeout(() => { console.error('WebKit 草稿存储验证超过 90 秒'); process.exit(1) }, 90_000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(timeout))
