import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAssetAddedAt, stampNewAssets } from '../src/core/asset-times.ts'
import { createProject, validateProject } from '../src/core/project.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'
import { commitHistory, createHistory, redoHistory, undoHistory } from '../src/core/timeline.ts'

const firstTime = '2026-10-17T08:20:01.123Z'
const secondTime = '2026-10-17T08:20:05.678Z'
const thirdTime = '2026-10-17T08:21:12.000Z'
const imageBytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=', 'base64'))
function asset(id, addedAt) {
  return { id, name: '截图.png', kind: 'image', url: `blob:${id}`, duration: 5, width: 1, height: 1, size: imageBytes.length, mime: 'image/png', ...(addedAt !== undefined ? { addedAt } : {}) }
}

test('同名素材按各自加入时间区分，只为本次新加入的素材补时间', () => {
  const original = createProject()
  const first = stampNewAssets({ ...original, assets: [asset('first')] }, original, firstTime)
  const second = stampNewAssets({ ...first, assets: [...first.assets, asset('second')] }, first, secondTime)
  assert.deepEqual(second.assets.map(item => [item.name, item.addedAt]), [['截图.png', firstTime], ['截图.png', secondTime]])
  assert.equal(original.assets.length, 0)
  assert.equal(first.assets.length, 1)
  const third = stampNewAssets({ ...second, title: '项目新名称' }, second, thirdTime)
  assert.deepEqual(third.assets, second.assets)
})

test('旧素材的未知时间不会因修改、重新探测或调用时间戳函数而伪造成现在', () => {
  const previous = createProject()
  previous.assets = [asset('legacy'), asset('known', firstTime)]
  const next = { ...previous, assets: [{ ...previous.assets[0], name: '旧素材新名称', addedAt: thirdTime }, { ...asset('known'), url: 'blob:rehydrated' }] }
  const result = stampNewAssets(next, previous, secondTime)
  assert.equal(result.assets[0].addedAt, undefined)
  assert.equal(Object.hasOwn(result.assets[0], 'addedAt'), false)
  assert.equal(result.assets[1].addedAt, firstTime)
  assert.equal(result.assets[0].name, '旧素材新名称')
  assert.equal(result.assets[1].url, 'blob:rehydrated')
  assert.equal(next.assets[0].addedAt, thirdTime)
  assert.equal(next.assets[1].addedAt, undefined)
})

test('明确携带时间的新素材保留原始时间，跨项目不会错误继承同标识素材的时间', () => {
  const previous = createProject()
  previous.assets = [asset('same-id', firstTime)]
  const different = createProject()
  const withNew = stampNewAssets({ ...different, assets: [asset('same-id'), asset('preserved', secondTime)] }, previous, thirdTime)
  assert.deepEqual(withNew.assets.map(item => item.addedAt), [thirdTime, secondTime])
  const withoutAsset = { ...previous, assets: [] }
  const reintroduced = stampNewAssets({ ...withoutAsset, assets: [asset('same-id')] }, withoutAsset, secondTime)
  assert.equal(reintroduced.assets[0].addedAt, secondTime)
})

test('撤销重做保留同一次加入的时间，不因重做而重新打时间', () => {
  const previous = createProject()
  const next = stampNewAssets({ ...previous, assets: [asset('added')] }, previous, firstTime)
  const history = commitHistory(createHistory(previous), next)
  const undone = undoHistory(history)
  assert.equal(undone.present.assets.length, 0)
  assert.equal(redoHistory(undone).present.assets[0].addedAt, firstTime)
})

test('素材时间验证接受有时区的 ISO 时间并归一化，拒绝无效日期和未注明时区的时间', () => {
  assert.equal(normalizeAssetAddedAt('2026-10-17T16:20:01.123+08:00'), firstTime)
  assert.equal(normalizeAssetAddedAt('2024-02-29T23:59:59Z'), '2024-02-29T23:59:59.000Z')
  const invalid = [null, 123, '', 'not-a-date', '2026-10-17', '2026-10-17T08:20:01', '2026-10-17 08:20:01Z', '2026-02-29T08:20:01Z', '2026-02-30T08:20:01Z', '2026-13-17T08:20:01Z', '2026-10-00T08:20:01Z', '2026-10-17T24:00:00Z', '2026-10-17T08:60:00Z', '2026-10-17T08:20:60Z', '2026-10-17T08:20:01+25:00']
  for (const addedAt of invalid) {
    assert.throws(() => normalizeAssetAddedAt(addedAt), /素材加入时间/)
    const project = createProject()
    project.assets = [asset('invalid', addedAt)]
    assert.throws(() => validateProject(project), /素材加入时间/)
    assert.throws(() => stampNewAssets({ ...project, assets: [asset('new')] }, { ...project, assets: [] }, addedAt), /素材加入时间/)
  }
})

test('便携项目与素材一起保留加入时间，旧素材导出再导入仍然为未知', async () => {
  const project = createProject('素材时间测试')
  project.assets = [asset('dated', firstTime), asset('legacy')]
  const blob = new Blob([imageBytes], { type: 'image/png' })
  const archive = await exportProjectFile(project, { blobs: new Map(project.assets.map(item => [item.id, blob])) })
  const imported = await importProjectFile(archive)
  try {
    assert.equal(imported.project.assets[0].addedAt, firstTime)
    assert.equal(imported.project.assets[1].addedAt, undefined)
    assert.deepEqual(new Uint8Array(await imported.blobs.get('dated').arrayBuffer()), imageBytes)
    assert.deepEqual(new Uint8Array(await imported.blobs.get('legacy').arrayBuffer()), imageBytes)
  } finally {
    imported.revoke()
  }
})
