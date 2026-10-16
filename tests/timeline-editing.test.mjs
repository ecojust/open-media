import test from 'node:test'
import assert from 'node:assert/strict'
import { createClip, createProject, createTextClip, createTrack } from '../src/core/project.ts'
import { addAsset, addClip, addTrack, clipDuration, clipEnd, commitHistory, createHistory, findClip, projectDuration, redoHistory, setTrack, sourceTimeAt, undoHistory } from '../src/core/timeline.ts'
import { applySpeechResults, planSpeech } from '../src/core/speech.ts'
import { closeTimelineGaps, deleteClipAndCloseGap, findNearestSnap, trimClipAtPlayhead } from '../src/core/timeline-editing.ts'

function fixture() {
  let project = createProject('时间线操作', { fps: 25 })
  const video = { id: 'video', name: '视频.mp4', kind: 'video', url: 'blob:video', duration: 30, width: 1920, height: 1080, size: 1024, mime: 'video/mp4' }
  const audio = { id: 'audio', name: '声音.wav', kind: 'audio', url: 'blob:audio', duration: 30, width: 0, height: 0, size: 512, mime: 'audio/wav' }
  project = addAsset(addAsset(project, video), audio)
  return { project, video, audio, videoTrack: project.tracks[1].id, audioTrack: project.tracks[2].id, textTrack: project.tracks[0].id }
}

function addMedia(project, trackId, asset, id, start, duration, overrides = {}) {
  return addClip(project, trackId, createClip(asset, project, { id, start, trimOut: duration, ...overrides }))
}

test('播放头裁剪按变速后的源时间换算，裁左移动起点而裁右保持起点', () => {
  let { project, video, videoTrack } = fixture()
  project = addMedia(project, videoTrack, video, 'clip', 4, 26, { trimIn: 6, speed: 2, fadeIn: 4, fadeOut: 5 })
  const before = structuredClone(project)
  const original = findClip(project, 'clip').clip
  const leftTrimmed = findClip(trimClipAtPlayhead(project, 'clip', 10, 'start'), 'clip').clip
  assert.equal(leftTrimmed.start, 10)
  assert.equal(leftTrimmed.trimIn, 18)
  assert.equal(leftTrimmed.trimOut, 26)
  assert.equal(clipEnd(leftTrimmed), clipEnd(original))
  assert.equal(sourceTimeAt(leftTrimmed, 11), sourceTimeAt(original, 11))
  assert.equal(leftTrimmed.fadeIn, 4)
  assert.equal(leftTrimmed.fadeOut, 4)
  const rightTrimmed = findClip(trimClipAtPlayhead(project, 'clip', 7, 'end'), 'clip').clip
  assert.equal(rightTrimmed.start, 4)
  assert.equal(rightTrimmed.trimIn, 6)
  assert.equal(rightTrimmed.trimOut, 12)
  assert.equal(clipEnd(rightTrimmed), 7)
  assert.equal(rightTrimmed.fadeIn, 3)
  assert.equal(rightTrimmed.fadeOut, 3)
  assert.deepEqual(project, before)
})

test('首尾边界、非有限播放头和不足一帧全部拒绝，恰好剩一帧允许', () => {
  let { project, video, videoTrack } = fixture()
  project = addMedia(project, videoTrack, video, 'clip', 1, 2, { speed: 2 })
  const before = structuredClone(project)
  for (const side of ['start', 'end']) for (const time of [0, 1, 2, 3, NaN, Infinity]) assert.throws(() => trimClipAtPlayhead(project, 'clip', time, side), /内部/)
  assert.throws(() => trimClipAtPlayhead(project, 'clip', 1.98, 'start'), /一帧/)
  assert.throws(() => trimClipAtPlayhead(project, 'clip', 1.02, 'end'), /一帧/)
  assert.ok(Math.abs(clipDuration(findClip(trimClipAtPlayhead(project, 'clip', 1.96, 'start'), 'clip').clip) - 1 / 25) < 1e-9)
  assert.ok(Math.abs(clipDuration(findClip(trimClipAtPlayhead(project, 'clip', 1.04, 'end'), 'clip').clip) - 1 / 25) < 1e-9)
  assert.throws(() => trimClipAtPlayhead(project, 'clip', 1.5, 'invalid'), /方向/)
  assert.deepEqual(project, before)
})

