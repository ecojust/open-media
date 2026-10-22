import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject, createClip, createSubtitleClip, createTrack } from '../src/core/project.ts'
import { clipDuration, findClip, createHistory, commitHistory, undoHistory } from '../src/core/timeline.ts'
import { inspectSpeechAlignment, previewSpeechAlignment } from '../src/core/speech-alignment-assist.ts'
import { addTransition } from '../src/core/transitions.ts'
import { applySpeechResults, planSpeech } from '../src/core/speech.ts'

function asset(id, duration, kind = 'audio', extra = {}) {
  return { id, name: id, kind, duration, width: kind === 'video' ? 1920 : 0, height: kind === 'video' ? 1080 : 0, size: 100, mime: kind === 'video' ? 'video/mp4' : 'audio/wav', url: `blob:${id}`, ...extra }
}
function addPair(project, id, start, textDuration, speechDuration, overrides = {}) {
  const text = createSubtitleClip(project, { id, text: `第 ${id} 段讲解`, start, trimOut: textDuration })
  project.tracks.find(track => track.kind === 'text').clips.push(text)
  const audio = asset(`${id}-source`, speechDuration)
  project.assets.push(audio)
  const clip = createClip(audio, project, { id: `${id}-speech`, start, speech: { textClipId: id, text: text.text, voiceId: 'voice', rate: 1 }, ...overrides })
  project.tracks.find(track => track.kind === 'audio').clips.push(clip)
  return { text, audio, clip }
}
function fixture() {
  const project = createProject('对齐检查')
  addPair(project, 'one', 0, 2, 4)
  addPair(project, 'two', 3, 2, 2)
  addPair(project, 'three', 10, 2, 2)
  const video = asset('video', 20, 'video')
  project.assets.push(video)
  project.tracks.find(track => track.kind === 'video').clips.push(createClip(video, project, { id: 'visual' }))
  return project
}

test('检查以现有配音裁剪和速度计算时长，报告起点、字幕过短和声音重叠', () => {
  const project = fixture()
  const first = findClip(project, 'one-speech').clip
  first.start = 1; first.trimIn = 1; first.trimOut = 4; first.speed = .5
  const report = inspectSpeechAlignment(project)
  assert.equal(report.timingSource, 'existing-audio-clips')
  assert.equal(report.entries[0].speechDuration, 6)
  assert.ok(report.issues.some(issue => issue.clipId === 'one' && issue.kind === 'start'))
  assert.ok(report.issues.some(issue => issue.clipId === 'one' && issue.kind === 'short'))
  assert.ok(report.issues.some(issue => issue.clipId === 'two' && issue.kind === 'overlap'))
})

test('字幕跟随真实配音，保持所有声音、视频位置和现有停顿', () => {
  const project = fixture(), original = structuredClone(project)
  findClip(project, 'one-speech').clip.start = .5
  const before = structuredClone(project)
  const result = previewSpeechAlignment(project, { mode: 'subtitle', gap: 0 })
  assert.equal(findClip(result.project, 'one').clip.start, .5)
  assert.equal(clipDuration(findClip(result.project, 'one').clip), 4)
  assert.deepEqual(result.project.tracks.find(track => track.kind === 'audio'), before.tracks.find(track => track.kind === 'audio'))
  assert.deepEqual(result.project.tracks.find(track => track.kind === 'video'), before.tracks.find(track => track.kind === 'video'))
  assert.equal(result.changedSubtitleCount, 1)
  assert.equal(result.movedSpeechCount, 0)
  assert.ok(result.remainingIssues.some(issue => issue.kind === 'overlap'))
  assert.deepEqual(project, before)
  assert.equal(original.tracks.find(track => track.kind === 'text').clips[0].trimOut, 2)
})

