import test from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { createProject } from '../src/core/project.ts'
import { addAsset } from '../src/core/timeline.ts'
import { deleteProject, fetchAssetBlob, listProjects, loadProject, saveProject } from '../src/core/storage.ts'

function fixture() {
  const blob = new Blob(['persisted-media'], { type: 'video/webm' })
  const asset = { id: 'asset-storage', name: '本地.webm', kind: 'video', url: URL.createObjectURL(blob), duration: 10, width: 640, height: 480, size: blob.size, mime: blob.type }
  return { blob, asset, project: addAsset(createProject('本地测试'), asset) }
}

async function changeStoredSaveTime(id, value) {
  const db = await new Promise((resolve, reject) => {
    const opening = indexedDB.open('open-media-projects', 1)
    opening.onsuccess = () => resolve(opening.result)
    opening.onerror = () => reject(opening.error)
  })
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('projects', 'readwrite')
      transaction.oncomplete = resolve
      transaction.onabort = () => reject(transaction.error)
      const store = transaction.objectStore('projects')
      const reading = store.get(id)
      reading.onsuccess = () => {
        const record = reading.result
        if (value === undefined) delete record.localDraftSavedAt
        else record.localDraftSavedAt = value
        store.put(record)
      }
    })
  } finally { db.close() }
}

test('草稿保存时间在素材读取完成后记录，提交后返回并独立于项目修改时间', async t => {
  globalThis.indexedDB = new IDBFactory()
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-17T10:00:00.000Z') })
  const { project, asset } = fixture()
  project.updatedAt = '2026-10-16T01:02:03.000Z'
  const originalFetch = globalThis.fetch
  let releaseRead
  let markReading
  const reading = new Promise(resolve => { markReading = resolve })
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args)
    const release = new Promise(resolve => { releaseRead = resolve })
    markReading()
    await release
    return response
  }
  t.after(() => { globalThis.fetch = originalFetch; URL.revokeObjectURL(asset.url) })
  const saving = saveProject(project)
  let returned = false
  void saving.then(() => { returned = true })
  await reading
  assert.equal(returned, false)
  t.mock.timers.tick(42_000)
  releaseRead()
  const savedAt = await saving
  assert.equal(savedAt, '2026-10-17T10:00:42.000Z')
  const restored = await loadProject(project.id)
  assert.equal(restored.savedAt, savedAt)
  assert.equal(restored.project.updatedAt, project.updatedAt)
  assert.equal('localDraftSavedAt' in restored.project, false)
  assert.equal('savedAt' in restored.project, false)
  restored.revoke()
})

test('旧草稿及损坏的保存时间保持未知，不使用项目修改时间代替', async () => {
  globalThis.indexedDB = new IDBFactory()
  const project = createProject('旧版本草稿')
  await saveProject(project)
  for (const value of [undefined, null, 1792231200000, '', 'invalid', '2026-02-30T10:00:00.000Z', '2026-10-17', '2026-10-17T10:00:00.000Z extra']) {
    await changeStoredSaveTime(project.id, value)
    const restored = await loadProject(project.id)
    assert.equal(restored.savedAt, undefined)
    assert.equal(restored.project.updatedAt, project.updatedAt)
    restored.revoke()
  }
})

test('本地项目原子持久化素材，重新打开恢复URL并可彻底删除', async () => {
  globalThis.indexedDB = new IDBFactory()
  const { project, asset, blob } = fixture()
  try {
    await saveProject(project)
    URL.revokeObjectURL(asset.url)
    const restored = await loadProject(project.id)
    assert.equal(await restored.blobs.get(asset.id).text(), await blob.text())
    assert.equal(await (await fetch(restored.project.assets[0].url)).text(), 'persisted-media')
    assert.equal((await listProjects())[0].assetCount, 1)
    await saveProject({ ...project, title: '素材已存在无需读取旧URL' })
    const updated = await loadProject(project.id)
    assert.equal(updated.project.title, '素材已存在无需读取旧URL')
    restored.revoke()
    updated.revoke()
    await deleteProject(project.id)
    assert.equal((await listProjects()).length, 0)
    await assert.rejects(loadProject(project.id), /未找到/)
  } finally { URL.revokeObjectURL(asset.url) }
})

