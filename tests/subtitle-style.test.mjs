import test from 'node:test'
import assert from 'node:assert/strict'
import { createClip, createProject, createTextClip, createSubtitleClip, createTrack, validateProject } from '../src/core/project.ts'
import { addClip, applySubtitleStyleToTrack, updateClip, findClip, deleteClip, setTrack, moveClip, createHistory, commitHistory, undoHistory, redoHistory } from '../src/core/timeline.ts'
import { addTextWatermark } from '../src/core/watermark-track.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'

const style = {
  x: 123, y: 240, width: 800, height: 140, rotation: 12, opacity: 0.8, fadeIn: 0.4, fadeOut: 0.7,
  fontSize: 42, fontFamily: 'serif', fontWeight: 700, color: '#ffcc55', background: '#223344', textAlign: 'left', textVerticalAlign: 'bottom',
}
const watermark = {
  id: 'text-watermark', name: '章节标题', kind: 'text', category: '文字', tags: [], url: '', poster: '', duration: 5, width: 640, height: 360,
  textTemplate: { text: '旅途', color: '#ffffff', background: 'transparent', fontFamily: 'sans-serif', fontWeight: 600, textAlign: 'center', fontSize: 40, width: 320, height: 100 },
}
function fixture() {
  let project = createProject('字幕样式')
  const clip = createSubtitleClip(project, { text: '第一句字幕', generatedAt: '2026-01-01T00:00:00.000Z', start: 3, trimOut: 9 })
  project = addClip(project, project.tracks[0].id, clip)
  return { project, clip }
}
function matches(clip, expected) {
  for (const [key, value] of Object.entries(expected)) assert.equal(clip[key], value, key)
}

test('新增字幕继承最后调整的全部视觉配置，独立生成正文、时间和标识', () => {
  const { project, clip } = fixture()
  const next = updateClip(project, clip.id, style)
  assert.equal(project.subtitleStyle, undefined)
  const second = createSubtitleClip(next, { text: '在这里输入字幕', start: 12.5 })
  matches(second, style)
  assert.equal(second.text, '在这里输入字幕'); assert.equal(second.start, 12.5)
  assert.equal(second.trimIn, 0); assert.equal(second.trimOut, 5); assert.equal(second.speed, 1)
  assert.notEqual(second.id, clip.id); assert.notEqual(second.generatedAt, clip.generatedAt)
  assert.equal(second.textRole, 'subtitle'); assert.equal(second.assetId, undefined); assert.equal(second.speech, undefined)
  assert.equal(findClip(next, clip.id).clip.generatedAt, clip.generatedAt)
  const another = createSubtitleClip(createProject())
  assert.equal(another.fontSize, 64); assert.equal(another.x, 192)
})

test('最后修改的字幕成为来源，选择、正文、时间变化及未改变的样式不覆盖记忆', () => {
  const { project, clip } = fixture()
  let next = updateClip(project, clip.id, style)
  const second = createSubtitleClip(next)
  next = addClip(next, project.tracks[0].id, second)
  next = updateClip(next, second.id, { fontSize: 78, x: 400 })
  next = updateClip(next, clip.id, { text: '改正文', start: 7, trimOut: 0.2, x: style.x })
  assert.equal(findClip(next, clip.id).clip.fadeOut, 0.2, '时长裁剪可缩短当前字幕淡出，但不改变下一条字幕默认值')
  matches(createSubtitleClip(next), { ...style, fontSize: 78, x: 400 })
  next = updateClip(next, clip.id, { y: 300 })
  matches(createSubtitleClip(next), { ...style, y: 300, fadeIn: 0.2, fadeOut: 0.2 })
  const snapshot = structuredClone(next)
  assert.throws(() => updateClip(next, clip.id, { width: 0 }), /宽度/)
  assert.deepEqual(next, snapshot)
  const locked = setTrack(next, project.tracks[0].id, { locked: true })
  assert.throws(() => updateClip(locked, clip.id, { x: 900 }), /解锁/)
  assert.deepEqual(locked.subtitleStyle, next.subtitleStyle)
})

