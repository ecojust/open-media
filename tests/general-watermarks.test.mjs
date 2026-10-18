import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { GENERAL_WATERMARK_MATERIALS as materials } from '../src/core/general-watermark-catalog.ts'
import { WATERMARK_MATERIALS } from '../src/core/watermark-library.ts'
import { createProject, MAX_PROJECT_DURATION } from '../src/core/project.ts'
import { addTextWatermark } from '../src/core/watermark-track.ts'
import { animatedClipAt } from '../src/core/visual-animation.ts'
import { createHistory, commitHistory, undoHistory, redoHistory, findClip, updateClip } from '../src/core/timeline.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'

const root = new URL('../public/watermarks/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('general-manifest.json', root)))
const sample = materials.find(item => item.id === 'general-step-card')

test('24 个通用模板的排版和用途不同，原有 500 项及 24 项科普素材均保留', () => {
  assert.equal(materials.length, 24)
  assert.equal(new Set(materials.map(item => item.id)).size, 24)
  assert.equal(new Set(materials.map(item => item.name)).size, 24)
  assert.equal(new Set(materials.map(item => JSON.stringify([item.placement, ...['width', 'height', 'fontSize', 'fontFamily', 'textAlign'].map(key => item.textTemplate[key])]))).size, 24, '不能只替换颜色/文案重复计数')
  assert.equal(WATERMARK_MATERIALS.filter(item => !item.collection).length, 500)
  assert.equal(WATERMARK_MATERIALS.filter(item => item.collection === 'science').length, 24)
  assert.equal(WATERMARK_MATERIALS.length, 548)
  for (const item of materials) {
    assert.equal(item.kind, 'text'); assert.equal(item.category, '可编辑文字'); assert.equal(item.collection, 'general')
    assert.equal(item.url, ''); assert(item.tags.includes('通用') && item.tags.includes('可编辑'))
    assert(item.textTemplate.text.trim())
    assert(WATERMARK_MATERIALS.some(entry => entry.id === item.id))
  }
})

test('透明缩略图由真实文字渲染器生成，24 个文件和模板清单无遗漏/重复', () => {
  assert.equal(manifest.renderer, 'drawTextClip + animatedClipAt')
  assert.deepEqual(manifest.materials.map(item => item.id).sort(), materials.map(item => item.id).sort())
  assert.deepEqual(readdirSync(root).filter(name => /^general-.*\.png$/.test(name)).sort(), manifest.materials.map(item => item.file).sort())
  assert.equal(new Set(manifest.materials.map(item => item.sha256)).size, 24)
  for (const item of materials) {
    const record = manifest.materials.find(entry => entry.id === item.id), bytes = readFileSync(new URL(record.file, root))
    assert.deepEqual(record.textTemplate, item.textTemplate); assert.equal(record.placement, item.placement)
    assert.equal(item.poster, `/watermarks/${record.file}`)
    assert.equal(bytes.length, record.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256)
    assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10])
    assert.equal(bytes.readUInt32BE(16), 640); assert.equal(bytes.readUInt32BE(20), 360)
    assert.equal(bytes[25], 6, '透明 PNG 必须保留 RGBA 通道')
    assert(record.visiblePixels > 100 && record.visiblePixels < 640 * 360, `${item.id} 应有真实前景和留白`)
  }
})

test('全部布局适配横竖画幅，直接生成可编辑文字/真实关键帧而不导入封面', () => {
  for (const dimensions of [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }]) for (const material of materials) {
    const project = createProject('通用文字模板', dimensions), before = structuredClone(project), template = structuredClone(material)
    const result = addTextWatermark(project, material, 3.25), clip = findClip(result.project, result.clipId).clip
    assert.equal(clip.start, 3.25); assert.equal(clip.trimOut, material.duration)
    assert.equal(clip.text, material.textTemplate.text); assert.equal(clip.textRole, 'watermark')
    assert.equal(clip.assetId, undefined); assert.deepEqual(result.project.assets, [])
    for (const key of ['color', 'background', 'fontFamily', 'fontWeight', 'textAlign']) assert.equal(clip[key], material.textTemplate[key])
    assert(clip.x >= 0 && clip.y >= 0 && clip.x + clip.width <= project.width && clip.y + clip.height <= project.height)
    const rest = animatedClipAt(clip, clip.start + 2.5)
    for (const key of ['x', 'y', 'width', 'height', 'opacity']) assert.equal(rest[key], clip[key])
    assert.equal(Boolean(clip.keyframes), material.textTemplate.animation !== 'none')
    assert.deepEqual(project, before); assert.deepEqual(material, template)
  }
})

