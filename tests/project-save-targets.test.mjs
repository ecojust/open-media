import test from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'
import { createProject, validateProject } from '../src/core/project.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'

let moduleId = 0
const fresh = () => import(`../src/core/project-save-targets.ts?instance=${++moduleId}`)
const target = name => ({ kind: 'native', target: { name: `${name}.omedia`, path: `/media/${name}.omedia`, token: `authorized-${name}` } })

async function rawPut(key, value) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('open-media-file-targets', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('targets')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('targets', 'readwrite')
      transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error)
      transaction.objectStore('targets').put(value, key)
    })
  } finally { db.close() }
}

test('本机文件目标按项目保存，新会话恢复且另存只更新当前项目关联', async () => {
  globalThis.indexedDB = new IDBFactory()
  const first = await fresh()
  await first.storeProjectSaveTarget('project-one', target('one'))
  await first.storeProjectSaveTarget('project-two', target('two'))
  const restored = await fresh()
  assert.deepEqual(await restored.loadProjectSaveTarget('project-one'), target('one'))
  assert.deepEqual(await restored.loadProjectSaveTarget('project-two'), target('two'))
  assert.equal(await restored.loadProjectSaveTarget('project-new'), undefined)
  await restored.storeProjectSaveTarget('project-one', target('copy'))
  const reopened = await fresh()
  assert.deepEqual(await reopened.loadProjectSaveTarget('project-one'), target('copy'))
  assert.deepEqual(await reopened.loadProjectSaveTarget('project-two'), target('two'))
  await reopened.storeProjectSaveTarget('project-one', undefined)
  assert.equal(await (await fresh()).loadProjectSaveTarget('project-one'), undefined)
})

test('便携项目不会携带本机保存凭据，也不把导入文档中的保存路径作为授权', async () => {
  globalThis.indexedDB = new IDBFactory()
  const targets = await fresh(), project = createProject('独立的本机目标')
  await targets.storeProjectSaveTarget(project.id, target('private'))
  const loaded = await importProjectFile(await exportProjectFile(project))
  try {
    assert.deepEqual(loaded.project, project)
    assert.equal(JSON.stringify(loaded.project).includes('authorized-private'), false)
    const imported = validateProject({ ...project, id: 'imported-project', saveTarget: target('private'), nativeProjectTarget: target('private').target })
    assert.equal(imported.saveTarget, undefined)
    assert.equal(imported.nativeProjectTarget, undefined)
    assert.equal(await targets.loadProjectSaveTarget(imported.id), undefined)
  } finally { loaded.revoke() }
})

test('损坏记录和伪造文件句柄报错，不把未知目标当作首次保存', async () => {
  globalThis.indexedDB = new IDBFactory()
  const targets = await fresh()
  await rawPut('broken-target', { kind: 'native', target: { path: '/media/private.omedia' } })
  await assert.rejects(targets.loadProjectSaveTarget('broken-target'), /记录无效/)
  await rawPut('fake-browser', { kind: 'browser', handle: { name: 'fake.omedia', getFile: 'not a file handle' } })
  await assert.rejects(targets.loadProjectSaveTarget('fake-browser'), /记录无效/)
  await assert.rejects(targets.storeProjectSaveTarget('../other-project', target('private')), /关联无效/)
})

test('无法持久化真实句柄时保留本次会话目标并报告失败，不覆盖原持久关联', async () => {
  globalThis.indexedDB = new IDBFactory()
  const targets = await fresh()
  await targets.storeProjectSaveTarget('project-one', target('original'))
  const uncloneable = { kind: 'browser', handle: { name: 'session.omedia', getFile() {}, createWritable() {} } }
  await assert.rejects(targets.storeProjectSaveTarget('project-one', uncloneable), { name: 'DataCloneError' })
  assert.strictEqual((await targets.loadProjectSaveTarget('project-one')).handle, uncloneable.handle)
  assert.deepEqual(await (await fresh()).loadProjectSaveTarget('project-one'), target('original'))
})