test('默认样式与同一次编辑一起撤销重做，删除来源字幕后继续保留，项目文件重开可继承', async () => {
  const { project, clip } = fixture()
  const edited = updateClip(project, clip.id, style)
  const history = commitHistory(createHistory(project), edited)
  const undone = undoHistory(history)
  assert.equal(undone.present.subtitleStyle, undefined)
  assert.equal(createSubtitleClip(undone.present).fontSize, 64)
  matches(createSubtitleClip(redoHistory(undone).present), style)
  const deleted = deleteClip(edited, clip.id)
  matches(createSubtitleClip(deleted), style)
  for (const source of [edited, deleted]) {
    const reopened = await importProjectFile(await exportProjectFile(source))
    try { matches(createSubtitleClip(reopened.project), style); assert.deepEqual(reopened.project.subtitleStyle, style) }
    finally { reopened.revoke() }
  }
})

test('文字水印模板独立于字幕样式，轨道改名或移动后仍不会污染字幕记忆', () => {
  const { project, clip } = fixture()
  let next = updateClip(project, clip.id, style)
  const result = addTextWatermark(next, watermark, 0)
  next = result.project
  const text = findClip(next, result.clipId).clip
  assert.equal(text.fontSize, 120, '水印按自身模板缩放，不能套用字幕的42号字')
  assert.equal(text.rotation, 0); assert.equal(text.textRole, 'watermark')
  next = setTrack(next, result.trackId, { name: '章节装饰' })
  next = moveClip(next, result.clipId, project.tracks[0].id, 0)
  next = updateClip(next, result.clipId, { fontSize: 16, x: 8, background: '#000000' })
  matches(createSubtitleClip(next), style)
  assert.equal(validateProject(next).tracks.flatMap(track => track.clips).find(clip => clip.id === result.clipId).textRole, 'watermark')
})

test('旧文档无需默认样式也可打开，旧字幕编辑可记忆，旧水印用途在首次校验后固定', () => {
  const project = createProject()
  const clip = createTextClip(project)
  delete clip.textRole
  project.tracks[0].clips.push(clip)
  const old = validateProject(project)
  assert.equal(old.subtitleStyle, undefined)
  const renamedSubtitle = setTrack(old, project.tracks[0].id, { name: '文字水印轨道' })
  assert.equal(findClip(renamedSubtitle, clip.id).clip.textRole, 'subtitle')
  matches(createSubtitleClip(updateClip(renamedSubtitle, clip.id, style)), style)
  matches(createSubtitleClip(updateClip(old, clip.id, style)), style)
  project.tracks[0].name = '文字水印轨道'
  const imported = validateProject(project)
  const renamed = setTrack(imported, project.tracks[0].id, { name: '标题装饰' })
  const edited = updateClip(renamed, clip.id, style)
  assert.equal(findClip(edited, clip.id).clip.textRole, 'watermark')
  assert.equal(edited.subtitleStyle, undefined)
})

test('淡入淡出适配新字幕时长但不丢失记忆，损坏的默认样式不可导入', () => {
  const { project, clip } = fixture()
  const edited = updateClip(project, clip.id, { ...style, fadeIn: 7, fadeOut: 8 })
  const next = createSubtitleClip(edited)
  assert.equal(next.fadeIn, 5); assert.equal(next.fadeOut, 5)
  const shorter = createSubtitleClip(edited, { trimOut: 1.2 })
  assert.equal(shorter.fadeIn, 1.2); assert.equal(shorter.fadeOut, 1.2)
  assert.equal(edited.subtitleStyle.fadeOut, 8)
  for (const patch of [{ width: 0 }, { fontSize: 0 }, { x: Infinity }, { opacity: 2 }, { color: 'bad' }, { textAlign: 'invalid' }, { textVerticalAlign: 'invalid' }]) {
    assert.throws(() => validateProject({ ...edited, subtitleStyle: { ...edited.subtitleStyle, ...patch } }), /字幕/)
  }
  assert.throws(() => validateProject({ ...edited, subtitleStyle: null }), /字幕/)
  const clean = validateProject({ ...edited, subtitleStyle: { ...edited.subtitleStyle, text: '不能复用正文', id: 'old', start: 100 } })
  assert.equal(Object.hasOwn(clean.subtitleStyle, 'text'), false)
  assert.equal(Object.hasOwn(clean.subtitleStyle, 'start'), false)
})

