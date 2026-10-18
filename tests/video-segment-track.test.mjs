import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createClip, createProject, createTextClip, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS } from '../src/core/project.ts'
import { insertVideoSegment } from '../src/core/video-segment-track.ts'
import { VIDEO_SEGMENT_PRESETS } from '../src/core/video-segment-presets.ts'
import { clipEnd, commitHistory, createHistory, findClip, projectDuration, redoHistory, undoHistory } from '../src/core/timeline.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'
import { addTransition } from '../src/core/transitions.ts'

const asset = (id = 'segment', patch = {}) => ({ id, name: '片头.webm', kind: 'video', url: `blob:${id}`, duration: 5, width: 1280, height: 720, size: 120000, mime: 'video/webm', ...patch })
function populated() {
  const project = createProject('带音画及配音的项目', { width: 1000, height: 800 })
  const video = asset('source', { duration: 20 })
  const audio = asset('speech', { kind: 'audio', width: 0, height: 0, mime: 'audio/wav', duration: 4 })
  const text = createTextClip(project, { start: 3, trimOut: 4, text: '原始字幕' })
  project.assets.push(video, audio)
  project.tracks[0].clips.push(text)
  project.tracks[1].clips.push(createClip(video, project, { start: 2, trimIn: 4, trimOut: 20, speed: 2 }))
  project.tracks[2].clips.push(createClip(audio, project, { start: 3, speech: { textClipId: text.id, text: text.text, voiceId: 'model', rate: 1 } }))
  return project
}

test('前插整体后移所有原片段，保留音画字幕绑定、裁剪与速度，不改变项目尺寸，可一次撤销', () => {
  const project = populated(), before = structuredClone(project)
  const result = insertVideoSegment(project, asset(), 'prepend', VIDEO_SEGMENT_PRESETS[0])
  assert.deepEqual(project, before)
  assert.equal(result.start, 0); assert.equal(result.duration, 5)
  for (const track of project.tracks) for (const clip of track.clips) {
    assert.deepEqual(findClip(result.project, clip.id).clip, { ...clip, start: clip.start + 5 })
  }
  assert.equal(result.project.width, 1000); assert.equal(result.project.height, 800)
  assert.equal(result.project.autoSizeFromVideo, false)
  assert.equal(projectDuration(result.project), projectDuration(project) + 5)
  const inserted = findClip(result.project, result.clipId)
  assert.equal(inserted.track.id, result.trackId)
  assert.equal(inserted.track.name, '视频片段轨道')
  assert.equal(inserted.clip.trimOut, 5); assert.equal(inserted.clip.fit, 'cover')
  const history = commitHistory(createHistory(project), result.project)
  assert.deepEqual(undoHistory(history).present, project)
  assert.deepEqual(redoHistory(undoHistory(history)).present, result.project)
})

test('后插使用全部轨道最大结束时间，锁定和静音轨道仍计入，已有内容原样保留', () => {
  const project = populated()
  project.tracks[2].clips[0].start = 25
  project.tracks[2].locked = true; project.tracks[2].muted = true
  const originalDuration = projectDuration(project)
  const result = insertVideoSegment(project, asset(), 'append')
  assert.equal(result.start, originalDuration)
  assert.equal(result.start, 29)
  assert.deepEqual(result.project.tracks.slice(0, project.tracks.length), project.tracks)
  assert.equal(clipEnd(findClip(result.project, result.clipId).clip), 34)
})

test('内置模板添加独立可编辑标题，空标题不生成空字幕，也不覆盖字幕默认配置', () => {
  const project = createProject()
  const result = insertVideoSegment(project, asset(), 'append', { heading: ' 定制标题 ', subheading: ' 自由编辑 ', textColor: '#abcdef' })
  const titles = result.project.tracks[0]
  assert.equal(titles.name, '片头片尾文字')
  assert.equal(titles.kind, 'text')
  assert.deepEqual(titles.clips.map(clip => clip.text), ['定制标题', '自由编辑'])
  for (const clip of titles.clips) {
    assert.equal(clip.textRole, 'watermark'); assert.equal(clip.color, '#abcdef')
    assert.equal(clip.background, 'transparent'); assert.equal(clip.start, 0); assert.equal(clipEnd(clip), 5)
  }
  assert.equal(result.project.subtitleStyle, undefined)
  assert.equal(result.project.autoSizeFromVideo, project.autoSizeFromVideo)
  const noTitle = insertVideoSegment(project, asset(), 'prepend', { heading: ' ', subheading: '', textColor: '#ffffff' })
  assert.equal(noTitle.project.tracks.length, project.tracks.length + 1)
  assert.equal(noTitle.project.tracks.flatMap(track => track.clips).length, 1)
})

test('连续添加复用素材和可编辑轨道，标题时段跟随整体平移；静音轨道另建', () => {
  const first = insertVideoSegment(createProject(), asset(), 'append', VIDEO_SEGMENT_PRESETS[0])
  const second = insertVideoSegment(first.project, asset('segment', { duration: 2 }), 'prepend', VIDEO_SEGMENT_PRESETS[1])
  assert.equal(second.project.assets.length, 1); assert.equal(second.duration, 5)
  assert.equal(first.trackId, second.trackId)
  assert.equal(findClip(second.project, first.clipId).clip.start, 5)
  assert.equal(second.project.tracks[0].clips.length, 4)
  first.project.tracks.find(track => track.id === first.trackId).muted = true
  assert.notEqual(insertVideoSegment(first.project, asset(), 'append').trackId, first.trackId)
})

