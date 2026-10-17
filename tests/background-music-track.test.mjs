import test from 'node:test'
import assert from 'node:assert/strict'
import { createClip, createProject, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS, validateProject } from '../src/core/project.ts'
import { addBackgroundMusic } from '../src/core/background-music-track.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'
import { clipEnd, commitHistory, createHistory, findClip, redoHistory, undoHistory } from '../src/core/timeline.ts'

function music(id = 'music', patch = {}) {
  return { id, name: '背景音乐.wav', kind: 'audio', url: `blob:${id}`, duration: 32, width: 0, height: 0, size: 128000, mime: 'audio/wav', ...patch }
}

function withMusicTrack(options = {}) {
  const project = createProject('背景音乐项目')
  const asset = music('existing-music', { duration: 20 })
  const track = { ...createTrack('audio', '背景音乐轨道'), ...options }
  track.clips = [createClip(asset, project, { start: 10, trimIn: 4, trimOut: 14, speed: 2 })]
  project.assets.push(asset)
  project.tracks.push(track)
  return { project, track }
}

function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child)
  return Object.freeze(value)
}

test('背景音乐保留完整音频，从精确播放头添加低音量淡入淡出片段，轨道放在末尾且可一次撤销', () => {
  const original = createProject('音乐项目')
  const source = music()
  const before = Date.now()
  const result = addBackgroundMusic(original, source, 3.141592653589793)
  const { clip, track } = findClip(result.project, result.clipId)
  assert.equal(track.id, result.trackId)
  assert.equal(track.name, '背景音乐轨道')
  assert.equal(track.kind, 'audio')
  assert.equal(track.muted, false)
  assert.equal(track.locked, false)
  assert.deepEqual(result.project.tracks.slice(0, -1), original.tracks)
  assert.equal(result.project.tracks.at(-1).id, track.id)
  assert.equal(clip.assetId, source.id)
  assert.equal(clip.start, 3.141592653589793)
  assert.equal(clip.trimIn, 0)
  assert.equal(clip.trimOut, 32)
  assert.equal(clip.speed, 1)
  assert.equal(clip.volume, 0.3)
  assert.equal(clip.fadeIn, 0.5)
  assert.equal(clip.fadeOut, 1)
  assert.ok(Date.parse(clip.generatedAt) >= before && Date.parse(clip.generatedAt) <= Date.now())
  assert.deepEqual(result.project.assets, [source])
  const history = commitHistory(createHistory(original), result.project)
  assert.equal(history.past.length, 1)
  assert.deepEqual(undoHistory(history).present, original)
  assert.deepEqual(redoHistory(undoHistory(history)).present, result.project)
})

test('短音频的淡入淡出各不超过半段长度，并保持原始时长', () => {
  for (const duration of [0.001, 0.1, 1, 1.5]) {
    const result = addBackgroundMusic(createProject(), music('short', { duration }), 0)
    const { clip } = findClip(result.project, result.clipId)
    assert.equal(clip.trimOut, duration)
    assert.ok(clip.fadeIn <= duration / 2)
    assert.ok(clip.fadeOut <= duration / 2)
    assert.ok(clip.fadeIn + clip.fadeOut <= duration)
  }
})

test('空闲背景音乐轨道按裁剪及速度计算占用，边界相接可复用且不改变轨道顺序', () => {
  for (const [start, duration] of [[0, 4], [6, 4], [15, 4]]) {
    const { project, track } = withMusicTrack()
    project.tracks.push(createTrack('text', '前景文字'))
    const result = addBackgroundMusic(project, music('new-music', { duration }), start)
    assert.equal(result.trackId, track.id)
    assert.deepEqual(result.project.tracks.map(item => item.id), project.tracks.map(item => item.id))
    const clips = result.project.tracks.find(item => item.id === track.id).clips
    assert.equal(clips.length, 2)
    assert.deepEqual(clips[0], track.clips[0])
  }
})

test('重叠、锁定、静音或不匹配的轨道不覆盖，自动新建背景音乐轨道', () => {
  for (const [start, duration] of [[9, 2], [10, 4], [12, 1], [14, 2], [9, 7]]) {
    const { project, track } = withMusicTrack()
    const result = addBackgroundMusic(project, music('new', { duration }), start)
    assert.notEqual(result.trackId, track.id)
    assert.deepEqual(result.project.tracks.slice(0, -1), project.tracks)
    assert.equal(result.project.tracks.at(-1).name, '背景音乐轨道')
  }
  for (const options of [{ locked: true }, { muted: true }, { name: '配音轨道' }, { kind: 'video' }, { kind: 'text' }]) {
    const { project, track } = withMusicTrack(options)
    if (track.kind !== 'audio') track.clips = []
    const result = addBackgroundMusic(project, music('new', { duration: 4 }), 0)
    assert.notEqual(result.trackId, track.id)
    assert.deepEqual(result.project.tracks.slice(0, -1), project.tracks)
  }
  const { project } = withMusicTrack({ locked: true })
  const free = createTrack('audio', '背景音乐轨道')
  project.tracks.push(free)
  assert.equal(addBackgroundMusic(project, music('new'), 12).trackId, free.id)
})

test('重复使用素材按标识复用原始内容及地址，生成新的片段', () => {
  const first = addBackgroundMusic(createProject(), music(), 0)
  const second = addBackgroundMusic(first.project, music('music', { duration: 4, url: 'blob:replacement' }), 32)
  assert.equal(second.trackId, first.trackId)
  assert.notEqual(second.clipId, first.clipId)
  assert.equal(second.project.assets.length, 1)
  assert.equal(second.project.assets[0].url, 'blob:music')
  assert.equal(findClip(second.project, second.clipId).clip.trimOut, 32)
})