test('旧项目字幕及默认样式缺少纵向对齐时保留居中，非法对齐值拒绝导入', () => {
  const { project, clip } = fixture()
  const old = updateClip(project, clip.id, style)
  delete old.subtitleStyle.textVerticalAlign
  delete old.tracks[0].clips[0].textVerticalAlign
  const loaded = validateProject(old)
  assert.equal(loaded.subtitleStyle.textVerticalAlign, 'middle')
  assert.equal(loaded.tracks[0].clips[0].textVerticalAlign, 'middle')
  assert.equal(createSubtitleClip(loaded).textVerticalAlign, 'middle')
  for (const alignment of ['top', 'middle', 'bottom']) {
    const changed = updateClip(loaded, clip.id, { textVerticalAlign: alignment })
    assert.equal(changed.subtitleStyle.textVerticalAlign, alignment)
    assert.equal(changed.tracks[0].clips[0].y, loaded.tracks[0].clips[0].y)
    assert.equal(changed.tracks[0].clips[0].height, loaded.tracks[0].clips[0].height)
  }
  assert.throws(() => updateClip(loaded, clip.id, { textVerticalAlign: 'invalid' }), /纵向对齐/)
})

function trackStyleFixture() {
  const { project, clip } = fixture()
  const sourceStyle = { ...style, fadeIn: 3, fadeOut: 4 }
  Object.assign(project.tracks[0].clips[0], sourceStyle)
  const short = createSubtitleClip(project, { text: '短句内容', name: '保留片段名称', start: 15, trimIn: 1, trimOut: 4, speed: 2, generatedAt: '2026-02-01T00:00:00.000Z' })
  const long = createSubtitleClip(project, { text: '较长的另一句内容', start: 20, trimOut: 8, generatedAt: '2026-02-02T00:00:00.000Z' })
  const movedWatermark = createTextClip(project, { textRole: 'watermark', text: '章节标题', x: 10, color: '#66ccff' })
  project.tracks[0].clips.push(short, long, movedWatermark)
  const otherTrack = createTrack('text', '另一组字幕')
  otherTrack.clips.push(createSubtitleClip(project, { text: '其他轨道', x: 18 }))
  project.tracks.push(otherTrack)
  project.subtitleStyle = { ...style, color: '#224466', fadeOut: 0.1 }
  return { project: validateProject(project, { trusted: true }), sourceId: clip.id, short, long, movedWatermark, otherTrack, sourceStyle }
}

