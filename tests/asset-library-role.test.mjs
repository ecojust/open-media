import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { createProject, validateProject } from '../src/core/project.ts'
import { exportProjectFile, importProjectFile, PROJECT_EXTENSION } from '../src/core/project-file.ts'
import { addWatermark } from '../src/core/watermark-track.ts'
import { addBackgroundMusic } from '../src/core/background-music-track.ts'
import { insertVideoSegment } from '../src/core/video-segment-track.ts'
import { findClip } from '../src/core/timeline.ts'

const addedAt = '2026-10-18T09:30:00.000Z'
const materials = [
  { role: 'watermark', kind: 'image', mime: 'image/jpeg', filename: 'video-segments/graphite-frame.jpg', add: (project, asset) => addWatermark(project, asset, 0) },
  { role: 'background-music', kind: 'audio', mime: 'audio/mpeg', filename: 'background-music/afternoon-groove.mp3', add: (project, asset) => addBackgroundMusic(project, asset, 0) },
  { role: 'video-segment', kind: 'video', mime: 'video/webm', filename: 'video-segments/graphite-frame.webm', add: (project, asset) => insertVideoSegment(project, asset, 'append') },
]

function media(material, patch = {}) {
  return {
    id: `asset-${material.role}`, name: '用户自己的素材', kind: material.kind,
    url: `blob:${material.role}`, sourceUrl: `asset://localhost/original-${material.role}`,
    duration: 5, width: material.kind === 'audio' ? 0 : 1280, height: material.kind === 'audio' ? 0 : 720,
    size: 1234, mime: material.mime, nativePath: `/private/media/${material.role}`, addedAt, ...patch,
  }
}

test('素材库用途在可信与外部项目中均保留，普通及旧版素材不会被自动归类', () => {
  const project = createProject()
  project.assets = [...materials.map(item => media(item, { libraryRole: item.role })), media(materials[0], { id: 'ordinary' })]
  const before = structuredClone(project)
  for (const trusted of [true, false]) {
    const assets = validateProject(project, { trusted }).assets
    assert.deepEqual(assets.map(asset => asset.libraryRole), ['watermark', 'background-music', 'video-segment', undefined])
    assert.equal(Object.hasOwn(assets[3], 'libraryRole'), false)
    for (const [index, asset] of assets.entries()) {
      assert.equal(asset.name, project.assets[index].name)
      assert.equal(asset.addedAt, addedAt)
      assert.equal(asset.nativePath, trusted ? project.assets[index].nativePath : undefined)
      assert.equal(asset.sourceUrl, trusted ? project.assets[index].sourceUrl : undefined)
      assert.equal(asset.url, trusted ? project.assets[index].url : '')
    }
  }
  assert.deepEqual(project, before)
})

test('不接受未知、空、错类型或带空白的素材库用途', () => {
  for (const libraryRole of [null, '', 'ordinary', 'Watermark', 'watermark ', ' background-music', 'video', 1, true, [], {}, ['watermark']]) {
    const project = createProject()
    project.assets.push(media(materials[0], { libraryRole }))
    for (const trusted of [true, false]) assert.throws(() => validateProject(project, { trusted }), /素材库用途/)
  }
})

for (const material of materials) {
  test(`${material.role} 插入保留显式内置用途，普通上传不增加用途`, () => {
    for (const patch of [{}, { libraryRole: material.role }]) {
      const project = createProject()
      const source = media(material, patch)
      const before = structuredClone(source)
      const result = material.add(project, source)
      assert.deepEqual(result.project.assets, [source])
      assert.equal(Object.hasOwn(result.project.assets[0], 'libraryRole'), Object.hasOwn(source, 'libraryRole'))
      assert.equal(findClip(result.project, result.clipId).clip.assetId, source.id)
      assert.equal(project.assets.length, 0)
      assert.deepEqual(source, before)
    }
  })

  test(`${material.role} 重用已有素材不修改用途、名称、路径或其它元数据`, () => {
    for (const patch of [{}, { libraryRole: material.role }]) {
      const project = createProject()
      const source = media(material, patch)
      project.assets.push(source)
      const before = structuredClone(project)
      const incoming = { ...source, name: '不应覆盖原名称', libraryRole: material.role, duration: 2, addedAt: '2026-10-19T00:00:00.000Z', nativePath: '/different/location', url: 'blob:different' }
      const result = material.add(project, incoming)
      assert.deepEqual(result.project.assets, [source])
      assert.equal(Object.hasOwn(result.project.assets[0], 'libraryRole'), Object.hasOwn(source, 'libraryRole'))
      const clip = findClip(result.project, result.clipId).clip
      assert.equal(clip.assetId, source.id)
      assert.equal(clip.name, source.name)
      assert.equal(clip.trimOut, source.duration)
      assert.deepEqual(project, before)
    }
  })
}

test('实际导出及重新导入 .omedia 后保留三种用途、普通素材及原始媒体字节', async () => {
  assert.equal(PROJECT_EXTENSION, '.omedia')
  let project = createProject('素材库用途持久化')
  const blobs = new Map()
  for (const material of materials) {
    const bytes = readFileSync(new URL(`../src/assets/${material.filename}`, import.meta.url))
    const asset = media(material, { libraryRole: material.role, size: bytes.length })
    blobs.set(asset.id, new Blob([bytes], { type: material.mime }))
    project = material.add(project, asset).project
  }
  const ordinary = media(materials[0], { id: 'ordinary', size: blobs.get('asset-watermark').size })
  blobs.set(ordinary.id, blobs.get('asset-watermark'))
  project.assets.push(ordinary)
  const archive = await exportProjectFile(project, { blobs })
  const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()))
  const manifest = JSON.parse(strFromU8(entries['project.json']))
  assert.deepEqual(manifest.project.assets.map(asset => asset.libraryRole), ['watermark', 'background-music', 'video-segment', undefined])
  assert.ok(manifest.project.assets.every(asset => !asset.nativePath && !asset.sourceUrl && asset.url === ''))

  const restored = await importProjectFile(archive)
  try {
    assert.deepEqual(restored.project.assets.map(asset => asset.libraryRole), ['watermark', 'background-music', 'video-segment', undefined])
    assert.equal(Object.hasOwn(restored.project.assets[3], 'libraryRole'), false)
    for (const asset of restored.project.assets) {
      assert.equal(asset.addedAt, addedAt)
      assert.deepEqual(new Uint8Array(await restored.blobs.get(asset.id).arrayBuffer()), new Uint8Array(await blobs.get(asset.id).arrayBuffer()))
      assert.deepEqual(new Uint8Array(await (await fetch(asset.url)).arrayBuffer()), new Uint8Array(await blobs.get(asset.id).arrayBuffer()))
    }
  } finally { restored.revoke() }

  manifest.project.assets[0].libraryRole = 'unknown'
  entries['project.json'] = strToU8(JSON.stringify(manifest))
  await assert.rejects(importProjectFile(zipSync(entries)), /素材库用途/)
})
