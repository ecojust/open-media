import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject, createTrack, createSubtitleClip, createTextClip, createClip, validateProject } from '../src/core/project.ts'
import { createHistory, commitHistory, undoHistory, redoHistory } from '../src/core/timeline.ts'
import { SUBTITLE_STYLE_KEYS, subtitleStyleFromClip } from '../src/core/subtitle-style.ts'
import { applySubtitleStyleUnification, listStyleSubtitles, planSubtitleStyleUnification, subtitleStyleIssues } from '../src/core/subtitle-style-assist.ts'

const sourceStyle = { x: 80, y: 410, width: 960, height: 110, rotation: 2, opacity: 0.9, fadeIn: 0.4, fadeOut: 0.8,
  fontSize: 40, fontFamily: 'serif', fontWeight: 700, color: '#f4d35e', background: '#16324f', textAlign: 'left', textVerticalAlign: 'bottom' }
function fixture() {
  const project = createProject('字幕统一验证')
  const first = createTrack('text', '旁白字幕'), second = createTrack('text', '补充字幕'), locked = createTrack('text', '已完成字幕')
  first.id = 'first'; second.id = 'second'; locked.id = 'locked'; locked.locked = true
  first.clips = [
    createSubtitleClip(project, { id: 'reference', text: '第一句参考', start: 1, trimOut: 3, ...sourceStyle }),
    createSubtitleClip(project, { id: 'target', name: '保留名称', text: '第二句内容', start: 5, trimIn: 0.5, trimOut: 4, speed: 1.2, generatedAt: '2026-10-01T00:00:00.000Z' }),
    createTextClip(project, { id: 'title', textRole: 'watermark', name: '章节标题', text: '第一章', fontSize: 100, start: 0 }),
  ]
  second.clips = [
    createSubtitleClip(project, { id: 'short', text: '短字幕', start: 9, trimIn: 1, trimOut: 1.4, speed: 2 }),
    createSubtitleClip(project, { id: 'animated', text: '保留动画', start: 10, keyframes: { x: [{ time: 0, value: 0 }, { time: 2, value: 100 }] } }),
    createSubtitleClip(project, { id: 'same', text: '样式相同', start: 14, ...sourceStyle }),
  ]
  locked.clips = [createSubtitleClip(project, { id: 'protected', text: '锁定字幕', start: 20 })]
  const asset = { id: 'voice', name: '旁白', kind: 'audio', url: 'blob:voice', duration: 10, width: 0, height: 0, size: 1, mime: 'audio/wav' }
  const audio = createTrack('audio', '配音')
  audio.clips = [createClip(asset, project, { id: 'speech', start: 5, trimOut: 3, speech: { textClipId: 'target', text: '第二句内容', voiceId: 'voice', rate: 1 } })]
  project.assets.push(asset); project.tracks = [first, second, locked, audio]
  return validateProject(project, { trusted: true })
}
const options = { sourceClipId: 'reference', targetTrackIds: ['first', 'second', 'locked'], rememberAsDefault: true }
const clip = (project, id) => project.tracks.flatMap(track => track.clips).find(item => item.id === id)
const identity = clip => Object.fromEntries(Object.entries(clip).filter(([key]) => !SUBTITLE_STYLE_KEYS.includes(key)))

test('字幕统一预览精确列出变更、相同样式、锁定和手动动画，排除标题', () => {
  const project = fixture(), before = structuredClone(project)
  const plan = planSubtitleStyleUnification(project, options)
  assert.deepEqual(plan.changes.map(item => item.clipId), ['target', 'short'])
  assert.deepEqual(plan.locked.map(item => item.clipId), ['protected'])
  assert.deepEqual(plan.animated.map(item => item.clipId), ['animated'])
  assert.deepEqual(plan.unchanged.map(item => item.clipId), ['same'])
  assert.equal(plan.defaultChanged, true)
  assert.deepEqual(project, before)
  assert.equal(listStyleSubtitles(project).some(item => item.clipId === 'title'), false)
})

test('跨轨道统一全部视觉属性，保留正文、裁剪、时间、名称、配音和生成时间', () => {
  const project = fixture(), next = applySubtitleStyleUnification(project, options)
  assert.notEqual(next, project)
  assert.deepEqual(subtitleStyleFromClip(clip(next, 'target')), sourceStyle)
  assert.deepEqual(identity(clip(next, 'target')), identity(clip(project, 'target')))
  for (const id of ['reference', 'title', 'speech', 'protected', 'animated']) assert.deepEqual(clip(next, id), clip(project, id), id)
  assert.deepEqual(next.subtitleStyle, sourceStyle)
  assert.equal(project.subtitleStyle, undefined)
  assert.deepEqual(next.assets, project.assets)
})