test('六十份素材再次保存只更新草稿，不读取或重写已提交的原件', async t => {
  globalThis.indexedDB = new IDBFactory()
  const project = createProject('六十份素材'), blobs = new Map()
  const bytes = new Uint8Array(1024 * 1024)
  for (let index = 0; index < 60; index++) {
    const blob = new Blob([bytes], { type: 'video/webm' }), id = `asset-${index}`
    blobs.set(id, blob)
    project.assets.push({ id, name: `${index}.webm`, kind: 'video', url: `blob:unavailable-${index}`, duration: 10, width: 640, height: 480, size: blob.size, mime: blob.type })
  }
  const originalGet = IDBObjectStore.prototype.get, originalPut = IDBObjectStore.prototype.put
  let blobReads = 0, blobWrites = 0, bytesWritten = 0
  IDBObjectStore.prototype.get = function (...args) {
    if (this.name === 'blobs') blobReads++
    return originalGet.apply(this, args)
  }
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'blobs') { blobWrites++; bytesWritten += args[0].size }
    return originalPut.apply(this, args)
  }
  t.after(() => { IDBObjectStore.prototype.get = originalGet; IDBObjectStore.prototype.put = originalPut })
  await saveProject(project, blobs)
  assert.equal(blobWrites, 60)
  assert.equal(bytesWritten, 60 * 1024 * 1024)
  blobReads = 0; blobWrites = 0; bytesWritten = 0
  await saveProject({ ...project, title: '时间线编辑后的草稿' }, blobs)
  assert.equal(blobReads, 0)
  assert.equal(blobWrites, 0)
  assert.equal(bytesWritten, 0)
  // The existence-only path also avoids reading originals when no Blob map is supplied.
  await saveProject({ ...project, title: '仅有项目元数据' })
  assert.equal(blobReads, 0)
  assert.equal(blobWrites, 0)
})

test('重新打开后的原件可直接复用，不再因重复写素材而耗尽配额', async t => {
  globalThis.indexedDB = new IDBFactory()
  const { project, asset, blob } = fixture()
  t.after(() => URL.revokeObjectURL(asset.url))
  await saveProject(project, new Map([[asset.id, blob]]))
  const restored = await loadProject(project.id)
  t.after(restored.revoke)
  const originalPut = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'blobs') throw new DOMException('quota exceeded', 'QuotaExceededError')
    return originalPut.apply(this, args)
  }
  t.after(() => { IDBObjectStore.prototype.put = originalPut })
  const savedAt = await saveProject({ ...restored.project, title: '恢复后继续编辑' }, restored.blobs)
  const updated = await loadProject(project.id)
  t.after(updated.revoke)
  assert.equal(updated.project.title, '恢复后继续编辑')
  assert.equal(updated.savedAt, savedAt)
  assert.equal('localDraftRevision' in updated.project, false)
  assert.equal(await updated.blobs.get(asset.id).text(), await blob.text())
})

test('同标识同大小的新原件会更新，撤销回旧原件也不会误用缓存', async t => {
  globalThis.indexedDB = new IDBFactory()
  const { project, asset, blob } = fixture()
  t.after(() => URL.revokeObjectURL(asset.url))
  const replacement = new Blob(['replacement-one'], { type: blob.type })
  assert.equal(replacement.size, blob.size)
  const blobs = new Map([[asset.id, blob]])
  await saveProject(project, blobs)
  blobs.set(asset.id, replacement)
  await saveProject(project, blobs)
  let restored = await loadProject(project.id)
  assert.equal(await restored.blobs.get(asset.id).text(), 'replacement-one')
  restored.revoke()
  blobs.set(asset.id, blob)
  await saveProject(project, blobs)
  restored = await loadProject(project.id)
  assert.equal(await restored.blobs.get(asset.id).text(), await blob.text())
  restored.revoke()
})

test('缓存的素材记录被删除后会补回原件，删除整个项目后也可再次保存', async t => {
  globalThis.indexedDB = new IDBFactory()
  const { project, asset, blob } = fixture()
  t.after(() => URL.revokeObjectURL(asset.url))
  const blobs = new Map([[asset.id, blob]])
  await saveProject(project, blobs)
  const db = await new Promise((resolve, reject) => {
    const opening = indexedDB.open('open-media-projects', 1)
    opening.onsuccess = () => resolve(opening.result)
    opening.onerror = () => reject(opening.error)
  })
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('blobs', 'readwrite')
    transaction.oncomplete = resolve
    transaction.onabort = () => reject(transaction.error)
    transaction.objectStore('blobs').delete(`${project.id}:${asset.id}`)
  })
  db.close()
  await saveProject(project, blobs)
  let restored = await loadProject(project.id)
  assert.equal(await restored.blobs.get(asset.id).text(), await blob.text())
  restored.revoke()
  await deleteProject(project.id)
  await saveProject(project, blobs)
  restored = await loadProject(project.id)
  assert.equal(await restored.blobs.get(asset.id).text(), await blob.text())
  restored.revoke()
})

