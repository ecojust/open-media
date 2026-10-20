import test from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, strToU8, unzipSync } from 'fflate'
import { IDBFactory } from 'fake-indexeddb'
import { createProject } from '../src/core/project.ts'
import { addAsset } from '../src/core/timeline.ts'
import { exportProjectFile, importProjectFile, MAX_PORTABLE_BYTES } from '../src/core/project-file.ts'
import { saveProject } from '../src/core/storage.ts'

function fixture() {
  const blob = new Blob(['media-test-bytes'], { type: 'video/webm' })
  const asset = { id: 'asset-portable', name: '演示.webm', kind: 'video', url: URL.createObjectURL(blob), nativePath: '/private/user/演示.webm', duration: 10, width: 640, height: 480, size: blob.size, mime: blob.type }
  return { blob, asset, project: addAsset(createProject('便携测试'), asset) }
}

test('打开有文件名的工程恢复默认或空白名称，保留自定义名称及其余归档校验', async () => {
  const archive = title => zipSync({ 'project.json': strToU8(JSON.stringify({ format: 'open-media-project', version: 1, project: { ...createProject(), title } })) })
  for (const storedTitle of ['未命名项目', '', '   ']) {
    const imported = await importProjectFile(new File([archive(storedTitle)], '演示.最终版本.OMEDIA'))
    try { assert.equal(imported.project.title, '演示.最终版本') } finally { imported.revoke() }
  }
  const named = await importProjectFile(new File([archive('我的剪辑工程')], '另一文件名.omedia'))
  try { assert.equal(named.project.title, '我的剪辑工程') } finally { named.revoke() }
  for (const invalid of [null, 42, {}, '非法\0名称']) await assert.rejects(importProjectFile(new File([archive(invalid)], '不能掩盖错误.omedia')), /项目名称无效/)
  await assert.rejects(importProjectFile(new Blob([archive('')])), /项目名称无效/, '没有文件名时不能替无效归档猜测名称')
})

test('便携项目打包真实素材且不包含本机路径，导入恢复可读对象URL', async () => {
  const { project, blob, asset } = fixture()
  try {
    const file = await exportProjectFile(project)
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()))
    const manifestText = new TextDecoder().decode(files['project.json'])
    assert.equal(manifestText.includes('/private/user'), false)
    assert.equal(manifestText.includes('blob:'), false)
    const imported = await importProjectFile(file)
    try {
      assert.equal(imported.project.assets[0].nativePath, undefined)
      assert.equal(await imported.blobs.get(asset.id).text(), await blob.text())
      assert.equal(await (await fetch(imported.project.assets[0].url)).text(), await blob.text())
    } finally { imported.revoke() }
    await assert.rejects(fetch(imported.project.assets[0].url))
  } finally { URL.revokeObjectURL(asset.url) }
})

test('有预览代理时便携项目仍保存原始素材，移除所有本机URL', async () => {
  const { project, blob, asset } = fixture()
  const preview = new Blob(['preview-only'], { type: 'video/mp4' })
  const previewUrl = URL.createObjectURL(preview)
  project.assets[0].sourceUrl = asset.url
  project.assets[0].url = previewUrl
  try {
    const file = await exportProjectFile(project)
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()))
    assert.equal(new TextDecoder().decode(files[`media/${asset.id}`]), await blob.text())
    const manifest = JSON.parse(new TextDecoder().decode(files['project.json']))
    assert.equal(manifest.project.assets[0].sourceUrl, undefined)
    assert.equal(manifest.project.assets[0].url, '')
    const restored = await importProjectFile(file)
    assert.equal(restored.project.assets[0].sourceUrl, undefined)
    assert.equal(await restored.blobs.get(asset.id).text(), await blob.text())
    restored.revoke()
  } finally { URL.revokeObjectURL(asset.url); URL.revokeObjectURL(previewUrl) }
})

test('缓存Blob后备文件失效时重新读取原件，恢复真实字节而不是预览代理', async () => {
  const { project, blob, asset } = fixture()
  const stale = new Blob(['unreadable cache'], { type: blob.type })
  stale.arrayBuffer = async () => { throw new DOMException('The object can not be found here.', 'NotFoundError') }
  const cached = new Map([[asset.id, stale]])
  const previewUrl = URL.createObjectURL(new Blob(['preview'], { type: 'video/mp4' }))
  project.assets[0].sourceUrl = asset.url
  project.assets[0].url = previewUrl
  try {
    const exported = await exportProjectFile(project, { blobs: cached })
    const entries = unzipSync(new Uint8Array(await exported.arrayBuffer()))
    assert.deepEqual(entries[`media/${asset.id}`], new Uint8Array(await blob.arrayBuffer()))
    assert.equal(await cached.get(asset.id).text(), await blob.text(), '修复缓存，连续保存不会继续读取失效对象')
    assert.equal(project.assets[0].sourceUrl, asset.url, '保存不改写正在编辑的素材来源')
  } finally { URL.revokeObjectURL(asset.url); URL.revokeObjectURL(previewUrl) }
})

