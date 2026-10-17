import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject, createClip, createTextClip, validateProject } from '../src/core/project.ts'
import { addClip, updateClip, findClip, moveClip, duplicateClip, splitClip, createHistory, commitHistory, undoHistory, redoHistory } from '../src/core/timeline.ts'
import { trimClipAtPlayhead } from '../src/core/timeline-editing.ts'
import { applySpeechResults, alignTextToSpeech, planSpeech } from '../src/core/speech.ts'
import { addRecordedAudio } from '../src/core/recording-track.ts'
import { addWatermark, addTextWatermark } from '../src/core/watermark-track.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'

const initial = '2026-10-17T01:02:03.000Z'
const audio = id => ({ id, name: `${id}.wav`, kind: 'audio', url: `blob:${id}`, duration: 3, width: 0, height: 0, size: 32, mime: 'audio/wav' })
const image = { id: 'image', name: '水印.png', kind: 'image', url: 'blob:image', duration: 0, width: 640, height: 360, size: 32, mime: 'image/png' }
const template = { id: 'text', name: '标题', kind: 'text', category: '文字', tags: [], url: '', poster: '', duration: 5, width: 640, height: 360, textTemplate: { text: '可编辑水印', color: '#ffffff', background: 'transparent', fontFamily: 'sans-serif', fontWeight: 600, textAlign: 'center', fontSize: 40, width: 320, height: 100 } }
function clock(t) { t.mock.timers.enable({ apis: ['Date'], now: Date.parse(initial) }) }
function fixture() {
  const original = createProject('片段生成时间')
  const clip = createTextClip(original, { id: 'subtitle', text: '原始字幕' })
  return { project: addClip(original, original.tracks[0].id, clip), clip }
}

test('字幕、媒体、水印和录音统一记录实际加入时间，可显式保留来源时间', t => {
  clock(t)
  const project = createProject()
  assert.equal(createClip(image, project).generatedAt, initial)
  assert.equal(createTextClip(project).generatedAt, initial)
  t.mock.timers.tick(2500)
  const expected = new Date().toISOString()
  const recorded = addRecordedAudio(project, audio('recorded'), 0)
  const watermark = addWatermark(project, image, 0)
  const textWatermark = addTextWatermark(project, template, 0)
  for (const result of [recorded, watermark, textWatermark]) assert.equal(findClip(result.project, result.clipId).clip.generatedAt, expected)
  assert.equal(createTextClip(project, { generatedAt: initial }).generatedAt, initial)
})

test('移动、裁剪、变换、样式、复制及分割保留内容来源时间，仅正文实际改变刷新', t => {
  clock(t)
  const { project, clip } = fixture()
  t.mock.timers.tick(1500)
  const positioned = updateClip(project, clip.id, { x: 100, y: 120, width: 900, height: 120, rotation: 15, fontSize: 45, color: '#ffcc55', text: clip.text })
  const moved = moveClip(positioned, clip.id, positioned.tracks[0].id, 1)
  const trimmed = trimClipAtPlayhead(moved, clip.id, 3, 'end')
  assert.equal(findClip(trimmed, clip.id).clip.generatedAt, initial)
  for (const next of [duplicateClip(trimmed, clip.id), splitClip(trimmed, clip.id, 2)]) {
    assert(next.tracks[0].clips.every(item => item.generatedAt === initial))
  }
  const changed = updateClip(trimmed, clip.id, { text: '新的文字内容' })
  assert.equal(findClip(changed, clip.id).clip.generatedAt, new Date().toISOString())
  const timestamp = findClip(changed, clip.id).clip.generatedAt
  t.mock.timers.tick(1500)
  assert.equal(findClip(updateClip(changed, clip.id, { text: '新的文字内容' }), clip.id).clip.generatedAt, timestamp)
  const cleared = updateClip(changed, clip.id, { text: '' })
  assert.equal(findClip(cleared, clip.id).clip.generatedAt, new Date().toISOString())
})

test('配音重新生成更新音频时间，字幕对齐和其他片段保留各自生成时间', t => {
  clock(t)
  const { project, clip } = fixture()
  const result = (sourceProject, id) => ({ source: planSpeech(sourceProject, [clip.id]).sources[0], asset: audio(id), voiceId: 'local-voice', rate: 1 })
  t.mock.timers.tick(2000)
  const first = applySpeechResults(project, [result(project, 'first')])
  const firstTime = findClip(first.project, first.audioClipIds[0]).clip.generatedAt
  assert.equal(firstTime, new Date().toISOString())
  assert.equal(findClip(first.project, clip.id).clip.generatedAt, initial)
  t.mock.timers.tick(5000)
  const second = applySpeechResults(first.project, [result(first.project, 'second')])
  assert.equal(findClip(second.project, second.audioClipIds[0]).clip.generatedAt, new Date().toISOString())
  assert.notEqual(findClip(second.project, second.audioClipIds[0]).clip.generatedAt, firstTime)
  assert.equal(findClip(second.project, first.audioClipIds[0]), undefined)
  t.mock.timers.tick(2000)
  const aligned = alignTextToSpeech(second.project, [clip.id])
  assert.equal(findClip(aligned.project, clip.id).clip.generatedAt, initial)
  assert.equal(findClip(aligned.project, second.audioClipIds[0]).clip.generatedAt, findClip(second.project, second.audioClipIds[0]).clip.generatedAt)
})

test('旧项目不伪造生成时间，合法时间标准化，损坏的时间拒绝导入', t => {
  clock(t)
  const { project, clip } = fixture()
  delete findClip(project, clip.id).clip.generatedAt
  for (const trusted of [true, false]) {
    const old = validateProject(project, { trusted })
    assert.equal(Object.hasOwn(findClip(old, clip.id).clip, 'generatedAt'), false)
    assert.equal(Object.hasOwn(findClip(updateClip(old, clip.id, { x: 20 }), clip.id).clip, 'generatedAt'), false)
  }
  t.mock.timers.tick(5000)
  assert.equal(findClip(updateClip(project, clip.id, { text: '编辑旧字幕' }), clip.id).clip.generatedAt, new Date().toISOString())
  for (const value of ['', 'invalid', null, 1234, {}, '2026-99-99T00:00:00Z']) {
    const invalid = structuredClone(project)
    findClip(invalid, clip.id).clip.generatedAt = value
    assert.throws(() => validateProject(invalid), /片段生成时间/)
  }
  findClip(project, clip.id).clip.generatedAt = '2026-10-17T09:02:03+08:00'
  assert.equal(findClip(validateProject(project), clip.id).clip.generatedAt, initial)
})

test('项目保存恢复与撤销重做保留准确生成时间，旧字段缺失也原样保留', async t => {
  clock(t)
  const { project, clip } = fixture()
  t.mock.timers.tick(5000)
  const changed = updateClip(project, clip.id, { text: '第二版' })
  const timestamp = findClip(changed, clip.id).clip.generatedAt
  const history = commitHistory(createHistory(project), changed)
  assert.equal(findClip(undoHistory(history).present, clip.id).clip.generatedAt, initial)
  assert.equal(findClip(redoHistory(undoHistory(history)).present, clip.id).clip.generatedAt, timestamp)
  const legacy = structuredClone(project)
  delete findClip(legacy, clip.id).clip.generatedAt
  for (const source of [changed, legacy]) {
    const restored = await importProjectFile(await exportProjectFile(source))
    try { assert.equal(findClip(restored.project, clip.id).clip.generatedAt, findClip(source, clip.id).clip.generatedAt) }
    finally { restored.revoke() }
  }
})
