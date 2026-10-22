import test from 'node:test'
import assert from 'node:assert/strict'
import { audioSourceDistance, audioSourceTime } from '../src/core/audio-loop.ts'
import { createClip, createProject, validateProject } from '../src/core/project.ts'
import { addAsset, addClip, clipDuration, findClip, setTrack, sourceTimeAt, splitClip, trimClip } from '../src/core/timeline.ts'
import { restoreAudioClipLength, trimClipAtPlayhead } from '../src/core/timeline-editing.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'

function fixture(kind = 'audio') {
  let project = createProject('循环音频')
  const asset = { id: 'audio-loop-source', kind, name: '源音频.wav', duration: 3, width: kind === 'video' ? 320 : 0, height: kind === 'video' ? 180 : 0, size: 4, mime: 'audio/wav', url: 'blob:loop' }
  project = addAsset(project, asset)
  const track = project.tracks.find(track => track.kind === 'audio')
  const clip = createClip(asset, project, { id: 'looping', start: 2, trimIn: 1, trimOut: 13, speed: 2, volume: 0.5, fadeIn: 4, fadeOut: 3 })
  project = addClip(project, track.id, clip)
  return { project, asset, clip, track }
}

test('音频可重复超过源时长，连续源时间用于分割和裁剪，读取时才取循环相位', () => {
  const { project, clip } = fixture()
  assert.equal(clipDuration(clip), 6)
  assert.equal(sourceTimeAt(clip, 6), 9)
  assert.equal(audioSourceTime(sourceTimeAt(clip, 6), 3), 0)
  const split = splitClip(project, clip.id, 5)
  const [left, right] = split.tracks.find(track => track.kind === 'audio').clips
  assert.equal(left.trimOut, 7)
  assert.equal(right.trimIn, 7)
  assert.equal(audioSourceTime(sourceTimeAt(right, 5.5), 3), 2)
  const trimmed = trimClipAtPlayhead(project, clip.id, 6, 'start')
  assert.equal(findClip(trimmed, clip.id).clip.trimIn, 9)
  assert.equal(findClip(trimmed, clip.id).clip.trimOut, 13)
  assert.equal(findClip(trimmed, clip.id).clip.start, 6)
  assert.equal(audioSourceTime(12, 3), 0)
  assert(Math.abs(audioSourceDistance(2.98, 0.02, 3) - 0.04) < 1e-9)
})

test('仅音频轨道可循环，分离的视频声音也可循环，24小时上限仍生效', () => {
  const { project, asset, clip } = fixture('video')
  assert.equal(validateProject(project).tracks.find(track => track.kind === 'audio').clips[0].trimOut, 13)
  const invalid = structuredClone(project)
  invalid.tracks.find(track => track.kind === 'audio').clips = []
  invalid.tracks.find(track => track.kind === 'video').clips.push(clip)
  assert.throws(() => validateProject(invalid), /超出素材/)
  assert.throws(() => trimClip(project, clip.id, 0, 86401), /范围/)
  assert.throws(() => addClip(project, project.tracks.find(track => track.kind === 'video').id, createClip(asset, project, { id: 'invalid', trimOut: 4 })), /超出素材/)
})

test('恢复原长度保留位置速度音量，夹紧淡入淡出，可从循环后的分割点恢复', () => {
  const { project, clip, track } = fixture()
  const before = structuredClone(project)
  const restored = findClip(restoreAudioClipLength(project, clip.id), clip.id).clip
  assert.equal(restored.trimIn, 0)
  assert.equal(restored.trimOut, 3)
  assert.equal(restored.start, 2)
  assert.equal(restored.speed, 2)
  assert.equal(restored.volume, 0.5)
  assert.equal(restored.fadeIn, 1.5)
  assert.equal(restored.fadeOut, 1.5)
  assert.deepEqual(project, before)
  assert.throws(() => restoreAudioClipLength(setTrack(project, track.id, { locked: true }), clip.id), /解锁/)
  assert.throws(() => restoreAudioClipLength(project, 'missing'), /不存在/)
  const split = splitClip(project, clip.id, 5)
  const right = split.tracks.find(track => track.kind === 'audio').clips[1]
  assert.equal(findClip(restoreAudioClipLength(split, right.id), right.id).clip.trimOut, 3)
})

test('便携项目保存打开保留循环源时间和速度，无需展开或复制媒体文件', async () => {
  const { project, asset, clip } = fixture()
  const blob = await exportProjectFile(project, { blobs: new Map([[asset.id, new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' })]]) })
  const imported = await importProjectFile(blob)
  try {
    const restored = findClip(imported.project, clip.id).clip
    assert.equal(restored.trimIn, 1)
    assert.equal(restored.trimOut, 13)
    assert.equal(restored.speed, 2)
    assert.equal(imported.project.assets.length, 1)
  } finally {
    imported.project.assets.forEach(asset => URL.revokeObjectURL(asset.url))
  }
})
