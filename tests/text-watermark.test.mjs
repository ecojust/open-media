import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS } from '../src/core/project.ts'
import { addTextWatermark } from '../src/core/watermark-track.ts'
import { createHistory, commitHistory, undoHistory, redoHistory, findClip } from '../src/core/timeline.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'

const template = {
  id: 'editable-title', name: '章节标题', category: '可编辑文字', tags: ['章节', '旅行'], kind: 'text',
  url: '', poster: '/watermarks/editable-title.png', duration: 5, width: 640, height: 360, placement: 'bottom-center',
  textTemplate: { text: '这是我们的故事\n下一站见', color: '#ffcc55', background: '#242a44', fontFamily: 'sans-serif', fontWeight: 700, textAlign: 'center', fontSize: 40, width: 400, height: 120 },
}

function allClips(project) { return project.tracks.flatMap(track => track.clips) }

test('文字水印保持原生文本及样式，从精确刻度插入且添加与撤销都是完整事务', () => {
  const original = createProject('文字水印', { width: 640, height: 360 })
  const before = structuredClone(original), material = structuredClone(template)
  const result = addTextWatermark(original, material, 3.25), found = findClip(result.project, result.clipId)
  assert.equal(found.track.kind, 'text'); assert.equal(found.track.name, '文字水印轨道')
  assert.equal(result.project.tracks[0].id, result.trackId)
  const clip = found.clip
  assert.equal(clip.start, 3.25); assert.equal(clip.trimOut, 5)
  for (const name of ['text', 'color', 'background', 'fontFamily', 'fontWeight', 'textAlign', 'fontSize', 'width', 'height']) assert.equal(clip[name], template.textTemplate[name])
  assert.equal(clip.assetId, undefined); assert.equal(clip.volume, 0)
  assert.equal(result.project.assets.length, 0)
  assert.deepEqual(original, before); assert.deepEqual(material, template)
  const history = commitHistory(createHistory(original), result.project)
  assert.deepEqual(undoHistory(history).present, original)
  assert.deepEqual(redoHistory(undoHistory(history)).present, result.project)
})

test('复用空闲文字水印轨道，重叠或锁定时新增前景轨道且不改原内容', () => {
  const first = addTextWatermark(createProject(), template, 1)
  const adjacent = addTextWatermark(first.project, template, 6)
  assert.equal(adjacent.trackId, first.trackId)
  assert.equal(adjacent.project.tracks.length, first.project.tracks.length)
  const overlap = addTextWatermark(first.project, template, 3)
  assert.notEqual(overlap.trackId, first.trackId)
  assert.deepEqual(findClip(overlap.project, first.clipId).clip, findClip(first.project, first.clipId).clip)
  const locked = structuredClone(first.project); locked.tracks[0].locked = true
  const added = addTextWatermark(locked, template, 7)
  assert.notEqual(added.trackId, first.trackId)
  assert.equal(added.project.tracks.find(track => track.id === first.trackId).locked, true)
})

test('文字水印保存为项目文本数据，重开可继续修改且不生成烘焙媒体文件', async () => {
  const result = addTextWatermark(createProject(), template, 2.5)
  const clip = findClip(result.project, result.clipId).clip
  clip.text = '保存后继续编辑'; clip.color = '#ff00ff'; clip.fontSize = 72; clip.x = 27; clip.y = 44
  const archive = await exportProjectFile(result.project, { blobs: new Map() })
  const reopened = await importProjectFile(archive)
  try {
    assert.deepEqual(findClip(reopened.project, result.clipId).clip, clip)
    assert.equal(reopened.project.assets.length, 0); assert.equal(reopened.blobs.size, 0)
    assert.equal(findClip(reopened.project, result.clipId).track.kind, 'text')
  } finally { reopened.revoke() }
})

test('素材数量已满仍可添加原生文字；片段或轨道容量不足时整体拒绝', () => {
  const project = createProject()
  project.assets = Array.from({ length: MAX_ASSETS }, (_, index) => ({ id: `asset-${index}`, name: '图片.png', kind: 'image', url: `blob:image-${index}`, duration: 0, width: 20, height: 20, size: 80, mime: 'image/png' }))
  const result = addTextWatermark(project, template, 0)
  assert.equal(result.project.assets.length, MAX_ASSETS)
  assert.equal(allClips(result.project).length, 1)
  const fullTracks = createProject(); fullTracks.tracks = Array.from({ length: MAX_TRACKS }, () => createTrack('text'))
  assert.throws(() => addTextWatermark(fullTracks, template, 0), /100 条轨道/)
  fullTracks.tracks.at(-1).name = '文字水印轨道'
  assert.equal(addTextWatermark(fullTracks, template, 0).project.tracks.length, MAX_TRACKS)
  const fullClips = createProject(), clip = allClips(result.project)[0]
  fullClips.tracks[0].clips = Array.from({ length: MAX_CLIPS }, (_, index) => ({ ...clip, id: `clip-${index}` }))
  const snapshot = structuredClone(fullClips)
  assert.throws(() => addTextWatermark(fullClips, template, 0), /10000 个片段/)
  assert.deepEqual(fullClips, snapshot)
})

test('损坏模板、非有限尺寸和跨日边界被明确拒绝，不能悄悄截断时长', () => {
  const project = createProject(), snapshot = structuredClone(project)
  assert.throws(() => addTextWatermark(project, { ...template, kind: 'image' }, 0), /文字水印/)
  assert.throws(() => addTextWatermark(project, { ...template, textTemplate: undefined }, 0), /文字水印/)
  for (const property of ['width', 'height', 'fontSize']) for (const value of [0, NaN, Infinity, -1]) {
    assert.throws(() => addTextWatermark(project, { ...template, textTemplate: { ...template.textTemplate, [property]: value } }, 0), /尺寸/)
  }
  for (const start of [-1, NaN, Infinity, MAX_PROJECT_DURATION - 4.999]) assert.throws(() => addTextWatermark(project, template, start), /起点|24 小时/)
  const end = addTextWatermark(project, template, MAX_PROJECT_DURATION - 5)
  assert.equal(findClip(end.project, end.clipId).clip.start, MAX_PROJECT_DURATION - 5)
  assert.throws(() => addTextWatermark(project, { ...template, textTemplate: { ...template.textTemplate, color: 'invalid' } }, 0), /颜色/)
  assert.deepEqual(project, snapshot)
})

test('目录中的 100 种文字模板均可在横竖画幅生成可编辑文字，内容完整且尺寸不越界', async () => {
  const { WATERMARK_MATERIALS } = await import('../src/core/watermark-library.ts')
  const materials = WATERMARK_MATERIALS.filter(material => material.kind === 'text')
  assert.equal(materials.length, 100)
  for (const dimensions of [{ width: 640, height: 360 }, { width: 360, height: 640 }]) for (const material of materials) {
    const project = createProject('文字模板校验', dimensions)
    const result = addTextWatermark(project, material, 1.25), clip = findClip(result.project, result.clipId).clip
    assert.equal(clip.text, material.textTemplate.text, `${material.id} 不能丢失可编辑原文`)
    assert.equal(clip.assetId, undefined)
    assert(clip.x >= 0 && clip.y >= 0 && clip.x + clip.width <= dimensions.width && clip.y + clip.height <= dimensions.height, `${material.id} 应适配当前画幅`)
  }
})