test('锁轨裁剪拒绝且不变更项目，裁剪字幕或配音解除引用并保留原声音信息', () => {
  let { project, audio, textTrack } = fixture()
  project = addClip(project, textTrack, createTextClip(project, { id: 'text', text: '完整文字', start: 2, trimOut: 4 }))
  const speech = applySpeechResults(project, [{ source: planSpeech(project).sources[0], asset: { ...audio, id: 'speech', duration: 4 }, voiceId: 'voice-1', rate: 1 }])
  const audioId = speech.audioClipIds[0]
  const croppedText = trimClipAtPlayhead(speech.project, 'text', 3, 'start')
  assert.equal(findClip(croppedText, audioId).clip.speech.textClipId, undefined)
  assert.equal(findClip(croppedText, audioId).clip.speech.text, '完整文字')
  assert.equal(findClip(croppedText, audioId).clip.start, 2)
  const croppedAudio = trimClipAtPlayhead(speech.project, audioId, 4, 'end')
  assert.equal(findClip(croppedAudio, audioId).clip.speech.textClipId, undefined)
  assert.equal(findClip(croppedAudio, audioId).clip.speech.voiceId, 'voice-1')
  assert.deepEqual(findClip(croppedAudio, 'text').clip, findClip(speech.project, 'text').clip)
  const lockedAudio = setTrack(speech.project, findClip(speech.project, audioId).track.id, { locked: true })
  const before = structuredClone(lockedAudio)
  assert.throws(() => trimClipAtPlayhead(lockedAudio, audioId, 3, 'start'), /解锁/)
  assert.throws(() => trimClipAtPlayhead(lockedAudio, 'text', 3, 'start'), /配音轨道已锁定/)
  assert.deepEqual(lockedAudio, before)
})

test('接拢全轨公共空隙及开头，重叠的音画字幕按相同偏移移动', () => {
  let { project, video, audio, videoTrack, audioTrack, textTrack } = fixture()
  project = addMedia(project, videoTrack, video, 'video-first', 2, 2)
  project = addMedia(project, audioTrack, audio, 'audio-first', 2, 3)
  project = addMedia(project, videoTrack, video, 'video-next', 8, 4, { speed: 2 })
  project = addMedia(project, audioTrack, audio, 'audio-next', 8, 2)
  project = addClip(project, textTrack, createTextClip(project, { id: 'text-next', text: '同步字幕', start: 8, trimOut: 2 }))
  const before = structuredClone(project)
  const closed = closeTimelineGaps(project)
  assert.equal(findClip(closed, 'video-first').clip.start, 0)
  assert.equal(findClip(closed, 'audio-first').clip.start, 0)
  for (const id of ['video-next', 'audio-next', 'text-next']) assert.equal(findClip(closed, id).clip.start, 3)
  assert.equal(findClip(closed, 'video-next').clip.speed, 2)
  assert.equal(findClip(closed, 'video-next').clip.trimOut, 4)
  assert.equal(projectDuration(closed), 5)
  assert.deepEqual(project, before)
  assert.equal(closeTimelineGaps(closed), closed)
})

test('接拢保留字幕配音关系，静音轨道仍阻止删除其占用时间', () => {
  let { project, audio, audioTrack, textTrack } = fixture()
  project = addMedia(project, audioTrack, audio, 'muted', 0, 3)
  project = setTrack(project, audioTrack, { muted: true, locked: true })
  project = addClip(project, textTrack, createTextClip(project, { id: 'text', text: '一起移动', start: 6, trimOut: 4 }))
  const speech = applySpeechResults(project, [{ source: planSpeech(project).sources[0], asset: { ...audio, id: 'speech', duration: 4 }, voiceId: 'voice', rate: 1 }])
  const closed = closeTimelineGaps(speech.project)
  assert.equal(findClip(closed, 'text').clip.start, 3)
  const voice = findClip(closed, speech.audioClipIds[0]).clip
  assert.equal(voice.start, 3)
  assert.equal(voice.speech.textClipId, 'text')
  assert.deepEqual(findClip(closed, 'muted').clip, findClip(speech.project, 'muted').clip)
})

