import test from 'node:test'
import assert from 'node:assert/strict'
import { createClip, createProject, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS, validateProject } from '../src/core/project.ts'
import { addWatermark } from '../src/core/watermark-track.ts'
import { commitHistory, createHistory, findClip, redoHistory, undoHistory } from '../src/core/timeline.ts'

function visual(id = 'watermark', patch = {}) {
  return { id, name: '动态水印.webm', kind: 'video', url: `blob:${id}`, duration: 4, width: 640, height: 360, size: 128000, mime: 'video/webm', ...patch }
}

function withWatermarkTrack(options = {}) {
  const project = createProject()
  const asset = visual('existing-watermark', { duration: 20 })
  const track = { ...createTrack('video', '水印轨道'), ...options }
  track.clips = [createClip(asset, project, { start: 10, trimIn: 4, trimOut: 14, speed: 2 })]
  project.assets.push(asset)
  project.tracks.push(track)
  return { project, track }
}

function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child)
  return Object.freeze(value)
}

function close(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} 应接近 ${expected}`) }

test('水印从精确播放头开始，位于最前景，静音且一次撤销包含素材、轨道和片段', () => {
  const original = createProject()
  const asset = visual()
  const result = addWatermark(original, asset, 3.25)
  const { clip, track } = findClip(result.project, result.clipId)
  assert.equal(result.project.tracks[0].id, result.trackId)
  assert.equal(track.name, '水印轨道')
  assert.equal(track.kind, 'video')
  assert.equal(track.locked, false)
  assert.equal(track.muted, false)
  assert.equal(clip.start, 3.25)
  assert.equal(clip.assetId, asset.id)
  assert.equal(clip.trimIn, 0)
  assert.equal(clip.trimOut, asset.duration)
  assert.equal(clip.speed, 1)
  assert.equal(clip.volume, 0)
  close(clip.width, original.width * 0.38)
  close(clip.width / clip.height, asset.width / asset.height)
  close(clip.x, original.width * 0.96 - clip.width)
  assert.equal(clip.y, original.height * 0.04)
  assert.equal(clip.chromaKey, undefined)
  const history = commitHistory(createHistory(original), result.project)
  assert.equal(history.past.length, 1)
  assert.deepEqual(undoHistory(history).present, original)
  assert.deepEqual(redoHistory(undoHistory(history)).present, result.project)
})

test('图片统一显示五秒，并保留原图宽高比例', () => {
  for (const duration of [0, 2, 10]) {
    const result = addWatermark(createProject(), visual('still', { kind: 'image', duration, width: 400, height: 800, mime: 'image/png' }), 2)
    const { clip } = findClip(result.project, result.clipId)
    assert.equal(clip.trimOut - clip.trimIn, 5)
    assert.equal(clip.width / clip.height, 0.5)
    assert.ok(clip.y + clip.height <= result.project.height * 0.96)
  }
})

test('六种位置均留出边距，竖幅和横幅项目中的水印不超出画面', () => {
  for (const [width, height] of [[1920, 1080], [720, 1280], [16, 16]]) {
    const project = createProject('位置', { width, height })
    for (const placement of ['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'bottom-center']) {
      const result = addWatermark(project, visual('portrait', { width: 600, height: 1800 }), 0, { placement })
      const { clip } = findClip(result.project, result.clipId)
      assert.ok(clip.x >= width * 0.04 - 1e-9)
      assert.ok(clip.y >= height * 0.04 - 1e-9)
      assert.ok(clip.x + clip.width <= width * 0.96 + 1e-9)
      assert.ok(clip.y + clip.height <= height * 0.96 + 1e-9)
      close(clip.width / clip.height, 1 / 3)
      if (placement.endsWith('left')) assert.equal(clip.x, width * 0.04)
      if (placement.endsWith('right')) assert.equal(clip.x, width - width * 0.04 - clip.width)
      if (placement.startsWith('top')) assert.equal(clip.y, height * 0.04)
      if (placement.startsWith('bottom')) assert.equal(clip.y, height - height * 0.04 - clip.height)
      if (placement === 'center' || placement === 'bottom-center') assert.equal(clip.x, (width - clip.width) / 2)
      if (placement === 'center') assert.equal(clip.y, (height - clip.height) / 2)
    }
  }
})

test('复用空闲水印轨道时按裁剪与速度计算边界，并将轨道置于前景', () => {
  for (const [start, duration] of [[0, 4], [6, 4], [15, 4]]) {
    const { project, track } = withWatermarkTrack()
    const result = addWatermark(project, visual('new', { duration }), start)
    assert.equal(result.trackId, track.id)
    assert.equal(result.project.tracks.length, project.tracks.length)
    assert.equal(result.project.tracks[0].id, track.id)
    assert.deepEqual(result.project.tracks[0].clips[0], track.clips[0])
    assert.equal(result.project.tracks[0].clips.length, 2)
  }
})

test('重叠水印新增前景轨道，保留原素材和片段', () => {
  for (const [start, duration] of [[9, 2], [10, 4], [12, 1], [14, 2], [9, 7]]) {
    const { project, track } = withWatermarkTrack()
    const result = addWatermark(project, visual('new', { duration }), start)
    assert.notEqual(result.trackId, track.id)
    assert.equal(result.project.tracks[0].id, result.trackId)
    assert.equal(result.project.tracks.length, project.tracks.length + 1)
    assert.deepEqual(result.project.tracks.find((item) => item.id === track.id), track)
  }
})

test('锁定、隐藏、异名或其他类型的轨道不接收水印', () => {
  for (const options of [{ locked: true }, { muted: true }, { name: '主视频' }, { kind: 'audio' }, { kind: 'text' }]) {
    const { project, track } = withWatermarkTrack(options)
    if (track.kind === 'text') track.clips = []
    const result = addWatermark(project, visual('new'), 0)
    assert.notEqual(result.trackId, track.id)
    assert.deepEqual(result.project.tracks.find((item) => item.id === track.id), track)
  }
  const { project } = withWatermarkTrack({ locked: true })
  const available = createTrack('video', '水印轨道')
  project.tracks.push(available)
  assert.equal(addWatermark(project, visual('new'), 12).trackId, available.id)
})

test('重复添加同一素材复用原素材，不替换已导入地址或产生重复标识', () => {
  const first = addWatermark(createProject(), visual(), 0)
  const second = addWatermark(first.project, visual('watermark', { url: 'blob:other', duration: 8 }), 4)
  assert.equal(second.project.assets.length, 1)
  assert.equal(second.project.assets[0].url, 'blob:watermark')
  assert.equal(findClip(second.project, second.clipId).clip.trimOut, 4)
  assert.equal(second.trackId, first.trackId)
  assert.notEqual(second.clipId, first.clipId)
})

test('绿幕水印持久化抠像参数，普通水印不带抠像配置', () => {
  const result = addWatermark(createProject(), visual(), 1, { chromaKey: true, placement: 'bottom-center' })
  const { clip } = findClip(result.project, result.clipId)
  assert.equal(clip.chromaKey.enabled, true)
  assert.equal(clip.chromaKey.color, '#00ff00')
  assert.ok(clip.chromaKey.similarity > 0)
  assert.equal(Object.hasOwn(clip.chromaKey, 'spillSuppression'), false)
  const restored = validateProject(JSON.parse(JSON.stringify(result.project)), { trusted: true })
  assert.deepEqual(findClip(restored, result.clipId).clip.chromaKey, clip.chromaKey)
  const plain = addWatermark(createProject(), visual(), 1, { chromaKey: false })
  assert.equal(findClip(plain.project, plain.clipId).clip.chromaKey, undefined)
  const suppressed = addWatermark(createProject(), visual(), 1, { chromaKey: true, spillSuppression: true })
  assert.equal(findClip(suppressed.project, suppressed.clipId).clip.chromaKey.spillSuppression, true)
  assert.equal(findClip(validateProject(suppressed.project), suppressed.clipId).clip.chromaKey.spillSuppression, true)
  assert.throws(() => addWatermark(createProject(), visual(), 1, { chromaKey: true, spillSuppression: 'true' }), /溢色抑制/)
})

test('成功和失败均不更改输入，输出素材和轨道与输入互相隔离', () => {
  const { project } = withWatermarkTrack()
  const original = structuredClone(project)
  const asset = visual('new')
  deepFreeze(project)
  deepFreeze(asset)
  const result = addWatermark(project, asset, 0)
  result.project.assets.at(-1).name = '外部修改'
  result.project.tracks[0].clips[0].start = 99
  assert.deepEqual(project, original)
  assert.equal(asset.name, '动态水印.webm')
  assert.throws(() => addWatermark(project, asset, -1), /起点/)
  assert.deepEqual(project, original)
})

test('无效水印或起点完整拒绝，结束时间不静默截断', () => {
  const project = createProject()
  for (const patch of [{ kind: 'audio' }, { size: 0 }, { size: NaN }, { url: '' }, { width: 0 }, { height: Infinity }]) {
    assert.throws(() => addWatermark(project, visual('bad', patch), 0), /视频或图片/)
  }
  for (const duration of [0, 0.0001, NaN, Infinity]) assert.throws(() => addWatermark(project, visual('bad', { duration }), 0), /时长/)
  for (const start of [-1, NaN, Infinity, -Infinity, MAX_PROJECT_DURATION]) assert.throws(() => addWatermark(project, visual(), start), /起点|24 小时/)
  assert.throws(() => addWatermark(project, visual('bad', { url: 'javascript:bad' }), 0), /协议/)
  assert.throws(() => addWatermark(project, visual('bad', { id: 'invalid id' }), 0), /标识/)
  assert.throws(() => addWatermark(project, visual(), 0, { placement: 'unknown' }), /位置/)
  assert.throws(() => addWatermark(project, visual(), 0, { chromaKey: 'true' }), /抠像开关/)
  const result = addWatermark(project, visual(), MAX_PROJECT_DURATION - 4)
  assert.equal(findClip(result.project, result.clipId).clip.start, MAX_PROJECT_DURATION - 4)
  assert.throws(() => addWatermark(project, visual(), MAX_PROJECT_DURATION - 4 + 0.001), /24 小时/)
})

test('素材和片段上限整体失败，素材已存在时允许容量满后再次使用', () => {
  const fullAssets = createProject()
  fullAssets.assets = Array.from({ length: MAX_ASSETS }, (_, index) => visual(`existing-${index}`))
  const snapshot = structuredClone(fullAssets)
  assert.throws(() => addWatermark(fullAssets, visual(), 0), /1000 个素材/)
  assert.deepEqual(fullAssets, snapshot)
  const result = addWatermark(fullAssets, fullAssets.assets[0], 0)
  assert.equal(result.project.assets.length, MAX_ASSETS)

  const { project } = withWatermarkTrack()
  const template = project.tracks.at(-1).clips[0]
  project.tracks.at(-1).clips = Array.from({ length: MAX_CLIPS }, (_, index) => ({ ...template, id: `clip-${index}` }))
  const clipSnapshot = structuredClone(project)
  assert.throws(() => addWatermark(project, visual(), 0), /10000 个片段/)
  assert.deepEqual(project, clipSnapshot)
})

test('轨道上限时拒绝新增，但空闲水印轨道仍可复用', () => {
  const project = createProject()
  project.tracks = Array.from({ length: MAX_TRACKS }, () => createTrack('video'))
  const snapshot = structuredClone(project)
  assert.throws(() => addWatermark(project, visual(), 0), /100 条轨道/)
  assert.deepEqual(project, snapshot)
  project.tracks.at(-1).name = '水印轨道'
  const result = addWatermark(project, visual(), 0)
  assert.equal(result.trackId, project.tracks.at(-1).id)
  assert.equal(result.project.tracks.length, MAX_TRACKS)
  assert.equal(result.project.tracks[0].id, result.trackId)
})