test('短字幕淡入淡出按速度与实际时长缩短，默认值仍保留参考字幕完整时长', () => {
  const next = applySubtitleStyleUnification(fixture(), options), short = clip(next, 'short')
  assert.ok(Math.abs(short.fadeIn - 0.2) < 1e-9)
  assert.ok(Math.abs(short.fadeOut - 0.2) < 1e-9)
  assert.equal(next.subtitleStyle.fadeIn, 0.4)
  assert.equal(next.subtitleStyle.fadeOut, 0.8)
  assert.deepEqual(subtitleStyleFromClip(short), { ...sourceStyle, fadeIn: short.fadeIn, fadeOut: short.fadeOut })
})

test('一次历史记录可整体撤销重做字幕与默认样式', () => {
  const original = fixture(), next = applySubtitleStyleUnification(original, options)
  const history = commitHistory(createHistory(original), next), undone = undoHistory(history)
  assert.equal(history.past.length, 1)
  assert.deepEqual(undone.present, original)
  assert.deepEqual(redoHistory(undone).present, next)
  assert.equal(applySubtitleStyleUnification(next, options), next, '重复应用不产生空历史记录')
})

test('可只保存默认样式，也可取消默认更新且仅修改选择的轨道', () => {
  const original = fixture()
  const defaultOnly = applySubtitleStyleUnification(original, { ...options, targetTrackIds: [] })
  assert.deepEqual(defaultOnly.tracks, original.tracks)
  assert.deepEqual(defaultOnly.subtitleStyle, sourceStyle)
  const selected = applySubtitleStyleUnification(original, { ...options, targetTrackIds: ['second'], rememberAsDefault: false })
  assert.equal(selected.subtitleStyle, undefined)
  assert.deepEqual(selected.tracks[0], original.tracks[0])
  assert.notDeepEqual(clip(selected, 'short'), clip(original, 'short'))
})

test('锁定参考字幕仍可只读使用，预览后新增的轨道锁定会在应用时重新检查', () => {
  const original = fixture()
  original.tracks[0].locked = true
  assert.equal(planSubtitleStyleUnification(original, options).source.locked, true)
  assert.deepEqual(planSubtitleStyleUnification(original, options).changes.map(item => item.clipId), ['short'])
  original.tracks[1].locked = true
  const next = applySubtitleStyleUnification(original, { ...options, rememberAsDefault: false })
  assert.equal(next, original)
})

test('所有视觉动画均保留，不把参考动画复制给其他字幕', () => {
  for (const [property, value] of [['x', 0], ['y', 0], ['scaleX', 1], ['scaleY', 1], ['rotation', 0], ['opacity', 1]]) {
    const project = fixture()
    clip(project, 'target').keyframes = { [property]: [{ time: 0, value }] }
    clip(project, 'reference').keyframes = { opacity: [{ time: 0, value: 0 }, { time: 2, value: 1 }] }
    const plan = planSubtitleStyleUnification(project, options)
    assert.equal(plan.source.animated, true)
    assert.ok(plan.animated.some(item => item.clipId === 'target'), property)
    const next = applySubtitleStyleUnification(project, options)
    assert.deepEqual(clip(next, 'target'), clip(project, 'target'))
    assert.equal(clip(next, 'short').keyframes, undefined)
  }
})

test('空字幕与默认文字检查跨轨道按时间排序，排除水印并保留定位信息', () => {
  const project = fixture()
  clip(project, 'target').text = ' \u200b\ufeff '
  clip(project, 'short').text = '在这里输入字幕'
  clip(project, 'protected').text = '双击编辑字幕'
  clip(project, 'title').text = ''
  const issues = subtitleStyleIssues(project)
  assert.deepEqual(issues.map(item => [item.clipId, item.reason, item.trackId, item.start]), [
    ['target', 'empty', 'first', 5], ['short', 'placeholder', 'second', 9], ['protected', 'placeholder', 'locked', 20],
  ])
})

test('无效参考和目标轨道报错且不会部分写入项目，重复目标轨道只计一次', () => {
  const project = fixture(), before = structuredClone(project)
  assert.throws(() => applySubtitleStyleUnification(project, { ...options, sourceClipId: 'title' }), /参考/)
  assert.throws(() => applySubtitleStyleUnification(project, { ...options, targetTrackIds: ['first', 'missing'] }), /轨道/)
  assert.throws(() => applySubtitleStyleUnification(project, { ...options, targetTrackIds: [project.tracks[3].id] }), /轨道/)
  assert.deepEqual(planSubtitleStyleUnification(project, { ...options, targetTrackIds: ['first', 'first'] }).changes.map(item => item.clipId), ['target'])
  assert.deepEqual(project, before)
})