test('公共空白按区间并集处理嵌套、邻接和浮点误差，不产生微小移位', () => {
  let { project, video, audio, videoTrack, audioTrack } = fixture()
  project = addMedia(project, videoTrack, video, 'long', 0, 5)
  project = addMedia(project, audioTrack, audio, 'inside', 1, 1)
  project = addMedia(project, audioTrack, audio, 'adjacent', 5 + 1e-10, 1)
  project = addMedia(project, videoTrack, video, 'later', 8, 1)
  const closed = closeTimelineGaps(project)
  assert.equal(findClip(closed, 'inside').clip.start, 1)
  assert.equal(findClip(closed, 'adjacent').clip.start, 5 + 1e-10)
  assert.ok(Math.abs(findClip(closed, 'later').clip.start - (6 + 1e-10)) < 1e-9)
  assert.equal(closeTimelineGaps(closed), closed)
})

test('受影响锁轨阻止整个接拢，无需移动的锁轨不阻止', () => {
  let { project, video, audio, videoTrack, audioTrack } = fixture()
  project = addMedia(project, videoTrack, video, 'first', 0, 2)
  project = addMedia(project, audioTrack, audio, 'later', 5, 2)
  const lockedLater = setTrack(project, audioTrack, { locked: true })
  const before = structuredClone(lockedLater)
  assert.throws(() => closeTimelineGaps(lockedLater), /需要移动.*解锁/)
  assert.deepEqual(lockedLater, before)
  const lockedFirst = setTrack(project, videoTrack, { locked: true })
  assert.equal(findClip(closeTimelineGaps(lockedFirst), 'later').clip.start, 2)
})

test('删除接拢仅删除原片段区间内公共空白，保留既有其它间隙', () => {
  let { project, video, audio, videoTrack, audioTrack, textTrack } = fixture()
  project = addClip(project, textTrack, createTextClip(project, { id: 'deleted', text: '删除', start: 0, trimOut: 2 }))
  project = addMedia(project, audioTrack, audio, 'survivor', 1, 2)
  project = addMedia(project, videoTrack, video, 'later', 4, 2)
  const before = structuredClone(project)
  const deleted = deleteClipAndCloseGap(project, 'deleted')
  assert.equal(findClip(deleted, 'deleted'), undefined)
  assert.equal(findClip(deleted, 'survivor').clip.start, 0)
  assert.equal(findClip(deleted, 'later').clip.start, 3)
  assert.equal(projectDuration(deleted), 5)
  assert.equal(findClip(deleted, 'later').clip.start - clipEnd(findClip(deleted, 'survivor').clip), 1)
  assert.deepEqual(deleted.assets, project.assets)
  assert.deepEqual(project, before)
})

test('删除接拢保留前后的既有空白，只压缩删除范围中的多段公共间隙', () => {
  let { project, video, audio, videoTrack, audioTrack } = fixture()
  project = addMedia(project, videoTrack, video, 'deleted', 4, 12, { speed: 2 })
  project = addMedia(project, audioTrack, audio, 'inside-first', 5, 1)
  project = addMedia(project, audioTrack, audio, 'inside-next', 7, 1)
  project = addMedia(project, videoTrack, video, 'later', 12, 2)
  const deleted = deleteClipAndCloseGap(project, 'deleted')
  assert.equal(findClip(deleted, 'inside-first').clip.start, 4)
  assert.equal(findClip(deleted, 'inside-next').clip.start, 5)
  assert.equal(findClip(deleted, 'later').clip.start, 8)
  assert.equal(projectDuration(deleted), 10)
})