test('素材替换事务中止后保留原件，重试会重新写入新原件', async t => {
  globalThis.indexedDB = new IDBFactory()
  const { project, asset, blob } = fixture()
  t.after(() => URL.revokeObjectURL(asset.url))
  const previousSavedAt = await saveProject(project, new Map([[asset.id, blob]]))
  const replacement = new Blob(['replacement-one'], { type: blob.type })
  const blobs = new Map([[asset.id, replacement]])
  const originalPut = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (...args) {
    const result = originalPut.apply(this, args)
    if (this.name === 'projects') result.addEventListener('success', () => this.transaction.abort())
    return result
  }
  try {
    await assert.rejects(saveProject({ ...project, title: '事务应撤销' }, blobs), /中断|abort/i)
  } finally { IDBObjectStore.prototype.put = originalPut }
  let restored = await loadProject(project.id)
  assert.equal(restored.savedAt, previousSavedAt)
  assert.equal(await restored.blobs.get(asset.id).text(), await blob.text())
  restored.revoke()
  await saveProject({ ...project, title: '事务重试' }, blobs)
  restored = await loadProject(project.id)
  assert.equal(restored.project.title, '事务重试')
  assert.equal(await restored.blobs.get(asset.id).text(), 'replacement-one')
  restored.revoke()
})

test('同步入库异常撤销已排队的删除，原项目及素材保持完整', async () => {
  globalThis.indexedDB = new IDBFactory()
  const { project, asset, blob } = fixture()
  const originalPut = IDBObjectStore.prototype.put
  try {
    const savedAt = await saveProject(project, new Map([[asset.id, blob]]))
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'projects') throw new DOMException('quota exceeded', 'QuotaExceededError')
      return originalPut.apply(this, args)
    }
    await assert.rejects(saveProject({ ...project, title: '不应保存', assets: [] }), /空间不足/)
    IDBObjectStore.prototype.put = originalPut
    const restored = await loadProject(project.id)
    assert.equal(restored.project.title, project.title)
    assert.equal(restored.savedAt, savedAt)
    assert.equal(await restored.blobs.get(asset.id).text(), await blob.text())
    restored.revoke()
  } finally { IDBObjectStore.prototype.put = originalPut; URL.revokeObjectURL(asset.url) }
})

test('素材抓取失败不会覆盖之前版本，并且后续保存仍能继续', async () => {
  globalThis.indexedDB = new IDBFactory()
  const { project, asset, blob } = fixture()
  try {
    const savedAt = await saveProject(project, new Map([[asset.id, blob]]))
    const extra = { ...asset, id: 'missing-media', url: 'blob:missing' }
    await assert.rejects(saveProject(addAsset({ ...project, title: '缺素材版本' }, extra)), /读取失败/)
    const restored = await loadProject(project.id)
    assert.equal(restored.project.title, project.title)
    assert.equal(restored.savedAt, savedAt)
    restored.revoke()
    await saveProject({ ...project, title: '恢复后保存' })
    const recovered = await loadProject(project.id)
    assert.equal(recovered.project.title, '恢复后保存')
    recovered.revoke()
  } finally { URL.revokeObjectURL(asset.url) }
})

test('并发保存按调用顺序提交，每次返回对应写入的时间', async t => {
  globalThis.indexedDB = new IDBFactory()
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-17T11:00:00.000Z') })
  const { project, asset } = fixture()
  const originalPut = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (...args) {
    const result = originalPut.apply(this, args)
    if (this.name === 'projects') t.mock.timers.tick(1_000)
    return result
  }
  try {
    const first = saveProject(project)
    const second = saveProject({ ...project, title: '最新标题' })
    const times = await Promise.all([first, second])
    assert.deepEqual(times, ['2026-10-17T11:00:00.000Z', '2026-10-17T11:00:01.000Z'])
    const restored = await loadProject(project.id)
    assert.equal(restored.project.title, '最新标题')
    assert.equal(restored.savedAt, times[1])
    restored.revoke()
  } finally { IDBObjectStore.prototype.put = originalPut; URL.revokeObjectURL(asset.url) }
})

