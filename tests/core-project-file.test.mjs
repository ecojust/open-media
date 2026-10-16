import test from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, strToU8, unzipSync } from 'fflate'
import { createProject } from '../src/core/project.ts'
import { addAsset } from '../src/core/timeline.ts'
import { exportProjectFile, importProjectFile, MAX_PORTABLE_BYTES } from '../src/core/project-file.ts'

function fixture() {
  const blob = new Blob(['media-test-bytes'], { type: 'video/webm' })
  const asset = { id: 'asset-portable', name: '演示.webm', kind: 'video', url: URL.createObjectURL(blob), nativePath: '/private/user/演示.webm', duration: 10, width: 640, height: 480, size: blob.size, mime: blob.type }
  return { blob, asset, project: addAsset(createProject('便携测试'), asset) }
}

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