test('顺延保留原有一句停顿和后续节奏，一次提交可整体撤销且重复应用不继续推远', () => {
  const project = fixture(), original = structuredClone(project)
  const result = previewSpeechAlignment(project, { mode: 'ripple', gap: .2 })
  assert.equal(findClip(result.project, 'two-speech').clip.start, 5)
  assert.equal(findClip(result.project, 'three-speech').clip.start, 12)
  assert.equal(findClip(result.project, 'two').clip.start, 5)
  assert.equal(findClip(result.project, 'three').clip.start, 12)
  assert.equal(clipDuration(findClip(result.project, 'one').clip), 4)
  assert.equal(result.remainingIssues.length, 0)
  assert.deepEqual(findClip(result.project, 'visual'), findClip(project, 'visual'))
  assert.deepEqual(undoHistory(commitHistory(createHistory(project), result.project)).present, original)
  assert.deepEqual(project, original)
  const again = previewSpeechAlignment(result.project, { mode: 'ripple', gap: .2 })
  assert.equal(again.changes.length, 0)
  assert.equal(again.project, result.project)
})

test('已足够长的停顿不会再追加最小停顿，过短停顿只补足缺少部分', () => {
  const project = createProject('停顿')
  addPair(project, 'one', 0, 2, 2)
  addPair(project, 'two', 2.1, 2, 2)
  addPair(project, 'three', 8, 2, 2)
  const result = previewSpeechAlignment(project, { mode: 'ripple', gap: .5 })
  assert.equal(findClip(result.project, 'two-speech').clip.start, 2.5)
  assert.equal(findClip(result.project, 'three-speech').clip.start, 8.4)
  assert.equal(previewSpeechAlignment(result.project, { mode: 'ripple', gap: .5 }).changes.length, 0)
})

test('轨道范围保护其他字幕和水印，范围内未配音的后续字幕同步顺延', () => {
  const project = fixture()
  project.tracks.find(track => track.kind === 'text').clips.push(createSubtitleClip(project, { id: 'unspoken', start: 4, trimOut: 1, text: '尚未配音' }), { ...createSubtitleClip(project, { id: 'watermark', start: 4, trimOut: 2, text: '角标' }), textRole: 'watermark' })
  const other = createTrack('text', '其他讲解')
  other.clips.push(createSubtitleClip(project, { id: 'untouched', start: 4, trimOut: 2, text: '其他轨道' }))
  project.tracks.push(other)
  const result = previewSpeechAlignment(project, { mode: 'ripple', gap: .2, textTrackId: project.tracks.find(track => track.kind === 'text').id })
  assert.equal(findClip(result.project, 'unspoken').clip.start, 7.2)
  assert.equal(findClip(result.project, 'watermark').clip.start, 4)
  assert.equal(findClip(result.project, 'untouched').clip.start, 4)
})

test('需要改动的锁定轨道原子拒绝，只读声音位置可用于字幕跟随', () => {
  const project = fixture(), original = structuredClone(project)
  project.tracks.find(track => track.kind === 'audio').locked = true
  assert.doesNotThrow(() => previewSpeechAlignment(project, { mode: 'subtitle', gap: 0 }))
  assert.throws(() => previewSpeechAlignment(project, { mode: 'ripple', gap: .2 }), /锁定/)
  assert.equal(findClip(project, 'two').clip.start, 3)
  project.tracks.find(track => track.kind === 'text').locked = true
  assert.throws(() => previewSpeechAlignment(project, { mode: 'subtitle', gap: 0 }), /锁定/)
  assert.deepEqual(project.tracks.find(track => track.kind === 'text').clips, original.tracks.find(track => track.kind === 'text').clips)
})

test('文字过期明确要求重新生成；隐藏或静音的关联配音不参与修改', () => {
  const project = fixture()
  findClip(project, 'one').clip.text = '已经修改的讲解'
  assert.ok(inspectSpeechAlignment(project).issues.some(issue => issue.kind === 'text-changed'))
  assert.throws(() => previewSpeechAlignment(project, { mode: 'ripple', gap: .2 }), /重新生成/)
  project.tracks.find(track => track.kind === 'audio').muted = true
  const report = inspectSpeechAlignment(project)
  assert.equal(report.mutedCount, 3)
  assert.equal(report.issues.length, 0)
  assert.throws(() => previewSpeechAlignment(project, { mode: 'subtitle', gap: 0 }), /没有启用/)
})