test('原件和缓存都不可读时从本地草稿恢复素材并导出完整项目', async t => {
  const previous = globalThis.indexedDB
  globalThis.indexedDB = new IDBFactory()
  t.after(() => { if (previous) globalThis.indexedDB = previous; else delete globalThis.indexedDB })
  const { project, asset, blob } = fixture()
  await saveProject(project, new Map([[asset.id, blob]]))
  URL.revokeObjectURL(asset.url)
  const stale = new Blob(['inaccessible'], { type: blob.type })
  stale.arrayBuffer = async () => { throw new DOMException('The object can not be found here.', 'NotFoundError') }
  const exported = await exportProjectFile(project, { blobs: new Map([[asset.id, stale]]) })
  const restored = await importProjectFile(exported)
  try { assert.equal(await restored.blobs.get(asset.id).text(), await blob.text()) }
  finally { restored.revoke() }
})

test('没有可恢复字节时指出具体素材并停止打包，保留当前项目和缓存', async () => {
  const { project, asset } = fixture()
  URL.revokeObjectURL(asset.url)
  const stale = new Blob(['inaccessible'])
  stale.arrayBuffer = async () => { throw new DOMException('The object can not be found here.', 'NotFoundError') }
  const cached = new Map([[asset.id, stale]])
  const original = JSON.stringify(project)
  await assert.rejects(exportProjectFile(project, { blobs: cached }), error => {
    assert.match(error.message, /演示\.webm.*原件与本地副本均不可用/)
    assert.doesNotMatch(error.message, /The object/)
    return true
  })
  assert.equal(JSON.stringify(project), original)
  assert.equal(cached.get(asset.id), stale)
})

test('素材读取失败不会保存缺素材项目，超大包与取消操作明确报错', async () => {
  const { project, asset } = fixture()
  URL.revokeObjectURL(asset.url)
  await assert.rejects(exportProjectFile(project), /读取失败/)
  project.assets[0].size = MAX_PORTABLE_BYTES + 1
  await assert.rejects(exportProjectFile(project), /256 MB/)
  const controller = new AbortController()
  controller.abort()
  project.assets[0].size = 10
  await assert.rejects(exportProjectFile(project, { signal: controller.signal }), /取消/)
})

test('导入拒绝路径穿越、缺失素材和清单大小不符', async () => {
  const { project, asset, blob } = fixture()
  try {
    const manifest = strToU8(JSON.stringify({ format: 'open-media-project', version: 1, project }))
    await assert.rejects(importProjectFile(zipSync({ 'project.json': manifest, '../outside': strToU8('bad') })), /素材路径/)
    await assert.rejects(importProjectFile(zipSync({ 'project.json': manifest })), /清单/)
    await assert.rejects(importProjectFile(zipSync({ 'project.json': manifest, [`media/${asset.id}`]: strToU8('wrong-size') })), /大小不符/)
    const valid = zipSync({ 'project.json': manifest, [`media/${asset.id}`]: new Uint8Array(await blob.arrayBuffer()) })
    const imported = await importProjectFile(valid)
    assert.equal(imported.project.assets[0].nativePath, undefined)
    imported.revoke()
  } finally { URL.revokeObjectURL(asset.url) }
})

test('媒体字节损坏被CRC检查拦截，而非生成无法播放的项目', async () => {
  const { project, asset } = fixture()
  try {
    const bytes = new Uint8Array(await (await exportProjectFile(project)).arrayBuffer())
    const view = new DataView(bytes.buffer)
    const dataOffset = 30 + view.getUint16(26, true) + view.getUint16(28, true)
    bytes[dataOffset] ^= 0xff
    await assert.rejects(importProjectFile(bytes), /校验失败/)
  } finally { URL.revokeObjectURL(asset.url) }
})

test('在解压前拒绝伪造巨大的解压尺寸', async () => {
  const bytes = zipSync({ 'project.json': strToU8('{}') }, { level: 0 })
  const view = new DataView(bytes.buffer)
  const end = bytes.length - 22
  const directory = view.getUint32(end + 16, true)
  view.setUint32(directory + 24, 0x70000000, true)
  view.setUint32(22, 0x70000000, true)
  await assert.rejects(importProjectFile(bytes), /描述过大/)
})
