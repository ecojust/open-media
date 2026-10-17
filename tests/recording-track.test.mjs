import test from 'node:test'
import assert from 'node:assert/strict'
import { createClip, createProject, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS, validateProject } from '../src/core/project.ts'
import { addRecordedAudio } from '../src/core/recording-track.ts'
import { commitHistory, createHistory, findClip, redoHistory, undoHistory } from '../src/core/timeline.ts'

function recording(id = 'recording', duration = 4) {
  return { id, name: '录音.wav', kind: 'audio', url: `blob:${id}`, nativePath: `/recordings/${id}.wav`, duration, width: 0, height: 0, size: 128000, mime: 'audio/wav' }
}

function withRecordingTrack(options = {}) {
  const project = createProject('录音项目')
  const asset = recording('existing-recording', 20)
  const track = { ...createTrack('audio', '配音轨道'), ...options }
  track.clips = [createClip(asset, project, { start: 10, trimIn: 4, trimOut: 14, speed: 2 })]
  project.assets.push(asset)
  project.tracks.push(track)
  return { project, track }
}

function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child)
  return Object.freeze(value)
}

test('录音一次添加素材、配音轨道和播放头位置的片段，撤销和重做包含全部更改', () => {
  const original = createProject('空项目')
  const asset = recording()
  const result = addRecordedAudio(original, asset, 3.25)
  const added = findClip(result.project, result.clipId)
  assert.equal(added.track.id, result.trackId)
  assert.equal(added.track.kind, 'audio')
  assert.equal(added.track.name, '配音轨道')
  assert.equal(added.track.muted, false)
  assert.equal(added.track.locked, false)
  assert.equal(added.clip.assetId, asset.id)
  assert.equal(added.clip.start, 3.25)
  assert.equal(added.clip.trimIn, 0)
  assert.equal(added.clip.trimOut, 4)
  assert.equal(added.clip.volume, 1)
  assert.equal(added.clip.speed, 1)
  assert.deepEqual(result.project.assets, [asset])
  const history = commitHistory(createHistory(original), result.project)
  assert.equal(history.past.length, 1)
  assert.deepEqual(undoHistory(history).present, original)
  assert.deepEqual(redoHistory(undoHistory(history)).present, result.project)
})

test('同名配音轨道按裁剪和速度计算空位，允许紧接前后片段', () => {
  const { project, track } = withRecordingTrack()
  for (const [start, duration] of [[0, 4], [6, 4], [15, 4]]) {
    const result = addRecordedAudio(project, recording('new-recording', duration), start)
    assert.equal(result.trackId, track.id)
    assert.equal(result.project.tracks.length, project.tracks.length)
    assert.equal(result.project.tracks.at(-1).clips.length, 2)
    assert.deepEqual(result.project.tracks.at(-1).clips[0], track.clips[0])
  }
})

test('与现有片段重叠时新建同名配音轨道，不覆盖原录音', () => {
  for (const [start, duration] of [[9, 2], [10, 4], [12, 1], [14, 2], [9, 7]]) {
    const { project, track } = withRecordingTrack()
    const result = addRecordedAudio(project, recording('new-recording', duration), start)
    assert.notEqual(result.trackId, track.id)
    assert.equal(result.project.tracks.length, project.tracks.length + 1)
    assert.deepEqual(result.project.tracks.find((item) => item.id === track.id), track)
    assert.equal(result.project.tracks.at(-1).name, '配音轨道')
  }
})

test('锁定、静音、名称不符或类型不符的轨道不能承接录音', () => {
  for (const options of [{ locked: true }, { muted: true }, { name: '背景音乐' }, { kind: 'video' }]) {
    const { project, track } = withRecordingTrack(options)
    if (track.kind === 'video') track.clips = []
    const result = addRecordedAudio(project, recording('new-recording'), 0)
    assert.notEqual(result.trackId, track.id)
    assert.deepEqual(result.project.tracks.find((item) => item.id === track.id), track)
    assert.equal(result.project.tracks.at(-1).kind, 'audio')
    assert.equal(result.project.tracks.at(-1).muted, false)
  }
})