function splitShotFixture() {
  let project = createProject('独立镜头')
  addPair(project, 'one', 0, 2, 4)
  addPair(project, 'two', 2, 2, 2)
  const video = asset('video', 4, 'video')
  project.assets.push(video)
  project.tracks.find(track => track.kind === 'video').clips.push(createClip(video, project, { id: 'shot-a', trimOut: 2 }), createClip(video, project, { id: 'shot-b', start: 2, trimIn: 2, trimOut: 4 }))
  project.markers = [{ id: 'chapter', time: 2, label: '下一段', kind: 'chapter' }]
  project = addTransition(project, 2, 'fade', 1)
  return project
}

test('延长独立镜头保持原声与视频同速、保留素材裁剪并重锚转场与标记', () => {
  const project = splitShotFixture(), original = structuredClone(project)
  const result = previewSpeechAlignment(project, { mode: 'extend_visual', gap: 0 })
  const first = findClip(result.project, 'shot-a').clip
  assert.equal(first.speed, .5)
  assert.equal(first.volume, findClip(project, 'shot-a').clip.volume)
  assert.equal(first.trimOut, 2)
  assert.equal(clipDuration(first), 4)
  assert.equal(findClip(result.project, 'shot-b').clip.start, 4)
  assert.equal(findClip(result.project, 'shot-b').clip.trimIn, 2)
  assert.equal(findClip(result.project, 'two-speech').clip.start, 4)
  assert.equal(result.project.tracks.find(track => track.kind === 'transition').clips[0].start, 3.5)
  assert.equal(result.project.markers[0].time, 4)
  assert.equal(result.retimedVisualCount, 1)
  assert.equal(result.movedMarkerCount, 1)
  assert.equal(result.afterDuration, 6)
  assert.deepEqual(project, original)
  assert.equal(previewSpeechAlignment(result.project, { mode: 'extend_visual', gap: 0 }).changes.length, 0)
})

test('整条长视频、复杂镜头、锁定转场和跨镜头内容不会被静默拉长', () => {
  assert.throws(() => previewSpeechAlignment(fixture(), { mode: 'extend_visual', gap: 0 }), /独立镜头/)
  const complex = splitShotFixture()
  findClip(complex, 'shot-a').clip.keyframes = { x: [{ time: 0, value: 0 }, { time: 2, value: 100 }] }
  assert.throws(() => previewSpeechAlignment(complex, { mode: 'extend_visual', gap: 0 }), /关键帧/)
  const locked = splitShotFixture()
  locked.tracks.find(track => track.kind === 'transition').locked = true
  assert.throws(() => previewSpeechAlignment(locked, { mode: 'extend_visual', gap: 0 }), /转场/)
  assert.equal(findClip(locked, 'shot-a').clip.speed, 1)
  const crossing = splitShotFixture()
  const audio = asset('original-audio', 5)
  crossing.assets.push(audio)
  crossing.tracks.find(track => track.kind === 'audio').clips.push(createClip(audio, crossing, { id: 'crossing', name: '同步原声' }))
  assert.throws(() => previewSpeechAlignment(crossing, { mode: 'extend_visual', gap: 0 }), /同步原声.*跨越/)
})

test('配音生成入口保留已存在的长停顿，不重复附加最小间隔', () => {
  const project = createProject('生成后对齐')
  project.tracks.find(track => track.kind === 'text').clips.push(createSubtitleClip(project, { id: 'one', text: '第一段', trimOut: 2 }), createSubtitleClip(project, { id: 'two', text: '第二段', start: 5, trimOut: 2 }))
  const source = planSpeech(project, ['one']).sources[0]
  const result = applySpeechResults(project, [{ source, asset: asset('speech', 4), voiceId: 'voice', rate: 1 }], { alignment: { mode: 'ripple', gap: .5 } })
  assert.equal(findClip(result.project, 'two').clip.start, 7)
})

test('无改动方案不创建历史项，非法间隔和已删除的范围被拒绝', () => {
  const project = createProject('已对齐')
  addPair(project, 'one', 0, 2, 2)
  assert.equal(previewSpeechAlignment(project, { mode: 'subtitle', gap: 0 }).project, project)
  assert.throws(() => previewSpeechAlignment(project, { mode: 'ripple', gap: NaN }), /间隔/)
  assert.throws(() => previewSpeechAlignment(project, { mode: 'ripple', gap: 0, textTrackId: 'gone' }), /不存在/)
})