test('其它轨占满删除区间时只删除，删除末尾、唯一片段和不存在片段行为明确', () => {
  let { project, video, audio, videoTrack, audioTrack } = fixture()
  project = addMedia(project, videoTrack, video, 'deleted', 2, 2)
  project = addMedia(project, audioTrack, audio, 'cover', 0, 8)
  const deleted = deleteClipAndCloseGap(project, 'deleted')
  assert.deepEqual(findClip(deleted, 'cover').clip, findClip(project, 'cover').clip)
  assert.equal(projectDuration(deleted), 8)
  const empty = deleteClipAndCloseGap(deleted, 'cover')
  assert.equal(projectDuration(empty), 0)
  assert.equal(empty.assets.length, 2)
  assert.equal(closeTimelineGaps(empty), empty)
  assert.throws(() => deleteClipAndCloseGap(empty, 'missing'), /不存在/)
})

test('删除接拢的锁轨失败不保留半删除状态，配音仍在时不误删占用时间', () => {
  let { project, video, audio, videoTrack, audioTrack, textTrack } = fixture()
  project = addMedia(project, videoTrack, video, 'deleted', 2, 2)
  project = addMedia(project, audioTrack, audio, 'locked-later', 7, 2)
  const locked = setTrack(project, audioTrack, { locked: true })
  const before = structuredClone(locked)
  assert.throws(() => deleteClipAndCloseGap(locked, 'deleted'), /解锁/)
  assert.deepEqual(locked, before)
  project = addClip(project, textTrack, createTextClip(project, { id: 'text', text: '配音继续保留', start: 12, trimOut: 4 }))
  const speech = applySpeechResults(project, [{ source: planSpeech(project).sources[0], asset: { ...audio, id: 'speech', duration: 4 }, voiceId: 'voice', rate: 1 }])
  const withoutText = deleteClipAndCloseGap(speech.project, 'text')
  const voice = findClip(withoutText, speech.audioClipIds[0]).clip
  assert.equal(voice.start, 12)
  assert.equal(voice.speech.textClipId, undefined)
  assert.equal(voice.speech.text, '配音继续保留')
  assert.equal(projectDuration(withoutText), projectDuration(speech.project))
})

test('裁剪、全局接拢和删除接拢均可用单次历史记录完整撤销重做', () => {
  let { project, video, videoTrack } = fixture()
  project = addMedia(project, videoTrack, video, 'first', 2, 3)
  project = addMedia(project, videoTrack, video, 'later', 8, 3)
  for (const action of [() => trimClipAtPlayhead(project, 'first', 3, 'start'), () => closeTimelineGaps(project), () => deleteClipAndCloseGap(project, 'first')]) {
    const changed = action()
    const committed = commitHistory(createHistory(project), changed)
    assert.equal(committed.past.length, 1)
    assert.deepEqual(undoHistory(committed).present, project)
    assert.deepEqual(redoHistory(undoHistory(committed)).present, changed)
  }
})

test('吸附只选阈值内最近点，等距保持候选优先顺序并忽略无效候选', () => {
  assert.equal(findNearestSnap(4.4, [3, 4, 5], 1), 4)
  assert.equal(findNearestSnap(4.5, [5, 4], 0.5), 5)
  assert.equal(findNearestSnap(4.5, [4, 5], 0.5), 4)
  assert.equal(findNearestSnap(0.2, [0.3, 0.1], 0.1), 0.3)
  assert.equal(findNearestSnap(4.4, [NaN, Infinity, 4.5], 0.2), 4.5)
  assert.equal(findNearestSnap(4.4, [4, 5], 0.1), 4.4)
  assert.equal(findNearestSnap(4.4, [], 10), 4.4)
  assert.equal(findNearestSnap(4.4, [4], -1), 4.4)
  assert.equal(findNearestSnap(4.4, [4], NaN), 4.4)
  assert.equal(findNearestSnap(Infinity, [4], 1), Infinity)
})