test('同轨道应用字幕属性只调整其他字幕的视觉配置，保留正文、时序、生成时间及已过期配音', () => {
  const setup = trackStyleFixture()
  const { sourceId, short, long, movedWatermark, otherTrack, sourceStyle } = setup
  const asset = { id: 'linked-audio', name: '配音.wav', kind: 'audio', url: 'blob:linked-audio', duration: 3, width: 0, height: 0, size: 20, mime: 'audio/wav' }
  setup.project.assets.push(asset)
  setup.project.tracks[2].locked = true
  setup.project.tracks[2].clips.push(createClip(asset, setup.project, { speech: { textClipId: short.id, text: '旧版短句内容', voiceId: 'local-voice', rate: 1.2 } }))
  const project = validateProject(setup.project, { trusted: true })
  const before = structuredClone(project)
  const next = applySubtitleStyleToTrack(project, sourceId)
  assert.deepEqual(project, before, '不可修改传入项目')
  assert.deepEqual(findClip(next, sourceId).clip, findClip(project, sourceId).clip, '来源字幕不变')
  assert.deepEqual(findClip(next, short.id).clip, { ...findClip(project, short.id).clip, ...sourceStyle, fadeIn: 1.5, fadeOut: 1.5 })
  assert.deepEqual(findClip(next, long.id).clip, { ...findClip(project, long.id).clip, ...sourceStyle })
  assert.deepEqual(findClip(next, movedWatermark.id).clip, findClip(project, movedWatermark.id).clip, '移动过来的文字水印不会被当作字幕')
  assert.deepEqual(next.tracks.find(track => track.id === otherTrack.id), project.tracks.find(track => track.id === otherTrack.id))
  assert.deepEqual(next.tracks[2], project.tracks[2], '关联配音原文与绑定保留，不自动更新或解除')
  assert.deepEqual(next.assets, project.assets)
  assert.deepEqual(next.subtitleStyle, sourceStyle, '新增字幕记忆本次应用的来源样式，不以短字幕裁剪后的值覆盖')
  matches(createSubtitleClip(next), sourceStyle)
})

test('同轨道批量字幕属性一次撤销重做，项目导出重新打开后完整保留', async () => {
  const { project, sourceId, short, long, sourceStyle } = trackStyleFixture()
  const changed = applySubtitleStyleToTrack(project, sourceId)
  const history = commitHistory(createHistory(project), changed)
  assert.equal(history.past.length, 1)
  const undone = undoHistory(history)
  assert.deepEqual(undone.present, project)
  assert.deepEqual(undone.present.subtitleStyle, project.subtitleStyle)
  assert.deepEqual(redoHistory(undone).present, changed)
  const reopened = await importProjectFile(await exportProjectFile(changed))
  try {
    assert.deepEqual(findClip(reopened.project, short.id).clip, findClip(changed, short.id).clip)
    matches(findClip(reopened.project, long.id).clip, sourceStyle)
    assert.deepEqual(reopened.project.subtitleStyle, sourceStyle)
    matches(createSubtitleClip(reopened.project), sourceStyle)
  } finally { reopened.revoke() }
})

test('同轨道字幕属性拒绝锁定、失效和水印来源，无目标或完全相同则不产生历史记录', () => {
  const { project, sourceId, movedWatermark } = trackStyleFixture()
  const before = structuredClone(project)
  assert.throws(() => applySubtitleStyleToTrack(project, 'missing'), /不存在/)
  assert.throws(() => applySubtitleStyleToTrack(project, movedWatermark.id), /请选择字幕/)
  assert.throws(() => applySubtitleStyleToTrack(setTrack(project, project.tracks[0].id, { locked: true }), sourceId), /解锁/)
  assert.deepEqual(project, before)
  const single = fixture()
  assert.equal(applySubtitleStyleToTrack(single.project, single.clip.id), single.project)
  const identical = applySubtitleStyleToTrack(project, sourceId)
  assert.equal(applySubtitleStyleToTrack(identical, sourceId), identical)
  const history = createHistory(identical)
  assert.equal(commitHistory(history, applySubtitleStyleToTrack(history.present, sourceId)), history)
  const mediaAsset = { id: 'video-source', name: '片段.mp4', kind: 'video', url: 'blob:video-source', duration: 5, width: 1920, height: 1080, size: 20, mime: 'video/mp4' }
  project.assets.push(mediaAsset)
  const mediaClip = createClip(mediaAsset, project)
  project.tracks[1].clips.push(mediaClip)
  assert.throws(() => applySubtitleStyleToTrack(validateProject(project, { trusted: true }), mediaClip.id), /请选择字幕/)
})
