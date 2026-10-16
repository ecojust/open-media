import test from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { createProject } from '../src/core/project.ts'
import { addAsset } from '../src/core/timeline.ts'
import { deleteProject, listProjects, loadProject, saveProject } from '../src/core/storage.ts'

function fixture() {
  const blob = new Blob(['persisted-media'], { type: 'video/webm' })
  const asset = { id: 'asset-storage', name: '本地.webm', kind: 'video', url: URL.createObjectURL(blob), duration: 10, width: 640, height: 480, size: blob.size, mime: blob.type }
  return { blob, asset, project: addAsset(createProject('本地测试'), asset) }
}

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

test('同步入库异常撤销已排队的删除，原项目及素材保持完整', async () => {
  globalThis.indexedDB = new IDBFactory()
  const { project, asset, blob } = fixture()
  const originalPut = IDBObjectStore.prototype.put
  try {
    await saveProject(project, new Map([[asset.id, blob]]))
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'projects') throw new DOMException('quota exceeded', 'QuotaExceededError')
      return originalPut.apply(this, args)
    }
    await assert.rejects(saveProject({ ...project, title: '不应保存', assets: [] }), /空间不足/)
    IDBObjectStore.prototype.put = originalPut
    const restored = await loadProject(project.id)
    assert.equal(restored.project.title, project.title)
    assert.equal(await restored.blobs.get(asset.id).text(), await blob.text())
    restored.revoke()
  } finally { IDBObjectStore.prototype.put = originalPut; URL.revokeObjectURL(asset.url) }
})

test('素材抓取失败不会覆盖之前版本，并且后续保存仍能继续', async () => {
  globalThis.indexedDB = new IDBFactory()
  const { project, asset, blob } = fixture()
  try {
    await saveProject(project, new Map([[asset.id, blob]]))
    const extra = { ...asset, id: 'missing-media', url: 'blob:missing' }
    await assert.rejects(saveProject(addAsset({ ...project, title: '缺素材版本' }, extra)), /读取失败/)
    const restored = await loadProject(project.id)
    assert.equal(restored.project.title, project.title)
    restored.revoke()
    await saveProject({ ...project, title: '恢复后保存' })
    const recovered = await loadProject(project.id)
    assert.equal(recovered.project.title, '恢复后保存')
    recovered.revoke()
  } finally { URL.revokeObjectURL(asset.url) }
})

test('并发保存按调用顺序提交，较早的慢素材读取不会覆盖后续编辑', async () => {
  globalThis.indexedDB = new IDBFactory()
  const { project, asset } = fixture()
  try {
    const first = saveProject(project)
    const second = saveProject({ ...project, title: '最新标题' })
    await Promise.all([first, second])
    const restored = await loadProject(project.id)
    assert.equal(restored.project.title, '最新标题')
    restored.revoke()
  } finally { URL.revokeObjectURL(asset.url) }
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
