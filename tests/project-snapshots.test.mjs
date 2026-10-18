import test from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'
import { createProject, createClip, cloneProject } from '../src/core/project.ts'
import { createProjectSnapshot, listProjectSnapshots, loadProjectSnapshot, prepareSnapshotRestore, deleteProjectSnapshot, compareProjectSnapshot, SNAPSHOT_LIMITS } from '../src/core/project-snapshots.ts'

function fixture() {
  const project = createProject('含真实媒体的版本')
  const blob = new Blob([new Uint8Array([12, 34, 56, 78])], { type: 'video/webm' })
  const asset = { id: 'video-one', name: 'source.webm', kind: 'video', url: URL.createObjectURL(blob), size: blob.size, mime: blob.type, duration: 5, width: 1280, height: 720 }
  project.assets.push(asset); project.tracks.find(track => track.kind === 'video').clips.push(createClip(asset, project))
  return { project, blob, blobs: new Map([[asset.id, blob]]) }
}
test('快照内嵌媒体，撤销旧URL后跨模块重开恢复真实字节和原ID', async () => {
  globalThis.indexedDB = new IDBFactory()
  const { project, blobs } = fixture(), original = cloneProject(project)
  const saved = await createProjectSnapshot(project, '第一次剪辑', { blobs, sourceRevision: 7 })
  URL.revokeObjectURL(project.assets[0].url)
  const reopened = await import('../src/core/project-snapshots.ts?fresh=1')
  assert.deepEqual((await reopened.listProjectSnapshots(project.id))[0], saved)
  const loaded = await reopened.loadProjectSnapshot(project.id, saved.id)
  try {
    assert.equal(loaded.project.id, project.id)
    assert.deepEqual(new Uint8Array(await loaded.blobs.get('video-one').arrayBuffer()), new Uint8Array([12, 34, 56, 78]))
    assert.equal(loaded.project.tracks.find(track => track.kind === 'video').clips[0].id, original.tracks.find(track => track.kind === 'video').clips[0].id)
    assert.notEqual(loaded.project.assets[0].url, original.assets[0].url)
  } finally { loaded.revoke() }
  assert.deepEqual(project, original)
})
test('命名版本比较包含设置、片段、标记和同ID媒体内容变化', async () => {
  globalThis.indexedDB = new IDBFactory()
  const { project, blobs } = fixture()
  const first = await createProjectSnapshot(project, '原始', { blobs })
  const unchanged = await compareProjectSnapshot(project, first.id, undefined, { blobs })
  assert.equal(unchanged.identical, true)
  const changed = cloneProject(project); changed.title = '修改标题'; changed.tracks.find(track => track.kind === 'video').clips[0].start = 2
  changed.markers = [{ id: 'chapter', time: 1, label: '章节', kind: 'chapter' }]
  const replaced = new Map([['video-one', new Blob([new Uint8Array([78, 56, 34, 12])], { type: 'video/webm' })]])
  const second = await createProjectSnapshot(changed, '第二版', { blobs: replaced })
  const diff = await compareProjectSnapshot(project, first.id, second.id)
  assert.equal(diff.identical, false); assert.equal(diff.settings[0].field, 'title')
  assert.deepEqual(diff.assets.changed, ['video-one']); assert.equal(diff.clips.changed.length, 1); assert.deepEqual(diff.markers.added, ['chapter'])
  assert.equal(diff.contentCompared, true)
  URL.revokeObjectURL(project.assets[0].url)
})
test('缺失媒体、取消、过期项目及非法名称不留下半个版本', async () => {
  globalThis.indexedDB = new IDBFactory()
  const { project, blobs } = fixture()
  URL.revokeObjectURL(project.assets[0].url)
  await assert.rejects(createProjectSnapshot(project, '缺失'), /读取失败/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(createProjectSnapshot(project, '取消', { blobs, signal: controller.signal }), /取消/)
  let calls = 0
  await assert.rejects(createProjectSnapshot(project, '过期', { blobs, assertCurrent() { if (++calls > 2) throw new Error('版本过期') } }), /版本过期/)
  await assert.rejects(createProjectSnapshot(project, '  ', { blobs }), /名称/)
  assert.deepEqual(await listProjectSnapshots(project.id), [])
})
test('版本属于原工程，跨工程读取/删除拒绝；删除同时移除媒体包', async () => {
  globalThis.indexedDB = new IDBFactory()
  const project = createProject(), other = createProject()
  const saved = await createProjectSnapshot(project, '版本')
  await assert.rejects(loadProjectSnapshot(other.id, saved.id), /其他工程/)
  await assert.rejects(deleteProjectSnapshot(other.id, saved.id), /其他工程/)
  assert.equal((await listProjectSnapshots(project.id)).length, 1)
  await deleteProjectSnapshot(project.id, saved.id)
  assert.deepEqual(await listProjectSnapshots(project.id), [])
  await assert.rejects(loadProjectSnapshot(project.id, saved.id), /不存在/)
})
test('并发创建仍受同一事务配额约束，不自动删除旧版本', async () => {
  globalThis.indexedDB = new IDBFactory()
  const project = createProject()
  const results = await Promise.allSettled(Array.from({ length: SNAPSHOT_LIMITS.count + 1 }, (_, i) => createProjectSnapshot(project, `版本${i}`)))
  assert.equal(results.filter(item => item.status === 'fulfilled').length, SNAPSHOT_LIMITS.count)
  const failure = results.find(item => item.status === 'rejected')
  assert.match(failure.reason.message, /100/)
  assert.equal((await listProjectSnapshots(project.id)).length, SNAPSHOT_LIMITS.count)
})

async function changeStored(id, store, change) {
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open('open-media-project-snapshots', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(store, 'readwrite')
      transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error)
      const request = transaction.objectStore(store).get(id)
      request.onsuccess = () => { const value = change(request.result); store === 'archives' ? transaction.objectStore(store).put(value, id) : transaction.objectStore(store).put(value) }
    })
  } finally { db.close() }
}
test('损坏的版本包与不一致素材哈希拒绝恢复', async () => {
  globalThis.indexedDB = new IDBFactory()
  const { project, blobs } = fixture()
  const first = await createProjectSnapshot(project, '校验哈希', { blobs })
  await changeStored(first.id, 'versions', record => ({ ...record, assetHashes: { 'video-one': '0'.repeat(64) } }))
  await assert.rejects(loadProjectSnapshot(project.id, first.id), /校验清单不一致/)
  const second = await createProjectSnapshot(project, '校验ZIP', { blobs })
  await changeStored(second.id, 'archives', blob => new Blob([new Uint8Array(blob.size)]))
  await assert.rejects(loadProjectSnapshot(project.id, second.id), /损坏/)
  URL.revokeObjectURL(project.assets[0].url)
})
test('全工程容量超限拒绝新版本，不改动现有版本', async () => {
  globalThis.indexedDB = new IDBFactory()
  const project = createProject(), other = createProject()
  const first = await createProjectSnapshot(project, '已有版本')
  await changeStored(first.id, 'versions', record => ({ ...record, storageBytes: SNAPSHOT_LIMITS.totalBytes }))
  await assert.rejects(createProjectSnapshot(other, '超限'), /1 GiB/)
  assert.equal((await listProjectSnapshots(project.id)).length, 1)
  assert.deepEqual(await listProjectSnapshots(other.id), [])
})
test('恢复重映射所有媒体引用，保留工程和片段ID，独立旧资产缓存并移交URL所有权', async () => {
  globalThis.indexedDB = new IDBFactory()
  const { project, blobs } = fixture()
  const saved = await createProjectSnapshot(project, '可撤销恢复', { blobs })
  const loaded = await loadProjectSnapshot(project.id, saved.id)
  const temporaryUrl = loaded.project.assets[0].url
  const restored = prepareSnapshotRestore(loaded)
  try {
    assert.equal(restored.project.id, project.id)
    assert.notEqual(restored.project.assets[0].id, 'video-one')
    const oldClip = project.tracks.find(track => track.kind === 'video').clips[0]
    const restoredClip = restored.project.tracks.find(track => track.kind === 'video').clips[0]
    assert.equal(restoredClip.id, oldClip.id)
    assert.equal(restoredClip.assetId, restored.project.assets[0].id)
    assert.equal(restored.blobs.has('video-one'), false)
    assert.equal(blobs.has('video-one'), true)
    await assert.rejects(fetch(temporaryUrl))
    assert.equal((await fetch(restored.project.assets[0].url)).ok, true)
    assert.equal((await fetch(project.assets[0].url)).ok, true)
    assert.equal((await compareProjectSnapshot(restored.project, saved.id, undefined, { blobs: restored.blobs })).identical, true, '安全重映射素材ID不应伪造内容差异')
  } finally { restored.revoke(); URL.revokeObjectURL(project.assets[0].url) }
})