test('片头和片尾优先沿用相接的主视频轨道，支持与正文之间添加转场', () => {
  const project = createProject()
  const source = asset('main', { duration: 20 })
  project.assets.push(source)
  const main = createClip(source, project)
  project.tracks[1].clips.push(main)
  project.tracks[1].name = '我的主视频'
  const opening = insertVideoSegment(project, asset('opening'), 'prepend', VIDEO_SEGMENT_PRESETS[0])
  assert.equal(opening.trackId, project.tracks[1].id)
  assert.equal(findClip(opening.project, opening.clipId).track.name, '我的主视频')
  const withOpeningTransition = addTransition(opening.project, 5, 'fade', 1, opening.trackId)
  const ending = insertVideoSegment(withOpeningTransition, asset('ending'), 'append', VIDEO_SEGMENT_PRESETS[5])
  assert.equal(ending.trackId, opening.trackId)
  assert.equal(ending.start, 25)
  const withBothTransitions = addTransition(ending.project, 25, 'wipe-up', 1, ending.trackId)
  const transitions = withBothTransitions.tracks.filter(track => track.kind === 'transition').flatMap(track => track.clips)
  assert.equal(transitions.length, 2)
  assert.deepEqual(transitions.map(clip => clip.transition.fromClipId), [opening.clipId, main.id])
  const earlier = insertVideoSegment(withBothTransitions, asset('earlier'), 'prepend')
  for (const clip of transitions) assert.equal(findClip(earlier.project, clip.id).clip.start, clip.start + 5)
})

test('锁定非空轨道前插明确失败且不修改原项目；锁定空轨道不妨碍前插', () => {
  for (const index of [0, 1, 2]) {
    const project = populated()
    project.tracks[index].locked = true
    const before = structuredClone(project)
    assert.throws(() => insertVideoSegment(project, asset(), 'prepend'), /整体后移.*解锁/)
    assert.deepEqual(project, before)
  }
  const empty = createProject()
  empty.tracks.forEach(track => { track.locked = true })
  assert.doesNotThrow(() => insertVideoSegment(empty, asset(), 'prepend'))
})

test('无效素材、方向、标题、超时和容量拒绝时保持操作原子性', () => {
  const project = populated(), before = structuredClone(project)
  for (const patch of [{ kind: 'audio' }, { kind: 'image' }, { url: '' }, { size: 0 }, { size: NaN }]) assert.throws(() => insertVideoSegment(project, asset('bad', patch), 'append'), /视频素材/)
  for (const duration of [0, -2, Infinity, NaN]) assert.throws(() => insertVideoSegment(project, asset('bad', { duration }), 'prepend'), /时长/)
  assert.throws(() => insertVideoSegment(project, asset(), 'middle'), /向前或向后/)
  assert.throws(() => insertVideoSegment(project, asset(), 'append', { heading: 'a'.repeat(121), subheading: '', textColor: '#fff' }), /标题/)
  assert.throws(() => insertVideoSegment(project, asset(), 'append', { heading: 'x', subheading: '', textColor: 'url(bad)' }), /颜色/)
  assert.deepEqual(project, before)
  const long = createProject(), source = asset('long', { duration: MAX_PROJECT_DURATION })
  long.assets.push(source); long.tracks[1].clips.push(createClip(source, long))
  assert.throws(() => insertVideoSegment(long, asset(), 'prepend'), /24 小时/)
  const fullAssets = createProject()
  fullAssets.assets = Array.from({ length: MAX_ASSETS }, (_, index) => asset(`asset-${index}`))
  assert.throws(() => insertVideoSegment(fullAssets, asset(), 'append'), /1000 个素材/)
  assert.equal(insertVideoSegment(fullAssets, fullAssets.assets[0], 'append').project.assets.length, MAX_ASSETS)
  const fullTracks = createProject()
  fullTracks.tracks = Array.from({ length: MAX_TRACKS }, () => createTrack('audio'))
  assert.throws(() => insertVideoSegment(fullTracks, asset(), 'append'), /100 条轨道/)
  const fullClips = populated(), base = fullClips.tracks[1].clips[0]
  fullClips.tracks[1].clips = Array.from({ length: MAX_CLIPS - 3 }, (_, index) => ({ ...base, id: `clip-${index}` }))
  assert.throws(() => insertVideoSegment(fullClips, asset(), 'append', VIDEO_SEGMENT_PRESETS[0]), /10000 个片段/)
})

test('真实内置视频随便携项目保存并重开，标题、位置和视频字节保留', async () => {
  const bytes = readFileSync(new URL('../src/assets/video-segments/midnight-orbit.webm', import.meta.url))
  const source = asset('portable-segment', { size: bytes.length })
  const original = insertVideoSegment(createProject(), source, 'prepend', VIDEO_SEGMENT_PRESETS[0])
  const archive = await exportProjectFile(original.project, { blobs: new Map([[source.id, new Blob([bytes], { type: 'video/webm' })]]) })
  const reopened = await importProjectFile(archive)
  try {
    assert.deepEqual(reopened.project.tracks, original.project.tracks)
    assert.deepEqual(Buffer.from(await reopened.blobs.get(source.id).arrayBuffer()), bytes)
    assert.match(reopened.project.assets[0].url, /^blob:/)
  } finally { reopened.revoke() }
})
