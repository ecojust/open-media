import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { SCIENCE_WATERMARK_MATERIALS as materials } from '../src/core/science-watermark-catalog.ts'
import { WATERMARK_CATEGORIES, WATERMARK_MATERIALS } from '../src/core/watermark-library.ts'
import { createProject, validateProject } from '../src/core/project.ts'
import { addTextWatermark, addWatermark } from '../src/core/watermark-track.ts'
import { createHistory, commitHistory, undoHistory, findClip } from '../src/core/timeline.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'
import { chooseWatermarkSource } from '../src/core/watermark-source.ts'

const root = new URL('../public/watermarks/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('science-manifest.json', root)))

test('24 个科普素材为 16 种不同动效和 8 个原生文字模板，保留原五类全部 500 项', () => {
  assert.equal(materials.length, 24)
  assert.equal(materials.filter(item => item.kind === 'video').length, 16)
  assert.equal(materials.filter(item => item.kind === 'text').length, 8)
  assert.equal(new Set(WATERMARK_MATERIALS.map(item => item.id)).size, WATERMARK_MATERIALS.length)
  for (const category of WATERMARK_CATEGORIES) assert.equal(WATERMARK_MATERIALS.filter(item => item.category === category && !item.collection).length, 100)
  for (const item of materials) {
    assert.equal(item.collection, 'science')
    assert(item.tags.includes('科普'))
    assert(WATERMARK_CATEGORIES.includes(item.category))
    assert.equal(item.duration, 4)
    assert.equal(item.width, 640); assert.equal(item.height, 360)
    assert(WATERMARK_MATERIALS.some(entry => entry.id === item.id))
  }
})

test('每项本地文件与清单的大小和摘要一致，双格式及透明缩略图无遗漏', () => {
  assert.deepEqual(manifest.materials.map(item => item.id).sort(), materials.map(item => item.id).sort())
  const files = manifest.materials.flatMap(item => item.files)
  assert.deepEqual(readdirSync(root).filter(name => /^science-.*\.(mp4|webm|png)$/.test(name)).sort(), files.map(item => item.file).sort())
  assert.equal(new Set(files.map(item => item.sha256)).size, files.length, '不同素材和格式不能重复占位')
  for (const item of materials) {
    const record = manifest.materials.find(entry => entry.id === item.id)
    assert.equal(record.kind, item.kind)
    const expected = item.kind === 'video' ? [item.url, item.fallbackUrl, item.poster] : [item.poster]
    assert.deepEqual(record.files.map(file => `/watermarks/${file.file}`).sort(), expected.sort())
    for (const file of record.files) {
      const bytes = readFileSync(new URL(file.file, root))
      assert.equal(bytes.length, file.bytes)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256)
      if (file.file.endsWith('.png')) assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10])
    }
    if (item.kind === 'video') {
      assert.equal(record.fps, 24); assert.equal(record.frames, 96)
      assert.equal(chooseWatermarkSource(item, { canPlayType: () => 'probably' }), item.url)
      assert.equal(chooseWatermarkSource(item, { canPlayType: () => '' }), item.fallbackUrl)
    }
  }
})

test('新动效按当前刻度静音插入、自动抠绿和去溢色，横竖幅可完整撤销', () => {
  for (const dimensions of [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }]) for (const item of materials.filter(item => item.kind === 'video')) {
    const project = createProject('科普动效', dimensions)
    const file = manifest.materials.find(entry => entry.id === item.id).files.find(entry => entry.file.endsWith('.mp4'))
    const asset = { id: item.id, name: item.name, kind: 'video', url: `blob:${item.id}`, duration: item.duration, width: item.width, height: item.height, size: file.bytes, mime: 'video/mp4' }
    const result = addWatermark(project, asset, 3.25, item)
    const clip = findClip(result.project, result.clipId).clip
    assert.equal(clip.start, 3.25); assert.equal(clip.trimOut, 4); assert.equal(clip.volume, 0)
    assert.equal(clip.chromaKey.enabled, true); assert.equal(clip.chromaKey.spillSuppression, true)
    assert(clip.x >= 0 && clip.y >= 0 && clip.x + clip.width <= project.width && clip.y + clip.height <= project.height)
    assert.deepEqual(findClip(validateProject(JSON.parse(JSON.stringify(result.project))), clip.id).clip, clip)
    assert.deepEqual(undoHistory(commitHistory(createHistory(project), result.project)).present, project)
  }
})

test('科普文字保持可编辑源文本及真实淡入淡出，保存后可重开且不导入缩略图', async () => {
  for (const item of materials.filter(item => item.kind === 'text')) {
    const result = addTextWatermark(createProject(), item, 1.5)
    const clip = findClip(result.project, result.clipId).clip
    assert.equal(clip.text, item.textTemplate.text)
    assert.equal(clip.textRole, 'watermark')
    assert.equal(clip.fadeIn, .35); assert.equal(clip.fadeOut, .2)
    assert.equal(clip.assetId, undefined); assert.deepEqual(result.project.assets, [])
    clip.text = '修改后的科普内容'; clip.color = '#ffffff'
    const archive = await exportProjectFile(result.project, { blobs: new Map() })
    const restored = await importProjectFile(archive)
    try { assert.deepEqual(findClip(restored.project, clip.id).clip, clip) } finally { restored.revoke() }
    for (const value of [-1, NaN, Infinity, 4.1]) assert.throws(() => addTextWatermark(createProject(), { ...item, textTemplate: { ...item.textTemplate, fadeIn: value } }, 0), /淡入淡出/)
  }
})
