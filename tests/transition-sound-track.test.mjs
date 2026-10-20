import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IDBFactory } from 'fake-indexeddb'
import { createClip, createProject, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS, validateProject } from '../src/core/project.ts'
import { addTransitionSound, findTransitionSoundCut, TRANSITION_SOUND_TRACK } from '../src/core/transition-sound-track.ts'
import { addTransition, findTransitionCut } from '../src/core/transitions.ts'
import { addEditorAssetToTimeline, projectSourceAssets } from '../src/core/editor-assets.ts'
import { clipDuration, clipEnd, commitHistory, createHistory, findClip, projectDuration, redoHistory, undoHistory } from '../src/core/timeline.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'
import { loadProject, saveProject } from '../src/core/storage.ts'

function sound(id = 'sound', patch = {}) {
  return { id, name: '风掠.wav', kind: 'audio', url: `blob:${id}`, duration: 0.8, width: 0, height: 0, size: 38444, mime: 'audio/wav', libraryRole: 'transition-sound', ...patch }
}

function fixture(points = [0, 4, 8, 12]) {
  const project = createProject('转场音效验证', { width: 320, height: 180, fps: 24 })
  const video = { id: 'video', name: '视频.mp4', kind: 'video', url: 'blob:video', duration: points.at(-1), width: 320, height: 180, size: 200, mime: 'video/mp4' }
  project.assets.push(video)
  const track = project.tracks.find(item => item.kind === 'video')
  track.clips = points.slice(0, -1).map((start, index) => createClip(video, project, { id: `video-${index}`, start, trimIn: start, trimOut: points[index + 1] }))
  return { project, video, track, cut: findTransitionSoundCut(project, points[1]) }
}

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} 应接近 ${expected}`)
function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child)
  return Object.freeze(value)
}

test('优先选中画面转场切点，其余选择按播放头找所有视频轨道的最近切点', () => {
  const base = fixture()
  const project = addTransition(base.project, 4, 'fade')
  const selected = project.tracks.flatMap(track => track.clips).find(clip => clip.transition)
  assert.equal(findTransitionSoundCut(project, 7.9, selected.id).time, 4)
  assert.equal(findTransitionSoundCut(project, 7.9).time, 8)
  assert.equal(findTransitionSoundCut(project, 7.9, 'missing').time, 8)
  assert.equal(findTransitionSoundCut(project, 7.9, 'video-0').time, 8)
  assert.equal(findTransitionSoundCut(project, 6).time, 4, '等距时稳定选择较早切点')
  const other = createTrack('video')
  other.clips = [createClip(base.video, project, { trimOut: 7.75 }), createClip(base.video, project, { start: 7.75, trimOut: 1 })]
  project.tracks.push(other)
  assert.equal(findTransitionSoundCut(project, 7.8, 'video-0').trackId, other.id)
  assert.equal(findTransitionSoundCut(project, NaN), undefined)
  assert.equal(findTransitionSoundCut(createProject(), 4), undefined)
})

test('视频和画面转场轨道锁定时仍可配音，不改变锁定轨道或转场', () => {
  const base = fixture()
  const project = addTransition(base.project, 4, 'fade')
  for (const track of project.tracks) if (track.kind === 'video' || track.kind === 'transition') track.locked = true
  const selected = project.tracks.flatMap(track => track.clips).find(clip => clip.transition)
  assert.equal(findTransitionCut(project, 4), undefined, '画面转场原有锁定规则保持有效')
  const cut = findTransitionSoundCut(project, 8, selected.id)
  assert.equal(cut.time, 4)
  const result = addTransitionSound(project, sound(), cut, 0.35)
  assert.deepEqual(result.project.tracks.slice(0, -1), project.tracks)
  assert.equal(findClip(result.project, result.clipId).track.locked, false)
})

test('单帧视频切点也可添加音效，不继承画面转场的两帧最短时长', () => {
  const { project, cut } = fixture([0, 1 / 24, 2])
  assert.equal(findTransitionCut(project, 1 / 24), undefined)
  assert.ok(cut)
  near(cut.time, 1 / 24)
  const result = addTransitionSound(project, sound(), cut, 0.35)
  const { clip } = findClip(result.project, result.clipId)
  near(clip.start + 0.35 - clip.trimIn, 1 / 24)
  assert.equal(clip.start, 0)
  assert.equal(projectDuration(result.project), 2)
})

test('真实音频片段以重音对齐切点，原轨道和项目时长保持不变，单步撤销重做完整恢复', () => {
  const { project, cut } = fixture()
  const asset = sound(), snapshot = structuredClone(project)
  const result = addTransitionSound(project, asset, cut, 0.35)
  const { clip, track } = findClip(result.project, result.clipId)
  assert.equal(track.name, TRANSITION_SOUND_TRACK)
  assert.equal(track.kind, 'audio')
  assert.equal(track.id, result.trackId)
  assert.equal(clip.assetId, asset.id)
  assert.equal(clip.start, result.start)
  near(clip.start + (0.35 - clip.trimIn) / clip.speed, cut.time)
  assert.equal(clip.trimIn, 0)
  assert.equal(clip.trimOut, asset.duration)
  assert.equal(clip.speed, 1)
  assert.ok(clip.volume > 0 && clip.volume <= 1)
  assert.ok(clip.fadeIn + clip.fadeOut <= clipDuration(clip))
  assert.deepEqual(result.project.tracks.slice(0, -1), snapshot.tracks)
  assert.equal(projectDuration(result.project), projectDuration(project))
  const history = commitHistory(createHistory(project), result.project)
  assert.equal(history.past.length, 1)
  assert.deepEqual(undoHistory(history).present, snapshot)
  assert.deepEqual(redoHistory(undoHistory(history)).present, result.project)
  assert.deepEqual(project, snapshot)
})

test('靠近项目首尾时只裁去时间线以外的音频，重音位置和项目总时长保持不变', () => {
  for (const [points, anchor, expectedStart, expectedTrimIn, expectedTrimOut] of [
    [[0, 0.125, 4], 0.6, 0, 0.475, 0.8],
    [[0, 3.875, 4], 0.03, 3.845, 0, 0.155],
    [[0, 0.125, 0.25], 0.6, 0, 0.475, 0.725],
  ]) {
    const { project, cut } = fixture(points)
    const result = addTransitionSound(project, sound(), cut, anchor)
    const { clip } = findClip(result.project, result.clipId)
    near(clip.start, expectedStart)
    near(clip.trimIn, expectedTrimIn)
    near(clip.trimOut, expectedTrimOut)
    near(clip.start + anchor - clip.trimIn, cut.time)
    assert.ok(clip.start >= 0)
    assert.ok(clipEnd(clip) <= projectDuration(project) + 1e-9)
    near(projectDuration(result.project), projectDuration(project))
  }
})

test('同一音效复用原始素材，空闲专用轨道按裁剪和播放速度计算占用', () => {
  const { project, cut } = fixture()
  const first = addTransitionSound(project, sound(), cut, 0.35)
  const second = addTransitionSound(first.project, sound('sound', { duration: 0.2, url: 'blob:replacement' }), findTransitionSoundCut(first.project, 8), 0.35)
  assert.equal(second.trackId, first.trackId)
  assert.notEqual(second.clipId, first.clipId)
  assert.equal(second.project.assets.length, 2)
  assert.equal(second.project.assets.find(asset => asset.id === 'sound').url, 'blob:sound')
  assert.equal(findClip(second.project, second.clipId).clip.trimOut, 0.8)
  assert.deepEqual(findClip(second.project, first.clipId).clip, findClip(first.project, first.clipId).clip)
  const occupied = fixture()
  const existingSound = sound('existing', { duration: 4 })
  occupied.project.assets.push(existingSound)
  const track = createTrack('audio', TRANSITION_SOUND_TRACK)
  track.clips = [createClip(existingSound, occupied.project, { start: 1, trimIn: 1, trimOut: 3, speed: 2 })]
  occupied.project.tracks.push(track)
  const adjacent = addTransitionSound(occupied.project, sound('new', { duration: 3 }), occupied.cut, 2)
  assert.equal(adjacent.trackId, track.id, '已有音效在 2 秒结束时可复用边界相接轨道')
  assert.deepEqual(adjacent.project.tracks.map(item => item.id), occupied.project.tracks.map(item => item.id))
  assert.deepEqual(findClip(adjacent.project, track.clips[0].id).clip, track.clips[0])
})

test('音效重叠时新建轨道，不覆盖旧片段；锁定、静音及其他名称的轨道不复用', () => {
  const base = fixture()
  const first = addTransitionSound(base.project, sound(), base.cut, 0.35)
  const overlapping = addTransitionSound(first.project, sound('new'), base.cut, 0.35)
  assert.notEqual(overlapping.trackId, first.trackId)
  assert.deepEqual(overlapping.project.tracks.slice(0, -1), first.project.tracks)
  for (const patch of [{ locked: true }, { muted: true }, { name: '普通音频轨道' }]) {
    const { project, cut } = fixture()
    const unavailable = { ...createTrack('audio', TRANSITION_SOUND_TRACK), ...patch }
    project.tracks.push(unavailable)
    const result = addTransitionSound(project, sound(), cut, 0.35)
    assert.notEqual(result.trackId, unavailable.id)
    assert.deepEqual(result.project.tracks.slice(0, -1), project.tracks)
  }
  const { project, cut } = fixture()
  project.tracks.push({ ...createTrack('audio', TRANSITION_SOUND_TRACK), locked: true })
  const available = createTrack('audio', TRANSITION_SOUND_TRACK)
  project.tracks.push(available)
  assert.equal(addTransitionSound(project, sound(), cut, 0.35).trackId, available.id)
})

test('失效切点、缺失素材、非视频切点和非法音频元数据均拒绝添加且不改原项目', () => {
  const { project, cut } = fixture()
  for (const mutate of [
    copy => { copy.tracks.find(track => track.kind === 'video').clips[1].start = 5 },
    copy => { copy.tracks.find(track => track.kind === 'video').clips.shift() },
    copy => { copy.assets = [] },
    copy => { copy.assets[0].kind = 'image' },
  ]) {
    const changed = structuredClone(project)
    mutate(changed)
    const before = structuredClone(changed)
    assert.throws(() => addTransitionSound(changed, sound(), cut, 0.35), /切点已变化/)
    assert.deepEqual(changed, before)
  }
  for (const badCut of [{ ...cut, time: NaN }, { ...cut, time: cut.time + 0.1 }, { ...cut, fromClipId: 'missing' }, { ...cut, toClipId: 'missing' }]) {
    assert.throws(() => addTransitionSound(project, sound(), badCut, 0.35), /切点已变化/)
  }
  for (const patch of [{ kind: 'video' }, { kind: 'image' }, { size: 0 }, { size: -1 }, { size: NaN }, { size: Infinity }, { url: '' }]) {
    assert.throws(() => addTransitionSound(project, sound('bad', patch), cut, 0.35), /音频素材/)
  }
  for (const duration of [0, -1, 0.0001, NaN, Infinity]) assert.throws(() => addTransitionSound(project, sound('bad', { duration }), cut, 0), /时长/)
  for (const anchor of [-1, 0.8, 1, NaN, Infinity]) assert.throws(() => addTransitionSound(project, sound(), cut, anchor), /重音位置/)
  for (const [patch, message] of [[{ url: 'javascript:invalid' }, /协议/], [{ id: 'invalid id' }, /标识/], [{ width: -1 }, /宽度/], [{ duration: MAX_PROJECT_DURATION + 1 }, /时长/]]) {
    assert.throws(() => addTransitionSound(project, sound('bad', patch), cut, 0.35), message)
  }
})

test('成功与失败都不修改输入，结果与原音效素材、视频轨道互相隔离', () => {
  const { project, cut } = fixture(), source = sound(), before = structuredClone(project)
  deepFreeze(project); deepFreeze(source)
  const result = addTransitionSound(project, source, cut, 0.35)
  result.project.assets.at(-1).name = '修改结果'
  result.project.tracks.find(track => track.kind === 'video').clips[0].name = '修改视频'
  assert.deepEqual(project, before)
  assert.equal(source.name, '风掠.wav')
  assert.throws(() => addTransitionSound(project, source, cut, -1), /重音位置/)
  assert.deepEqual(project, before)
})

test('素材、片段或轨道容量满时整体失败，已有素材与空闲专用轨道仍能复用', () => {
  const assetFull = fixture()
  assetFull.project.assets.push(...Array.from({ length: MAX_ASSETS - 1 }, (_, index) => sound(`existing-${index}`)))
  const assetBefore = structuredClone(assetFull.project)
  assert.throws(() => addTransitionSound(assetFull.project, sound(), assetFull.cut, 0.35), /1000 个素材/)
  assert.deepEqual(assetFull.project, assetBefore)
  assert.equal(addTransitionSound(assetFull.project, assetFull.project.assets[1], assetFull.cut, 0.35).project.assets.length, MAX_ASSETS)

  const clipFull = fixture()
  const existing = sound('existing')
  clipFull.project.assets.push(existing)
  const audioTrack = clipFull.project.tracks.find(track => track.kind === 'audio')
  const template = createClip(existing, clipFull.project)
  audioTrack.clips = Array.from({ length: MAX_CLIPS - 3 }, (_, index) => ({ ...template, id: `sound-clip-${index}` }))
  const clipBefore = structuredClone(clipFull.project)
  assert.throws(() => addTransitionSound(clipFull.project, sound(), clipFull.cut, 0.35), /10000 个片段/)
  assert.deepEqual(clipFull.project, clipBefore)

  const trackFull = fixture()
  trackFull.project.tracks.push(...Array.from({ length: MAX_TRACKS - trackFull.project.tracks.length }, () => createTrack('audio')))
  const trackBefore = structuredClone(trackFull.project)
  assert.throws(() => addTransitionSound(trackFull.project, sound(), trackFull.cut, 0.35), /100 条轨道/)
  assert.deepEqual(trackFull.project, trackBefore)
  trackFull.project.tracks.at(-1).name = TRANSITION_SOUND_TRACK
  const result = addTransitionSound(trackFull.project, sound(), trackFull.cut, 0.35)
  assert.equal(result.trackId, trackFull.project.tracks.at(-1).id)
  assert.equal(result.project.tracks.length, MAX_TRACKS)
})

test('音效用途通过项目校验保留、隐藏于导入素材库，普通导入音频不占用专用音效轨道', () => {
  const { project, cut } = fixture()
  const added = addTransitionSound(project, sound(), cut, 0.35)
  const validated = validateProject(JSON.parse(JSON.stringify(added.project)), { trusted: true })
  assert.equal(validated.assets.find(asset => asset.id === 'sound').libraryRole, 'transition-sound')
  assert.deepEqual(projectSourceAssets(validated).map(asset => asset.id), ['video'])
  validated.tracks = validated.tracks.filter(track => track.kind !== 'audio' || track.name === TRANSITION_SOUND_TRACK)
  const ordinary = sound('ordinary', { libraryRole: undefined })
  const imported = addEditorAssetToTimeline(validated, ordinary)
  assert.notEqual(imported.trackId, added.trackId)
  assert.equal(projectSourceAssets(imported.project).some(asset => asset.id === ordinary.id), true)
  assert.equal(projectSourceAssets(imported.project).some(asset => asset.id === 'sound'), false)
})

test('真实 WAV 音效随草稿与便携工程保存重开，重音、音量、用途和完整字节保留', async () => {
  const previousDatabase = globalThis.indexedDB
  globalThis.indexedDB = new IDBFactory()
  const bytes = readFileSync(new URL('../src/assets/transition-sounds/air-sweep.wav', import.meta.url))
  const blob = new Blob([bytes], { type: 'audio/wav' })
  const { project, video, cut } = fixture()
  const source = sound('portable-sound', { size: blob.size })
  const result = addTransitionSound(project, source, cut, 0.35)
  // 视频字节只作为归档模型夹具；本测试验证实际 WAV 字节持久化，不模拟视频解码。
  const blobs = new Map([[source.id, blob], [video.id, new Blob(['video archive fixture'], { type: 'video/mp4' })]])
  let draft, portable
  try {
    await saveProject(result.project, blobs)
    draft = await loadProject(result.project.id)
    const archive = await exportProjectFile(draft.project, { blobs: draft.blobs })
    portable = await importProjectFile(archive)
    for (const restored of [draft, portable]) {
      assert.deepEqual(restored.project.tracks, result.project.tracks)
      const asset = restored.project.assets.find(item => item.id === source.id)
      assert.equal(asset.libraryRole, 'transition-sound')
      assert.equal(asset.duration, source.duration)
      assert.match(asset.url, /^blob:/)
      assert.deepEqual(Buffer.from(await restored.blobs.get(source.id).arrayBuffer()), bytes)
      assert.equal(projectSourceAssets(restored.project).some(item => item.id === source.id), false)
      const clip = findClip(restored.project, result.clipId).clip
      near(clip.start + 0.35 - clip.trimIn, cut.time)
      assert.equal(clip.volume, findClip(result.project, result.clipId).clip.volume)
    }
  } finally {
    draft?.revoke(); portable?.revoke()
    if (previousDatabase === undefined) delete globalThis.indexedDB
    else globalThis.indexedDB = previousDatabase
  }
})