test('写入请求完成但事务中止时，不返回新保存时间，也不覆盖之前的时间', async t => {
  globalThis.indexedDB = new IDBFactory()
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-17T12:00:00.000Z') })
  const project = createProject('保留的草稿')
  const previousSavedAt = await saveProject(project)
  t.mock.timers.tick(5_000)
  const originalPut = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (...args) {
    const result = originalPut.apply(this, args)
    if (this.name === 'projects') result.addEventListener('success', () => this.transaction.abort())
    return result
  }
  try {
    await assert.rejects(saveProject({ ...project, title: '应撤销的修改' }), /中断|abort/i)
  } finally { IDBObjectStore.prototype.put = originalPut }
  const restored = await loadProject(project.id)
  assert.equal(restored.project.title, project.title)
  assert.equal(restored.savedAt, previousSavedAt)
  restored.revoke()
})

test('原生草稿保留持久预览代理地址，同时保留原件Blob供再次打包', async () => {
  globalThis.indexedDB = new IDBFactory()
  const { project, asset, blob } = fixture()
  const previewUrl = 'http://asset.localhost/app/media/preview/video.mp4'
  const sourceUrl = 'http://asset.localhost/app/media/original/video.mkv'
  Object.assign(project.assets[0], { nativePath: '/app/media/original/video.mkv', url: previewUrl, sourceUrl })
  try {
    await saveProject(project, new Map([[asset.id, blob]]))
    const restored = await loadProject(project.id)
    assert.equal(restored.project.assets[0].url, previewUrl)
    assert.equal(restored.project.assets[0].sourceUrl, sourceUrl)
    assert.equal(restored.project.assets[0].nativePath, '/app/media/original/video.mkv')
    assert.equal(await restored.blobs.get(asset.id).text(), await blob.text())
    restored.revoke()
  } finally { URL.revokeObjectURL(asset.url) }
})

test('持久原生素材保存只记录路径，不读取或复制原件到本地草稿', async t => {
  globalThis.indexedDB = new IDBFactory()
  const { project, asset } = fixture()
  const previewUrl = 'http://asset.localhost/app/media/preview/video.mp4'
  const sourceUrl = 'http://asset.localhost/app/media/original/video.mkv'
  Object.assign(project.assets[0], { nativePath: '/app/media/original/video.mkv', url: previewUrl, sourceUrl })
  const originalFetch = globalThis.fetch, originalGet = IDBObjectStore.prototype.get, originalPut = IDBObjectStore.prototype.put
  t.after(() => { globalThis.fetch = originalFetch; IDBObjectStore.prototype.get = originalGet; IDBObjectStore.prototype.put = originalPut; URL.revokeObjectURL(asset.url) })
  globalThis.fetch = async () => { assert.fail('持久素材不应读取原文件') }
  IDBObjectStore.prototype.get = function (...args) {
    assert.notEqual(this.name, 'blobs', '保存不应读取原生素材Blob')
    return originalGet.apply(this, args)
  }
  IDBObjectStore.prototype.put = function (...args) {
    assert.notEqual(this.name, 'blobs', '保存不应复制原生素材Blob')
    return originalPut.apply(this, args)
  }
  await saveProject(project)
  await saveProject({ ...project, title: '原生素材第二次保存' })
  IDBObjectStore.prototype.get = originalGet
  const restored = await loadProject(project.id)
  assert.equal(restored.project.assets[0].url, previewUrl)
  assert.equal(restored.project.assets[0].sourceUrl, sourceUrl)
  assert.equal(restored.blobs.size, 0)
  restored.revoke()
})

test('原生素材仍使用临时URL时保存原件字节，恢复后要求重新建立持久素材', async () => {
  globalThis.indexedDB = new IDBFactory()
  const { project, asset, blob } = fixture()
  project.assets[0].nativePath = '/app/media/original/old-video.webm'
  try {
    await saveProject(project, new Map([[asset.id, blob]]))
    URL.revokeObjectURL(asset.url)
    const restored = await loadProject(project.id)
    assert.equal(restored.project.assets[0].nativePath, undefined)
    assert.notEqual(restored.project.assets[0].url, asset.url)
    assert.equal(await (await fetch(restored.project.assets[0].url)).text(), await blob.text())
    restored.revoke()
  } finally { URL.revokeObjectURL(asset.url) }
})

test('响应体读取时发生NotFoundError也能指出素材名称，不泄漏含糊英文', async t => {
  const { asset } = fixture()
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch; URL.revokeObjectURL(asset.url) })
  const failure = new DOMException('The object can not be found here.', 'NotFoundError')
  globalThis.fetch = async () => ({ ok: true, blob: async () => { throw failure } })
  await assert.rejects(fetchAssetBlob(asset), error => {
    assert.match(error.message, /本地\.webm.*读取失败/)
    assert.doesNotMatch(error.message, /The object/)
    assert.equal(error.cause, failure)
    return true
  })
})
