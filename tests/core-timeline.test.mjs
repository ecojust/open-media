import test from 'node:test'
import assert from 'node:assert/strict'
import { createClip, createProject, createTextClip, createTrack, validateProject } from '../src/core/project.ts'
import { activeClips, addAsset, addClip, addTrack, clipDuration, clipEnd, commitHistory, createHistory, deleteClip, duplicateClip, moveClip, projectDuration, redoHistory, removeAsset, setClipSpeed, setTrack, sourceTimeAt, splitClip, trimClip, undoHistory } from '../src/core/timeline.ts'

function fixture() {
  let project = createProject('时序测试')
  const asset = { id: 'asset-video', name: '片段.mp4', kind: 'video', url: 'blob:test', nativePath: '/private/media/video.mp4', duration: 30, width: 1920, height: 1080, size: 24, mime: 'video/mp4' }
  project = addAsset(project, asset)
  const track = project.tracks.find((track) => track.kind === 'video')
  const clip = createClip(asset, project, { start: 4, trimIn: 6, trimOut: 26, speed: 2, fadeIn: 1, fadeOut: 2 })
  return { project: addClip(project, track.id, clip), asset, track, clip }
}

test('变速裁剪片段按源时间分割，边界只激活一个片段', () => {
  const { project, clip, track } = fixture()
  assert.equal(clipDuration(clip), 10)
  assert.equal(clipEnd(clip), 14)
  assert.equal(sourceTimeAt(clip, 7), 12)
  const split = splitClip(project, clip.id, 7)
  const [left, right] = split.tracks.find((item) => item.id === track.id).clips
  assert.equal(left.trimOut, 12)
  assert.equal(right.trimIn, 12)
  assert.equal(left.fadeOut, 0)
  assert.equal(right.fadeIn, 0)
  assert.equal(right.fadeOut, 2)
  assert.equal(projectDuration(split), 14)
  assert.equal(activeClips(split, 7).length, 1)
  assert.equal(activeClips(split, 7)[0].clip.id, right.id)
  assert.equal(activeClips(split, 14).length, 0)
  assert.equal(project.tracks.find((item) => item.id === track.id).clips.length, 1)
  assert.throws(() => splitClip(project, clip.id, 4), /内部/)
  assert.throws(() => splitClip(project, clip.id, 14), /内部/)
})

test('变速后时长和复制起点同步更新，裁剪不能超出媒体源', () => {
  const { project, clip, track } = fixture()
  const faster = setClipSpeed(project, clip.id, 4)
  assert.equal(projectDuration(faster), 9)
  const duplicated = duplicateClip(faster, clip.id)
  const clips = duplicated.tracks.find((item) => item.id === track.id).clips
  assert.equal(clips[1].start, 9)
  assert.equal(projectDuration(duplicated), 14)
  assert.throws(() => trimClip(project, clip.id, 25, 31), /超出素材/)
  assert.throws(() => trimClip(project, clip.id, 28, 20), /时长无效/)
  assert.throws(() => setClipSpeed(project, clip.id, 0), /速度/)
})

test('锁定轨道禁止编辑，跨轨移动校验素材兼容性', () => {
  const { project, clip, track } = fixture()
  const locked = setTrack(project, track.id, { locked: true })
  assert.throws(() => deleteClip(locked, clip.id), /解锁/)
  assert.throws(() => moveClip(locked, clip.id, project.tracks[2].id, 0), /解锁/)
  assert.throws(() => moveClip(project, clip.id, project.tracks[0].id, 0), /字幕和媒体/)
  const moved = moveClip(project, clip.id, project.tracks[2].id, 1)
  assert.equal(moved.tracks[2].clips[0].id, clip.id)
  assert.throws(() => removeAsset(project, 'asset-video'), /正在时间线/)
  const without = removeAsset(deleteClip(project, clip.id), 'asset-video')
  assert.equal(without.assets.length, 0)
})

test('静态图片和字幕可延长，视频时长有限，轨道重叠保留独立源时间', () => {
  let project = createProject('图文')
  const image = { id: 'image', name: '图.png', kind: 'image', url: 'blob:image', duration: 5, width: 320, height: 240, size: 12, mime: 'image/png' }
  project = addAsset(project, image)
  project = addClip(project, project.tracks[1].id, createClip(image, project, { trimOut: 20 }))
  project = addClip(project, project.tracks[0].id, createTextClip(project, { text: '第三秒出现', start: 3, trimOut: 2 }))
  assert.equal(activeClips(project, 4).length, 2)
  assert.equal(activeClips(project, 5).length, 1)
  assert.equal(projectDuration(project), 20)
  const second = createTrack('video')
  project = addTrack(project, second)
  assert.equal(project.tracks.at(-1).id, second.id)
})

test('历史快照隔离对象，忽略只有保存时间的变化，撤销后新编辑清空重做', () => {
  const { project, clip } = fixture()
  let history = createHistory(project, 2)
  const changed = setClipSpeed(project, clip.id, 4)
  history = commitHistory(history, changed)
  changed.title = '外部修改不会渗入历史'
  assert.equal(history.present.title, '时序测试')
  assert.equal(commitHistory(history, { ...history.present, updatedAt: '2020-01-01T00:00:00.000Z' }), history)
  history = undoHistory(history)
  assert.equal(projectDuration(history.present), 14)
  assert.equal(projectDuration(redoHistory(history).present), 9)
  history = commitHistory(history, duplicateClip(history.present, clip.id))
  assert.equal(history.future.length, 0)
})

test('导入丢弃机器路径和活动URL，并拒绝重复标识、无效引用与非有限数值', () => {
  const { project } = fixture()
  const restored = validateProject(project)
  assert.equal(restored.assets[0].url, '')
  assert.equal(restored.assets[0].nativePath, undefined)
  assert.equal(project.assets[0].nativePath, '/private/media/video.mp4')
  assert.equal(validateProject(project, { trusted: true }).assets[0].url, 'blob:test')
  const duplicate = structuredClone(project)
  duplicate.assets.push({ ...duplicate.assets[0] })
  assert.throws(() => validateProject(duplicate), /重复/)
  const invalid = structuredClone(project)
  invalid.tracks[1].clips[0].assetId = 'unknown'
  assert.throws(() => validateProject(invalid), /不存在/)
  invalid.tracks[1].clips[0].assetId = 'asset-video'
  invalid.tracks[1].clips[0].start = Infinity
  assert.throws(() => validateProject(invalid), /范围/)
  const activeUrl = structuredClone(project)
  activeUrl.assets[0].url = 'javascript:alert(1)'
  assert.throws(() => validateProject(activeUrl, { trusted: true }), /协议/)
})