test('拒绝非音频、空素材、无效时长、起点和非法元数据，24 小时边界不静默裁剪', () => {
  const project = createProject()
  for (const patch of [{ kind: 'video' }, { kind: 'image' }, { size: 0 }, { size: -1 }, { size: NaN }, { size: Infinity }, { url: '' }]) {
    assert.throws(() => addBackgroundMusic(project, music('bad', patch), 0), /音频素材/)
  }
  for (const duration of [0, 0.0001, NaN, Infinity]) assert.throws(() => addBackgroundMusic(project, music('bad', { duration }), 0), /时长/)
  for (const start of [-1, NaN, Infinity, -Infinity, MAX_PROJECT_DURATION]) assert.throws(() => addBackgroundMusic(project, music(), start), /起点|24 小时/)
  assert.throws(() => addBackgroundMusic(project, music('bad', { url: 'javascript:bad' }), 0), /协议/)
  assert.throws(() => addBackgroundMusic(project, music('invalid id'), 0), /标识/)
  assert.throws(() => addBackgroundMusic(project, music('bad', { width: -1 }), 0), /宽度/)
  const edge = addBackgroundMusic(project, music(), MAX_PROJECT_DURATION - 32)
  assert.equal(clipEnd(findClip(edge.project, edge.clipId).clip), MAX_PROJECT_DURATION)
  assert.throws(() => addBackgroundMusic(project, music(), MAX_PROJECT_DURATION - 32 + 0.001), /24 小时/)
  assert.throws(() => addBackgroundMusic(project, music('long', { duration: MAX_PROJECT_DURATION + 1 }), 0), /24 小时/)
})

test('成功与失败都不修改输入，素材、轨道及片段与结果互相隔离', () => {
  const { project } = withMusicTrack()
  const source = music('new', { duration: 4 })
  const snapshot = structuredClone(project)
  deepFreeze(project)
  deepFreeze(source)
  const result = addBackgroundMusic(project, source, 0)
  result.project.assets.at(-1).name = '修改结果'
  result.project.tracks.at(-1).clips[0].start = 99
  assert.equal(source.name, '背景音乐.wav')
  assert.deepEqual(project, snapshot)
  assert.throws(() => addBackgroundMusic(project, source, -1), /起点/)
  assert.deepEqual(project, snapshot)
})

test('容量满时整体失败，已有素材及空闲轨道在对应容量满时仍可复用', () => {
  const fullAssets = createProject()
  fullAssets.assets = Array.from({ length: MAX_ASSETS }, (_, index) => music(`existing-${index}`))
  const assetSnapshot = structuredClone(fullAssets)
  assert.throws(() => addBackgroundMusic(fullAssets, music(), 0), /1000 个素材/)
  assert.deepEqual(fullAssets, assetSnapshot)
  assert.equal(addBackgroundMusic(fullAssets, fullAssets.assets[0], 0).project.assets.length, MAX_ASSETS)

  const { project: fullClips } = withMusicTrack()
  const template = fullClips.tracks.at(-1).clips[0]
  fullClips.tracks.at(-1).clips = Array.from({ length: MAX_CLIPS }, (_, index) => ({ ...template, id: `clip-${index}` }))
  const clipSnapshot = structuredClone(fullClips)
  assert.throws(() => addBackgroundMusic(fullClips, music(), 0), /10000 个片段/)
  assert.deepEqual(fullClips, clipSnapshot)

  const fullTracks = createProject()
  fullTracks.tracks = Array.from({ length: MAX_TRACKS }, () => createTrack('audio'))
  const trackSnapshot = structuredClone(fullTracks)
  assert.throws(() => addBackgroundMusic(fullTracks, music(), 0), /100 条轨道/)
  assert.deepEqual(fullTracks, trackSnapshot)
  fullTracks.tracks.at(-1).name = '背景音乐轨道'
  const result = addBackgroundMusic(fullTracks, music(), 0)
  assert.equal(result.trackId, fullTracks.tracks.at(-1).id)
  assert.equal(result.project.tracks.length, MAX_TRACKS)
  assert.doesNotThrow(() => validateProject(result.project, { trusted: true }))
})

test('真实 WAV 数据随便携项目保存及重开，音乐轨道、原始时长和音量淡化配置保留', async () => {
  const sampleRate = 8000, frames = 800
  const bytes = Buffer.alloc(44 + frames * 2)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40)
  for (let index = 0; index < frames; index++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 4096), 44 + index * 2)
  const blob = new Blob([bytes], { type: 'audio/wav' })
  const source = music('portable-music', { duration: frames / sampleRate, size: blob.size })
  const result = addBackgroundMusic(createProject(), source, 2.125)
  const archive = await exportProjectFile(result.project, { blobs: new Map([[source.id, blob]]) })
  const reopened = await importProjectFile(archive)
  try {
    assert.deepEqual(reopened.project.tracks, result.project.tracks)
    assert.deepEqual(Buffer.from(await reopened.blobs.get(source.id).arrayBuffer()), bytes)
    assert.equal(reopened.project.assets[0].duration, 0.1)
    assert.match(reopened.project.assets[0].url, /^blob:/)
    assert.equal(findClip(reopened.project, result.clipId).clip.start, 2.125)
  } finally { reopened.revoke() }
})