test('添加前覆盖文字、颜色、背景、时长、位置与动画；保存、重开和撤销保留全部编辑数据', async () => {
  const project = createProject('定制模板', { width: 640, height: 360 }), before = structuredClone(project)
  const options = { text: '自定义标题\n自定义说明', color: '#FAEEDD', background: 'transparent', duration: 7.25, placement: 'top-right', animation: 'slide-left' }
  const originalOptions = structuredClone(options), originalMaterial = structuredClone(sample)
  const result = addTextWatermark(project, sample, 2.5, options), clip = findClip(result.project, result.clipId).clip
  assert.equal(clip.text, options.text); assert.equal(clip.color.toLowerCase(), options.color.toLowerCase())
  assert.equal(clip.background, options.background); assert.equal(clip.trimOut, options.duration)
  assert.equal(clip.x, project.width * .96 - clip.width); assert.equal(clip.y, project.height * .04)
  assert(clip.keyframes.x); assert.equal(clip.keyframes.y, undefined)
  assert.equal(clip.keyframes.opacity.at(-1).time, options.duration)
  const edited = updateClip(result.project, clip.id, { fontSize: 31, text: '重新编辑后保存', x: 115, y: 75 }, { translatePositionKeyframes: true })
  const editedClip = findClip(edited, clip.id).clip
  assert.equal(animatedClipAt(editedClip, clip.start + 3).x, 115)
  assert.equal(animatedClipAt(editedClip, clip.start + 3).y, 75)
  const archive = await exportProjectFile(edited, { blobs: new Map() }), reopened = await importProjectFile(archive)
  try { assert.deepEqual(findClip(reopened.project, clip.id).clip, editedClip); assert.equal(reopened.blobs.size, 0) } finally { reopened.revoke() }
  const history = commitHistory(createHistory(project), result.project), undone = undoHistory(history)
  assert.deepEqual(undone.present, before); assert.deepEqual(redoHistory(undone).present, result.project)
  assert.deepEqual(project, before); assert.deepEqual(options, originalOptions); assert.deepEqual(sample, originalMaterial)
})

test('旧模板维持既有淡入淡出；显式选择无动画清除动画，最后一毫秒时长可用', () => {
  const legacy = { ...sample, textTemplate: { ...sample.textTemplate, animation: undefined, fadeIn: .35, fadeOut: .2 } }
  const legacyResult = addTextWatermark(createProject(), legacy, 0), clip = findClip(legacyResult.project, legacyResult.clipId).clip
  assert.equal(clip.fadeIn, .35); assert.equal(clip.fadeOut, .2); assert.equal(clip.keyframes, undefined)
  const still = addTextWatermark(createProject(), legacy, 0, { animation: 'none', duration: .001 })
  const stillClip = findClip(still.project, still.clipId).clip
  assert.equal(stillClip.fadeIn, 0); assert.equal(stillClip.fadeOut, 0); assert.equal(stillClip.keyframes, undefined)
  const atEnd = addTextWatermark(createProject(), sample, MAX_PROJECT_DURATION - .001, { duration: .001 })
  assert.equal(findClip(atEnd.project, atEnd.clipId).clip.trimOut, .001)
})

test('无效定制选项完整拒绝，不能留下轨道或素材残片', () => {
  const project = createProject(), snapshot = structuredClone(project)
  const bad = [null, [], 'text', { unknown: true }, { text: '' }, { text: '  \n ' }, { text: 'x'.repeat(20001) }, { text: null },
    { color: 'red' }, { color: '#123' }, { color: null }, { background: 'red' }, { background: null },
    { duration: NaN }, { duration: Infinity }, { duration: '5' }, { duration: 0 }, { duration: -.1 },
    { placement: 'bottom' }, { placement: null }, { animation: 'unknown' }, { animation: null }]
  for (const options of bad) {
    assert.throws(() => addTextWatermark(project, sample, 0, options), undefined, JSON.stringify(options))
    assert.deepEqual(project, snapshot)
  }
  assert.throws(() => addTextWatermark(project, sample, MAX_PROJECT_DURATION - 4, { duration: 5 }), /24 小时/)
})