test('前面的同名轨道不可用时复用后面的空闲配音轨道', () => {
  const { project } = withRecordingTrack({ locked: true })
  const available = createTrack('audio', '配音轨道')
  project.tracks.push(available)
  const result = addRecordedAudio(project, recording('new-recording'), 10)
  assert.equal(result.trackId, available.id)
  assert.equal(result.project.tracks.length, project.tracks.length)
})

test('成功和失败均不更改输入，输出对象与输入项目及素材互相隔离', () => {
  const { project } = withRecordingTrack()
  const original = structuredClone(project)
  const asset = recording('new-recording')
  deepFreeze(project)
  deepFreeze(asset)
  const result = addRecordedAudio(project, asset, 0)
  result.project.assets.at(-1).name = '外部修改'
  result.project.tracks.at(-1).clips[0].start = 99
  assert.deepEqual(project, original)
  assert.equal(asset.name, '录音.wav')
  assert.throws(() => addRecordedAudio(project, asset, -1), /起点/)
  assert.deepEqual(project, original)
})

test('拒绝无效录音和起点，完整校验素材标识、地址与元数据', () => {
  const project = createProject()
  for (const patch of [{ kind: 'video' }, { kind: 'image' }, { duration: 0 }, { duration: 0.0001 }, { duration: NaN }, { duration: Infinity }, { size: 0 }, { url: '' }]) {
    assert.throws(() => addRecordedAudio(project, { ...recording(), ...patch }, 0), /录音结果/)
  }
  for (const start of [-1, NaN, Infinity, -Infinity, MAX_PROJECT_DURATION]) {
    assert.throws(() => addRecordedAudio(project, recording(), start), /起点|24 小时/)
  }
  assert.throws(() => addRecordedAudio(project, { ...recording(), url: 'javascript:invalid' }, 0), /协议/)
  assert.throws(() => addRecordedAudio(project, { ...recording(), size: NaN }, 0), /素材大小/)
  const { project: existing } = withRecordingTrack()
  assert.throws(() => addRecordedAudio(existing, recording('existing-recording'), 0), /重复/)
})

test('接受恰好 24 小时的结束边界，拒绝任何超出', () => {
  const project = createProject()
  const result = addRecordedAudio(project, recording(), MAX_PROJECT_DURATION - 4)
  assert.equal(findClip(result.project, result.clipId).clip.start, MAX_PROJECT_DURATION - 4)
  assert.throws(() => addRecordedAudio(project, recording(), MAX_PROJECT_DURATION - 4 + 0.001), /24 小时/)
  assert.throws(() => addRecordedAudio(project, recording('long', MAX_PROJECT_DURATION + 1), 0), /24 小时/)
})

test('素材、片段、轨道容量不足时整体失败，轨道满但可复用时仍然成功', () => {
  const fullAssets = createProject()
  fullAssets.assets = Array.from({ length: MAX_ASSETS }, (_, index) => recording(`existing-${index}`))
  const assetSnapshot = structuredClone(fullAssets)
  assert.throws(() => addRecordedAudio(fullAssets, recording(), 0), /1000 个素材/)
  assert.deepEqual(fullAssets, assetSnapshot)

  const { project: fullClips } = withRecordingTrack()
  const template = fullClips.tracks.at(-1).clips[0]
  fullClips.tracks.at(-1).clips = Array.from({ length: MAX_CLIPS }, (_, index) => ({ ...template, id: `clip-${index}` }))
  const clipSnapshot = structuredClone(fullClips)
  assert.throws(() => addRecordedAudio(fullClips, recording(), 0), /10000 个片段/)
  assert.deepEqual(fullClips, clipSnapshot)

  const fullTracks = createProject()
  fullTracks.tracks = Array.from({ length: MAX_TRACKS }, () => createTrack('audio'))
  const trackSnapshot = structuredClone(fullTracks)
  assert.throws(() => addRecordedAudio(fullTracks, recording(), 0), /100 条轨道/)
  assert.deepEqual(fullTracks, trackSnapshot)
  fullTracks.tracks.at(-1).name = '配音轨道'
  const result = addRecordedAudio(fullTracks, recording(), 0)
  assert.equal(result.trackId, fullTracks.tracks.at(-1).id)
  assert.equal(result.project.tracks.length, MAX_TRACKS)
  assert.doesNotThrow(() => validateProject(result.project, { trusted: true }))
})
