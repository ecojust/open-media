import test from 'node:test'
import assert from 'node:assert/strict'
import { addEditorAssetToTimeline, projectSourceAssets } from '../src/core/editor-assets.ts'
import { createClip, createProject, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS, validateProject } from '../src/core/project.ts'
import { commitHistory, createHistory, redoHistory, undoHistory } from '../src/core/timeline.ts'

const video = (id, patch = {}) => ({ id, name: `${id}.mp4`, kind: 'video', url: `asset://localhost/${id}`, nativePath: `/app/recordings/${id}.mp4`, duration: 4, width: 1080, height: 1920, size: 100, mime: 'video/mp4', ...patch })
const audio = (id, patch = {}) => video(id, { kind: 'audio', width: 0, height: 0, mime: 'audio/wav', ...patch })

test('项目素材只排除显式内置用途，普通录屏、配音、录音、图片和旧素材均保留', () => {
  const project = createProject()
  project.assets = [
    video('recording'), audio('speech'), audio('microphone'), video('picture', { kind: 'image', duration: 0 }),
    video('legacy-watermark', { name: '内置水印.mp4' }), audio('legacy-music', { name: '背景音乐.wav' }),
    video('watermark', { libraryRole: 'watermark' }), audio('music', { libraryRole: 'background-music' }),
    video('segment', { libraryRole: 'video-segment' }),
  ]
  const watermarkTrack = createTrack('video', '水印轨道'), musicTrack = createTrack('audio', '背景音乐轨道')
  watermarkTrack.clips.push(createClip(project.assets[4], project))
  musicTrack.clips.push(createClip(project.assets[5], project))
  project.tracks.push(watermarkTrack, musicTrack)
  const before = structuredClone(project)
  assert.deepEqual(projectSourceAssets(project).map(asset => asset.id), ['recording', 'speech', 'microphone', 'picture', 'legacy-watermark', 'legacy-music'])
  assert.deepEqual(project, before)
})

test('风格背景与装饰保存后仍归类隐藏，用户同名图片继续作为可选素材', () => {
  const project = createProject()
  const image = (id, patch = {}) => video(id, { name: '风格成片-背景.png', kind: 'image', duration: 0, mime: 'image/png', ...patch })
  project.assets.push(image('user-photo'), image('style-background', { libraryRole: 'motion-style' }), image('style-decoration', { libraryRole: 'motion-style' }))
  project.tracks.find(track => track.kind === 'video').clips.push(createClip(project.assets[1], project), createClip(project.assets[2], project))
  const json = JSON.stringify(project)
  for (const trusted of [true, false]) {
    const reopened = validateProject(JSON.parse(json), { trusted })
    assert.deepEqual(projectSourceAssets(reopened).map(asset => asset.id), ['user-photo'])
    assert.deepEqual(reopened.assets.map(asset => asset.libraryRole), [undefined, 'motion-style', 'motion-style'])
    assert.deepEqual(reopened.tracks.find(track => track.kind === 'video').clips.map(clip => clip.assetId), ['style-background', 'style-decoration'])
  }
  const invalid = JSON.parse(json); invalid.assets[1].libraryRole = 'unrecognized-role'
  assert.throws(() => validateProject(invalid, { trusted: true }), /素材库用途/)
})

test('选中目录中的一项才原子登记到工程、添加片段并匹配首视频尺寸，撤销一步恢复全部', () => {
  const library = [video('first'), video('selected'), video('third')]
  const project = createProject(), before = structuredClone({ project, library })
  const edit = addEditorAssetToTimeline(project, library[1], { start: 3 })
  assert.equal(edit.addedAsset, true)
  assert.equal(edit.assetId, 'selected')
  assert.deepEqual(edit.project.assets.map(asset => asset.id), ['selected'])
  assert.deepEqual([edit.project.width, edit.project.height, edit.project.autoSizeFromVideo], [1080, 1920, false])
  const clip = edit.project.tracks.find(track => track.id === edit.trackId).clips[0]
  assert.deepEqual([clip.id, clip.assetId, clip.start, clip.width, clip.height], [edit.clipId, 'selected', 3, 1080, 1920])
  const history = commitHistory(createHistory(project), edit.project)
  assert.equal(history.past.length, 1)
  assert.deepEqual(undoHistory(history).present, project)
  assert.deepEqual(redoHistory(undoHistory(history)).present, edit.project)
  assert.deepEqual({ project, library }, before)
})

test('重复加入按路径采用旧工程素材标识和名称，不打断旧片段引用也不重复注册', () => {
  const project = createProject('旧工程', { width: 1280, height: 720 })
  const existing = video('old-project-id', { name: '用户重命名.mp4', nativePath: '/app/recordings/shared.mp4', url: 'blob:existing-preview', addedAt: '2026-10-18T10:00:00.000Z' })
  project.assets.push(existing)
  const original = createClip(existing, project)
  project.tracks.find(track => track.kind === 'video').clips.push(original)
  const incoming = video('stored-shared', { nativePath: existing.nativePath, name: 'UUID.mp4', width: 3840, height: 2160 })
  const first = addEditorAssetToTimeline(project, incoming, { start: 4 })
  const second = addEditorAssetToTimeline(first.project, incoming, { start: 8 })
  assert.equal(first.addedAsset, false)
  assert.equal(second.addedAsset, false)
  assert.equal(second.assetId, existing.id)
  assert.deepEqual(second.project.assets, [existing])
  assert.deepEqual(second.project.tracks.find(track => track.kind === 'video').clips[0], original)
  assert.deepEqual(second.project.tracks.find(track => track.kind === 'video').clips.map(clip => clip.assetId), [existing.id, existing.id, existing.id])
  assert.deepEqual([second.project.width, second.project.height], [1280, 720])
  assert.deepEqual(validateProject(second.project, { trusted: true }), second.project)
})

test('跨平台路径去重，网页素材按现有ID复用，冲突ID不会替换其它原文件', () => {
  const project = createProject(), old = video('old', { nativePath: 'C:\\Users\\Media\\Record.MP4' })
  project.assets.push(old)
  const win = addEditorAssetToTimeline(project, video('catalog', { nativePath: 'c:/users/media/record.mp4' }))
  assert.equal(win.assetId, 'old')
  assert.equal(win.project.assets.length, 1)
  const browser = video('browser', { nativePath: undefined, url: 'blob:browser' })
  project.assets.push(browser)
  const web = addEditorAssetToTimeline(project, browser)
  assert.equal(web.addedAsset, false)
  assert.equal(web.assetId, browser.id)
  const before = structuredClone(project)
  assert.throws(() => addEditorAssetToTimeline(project, video('old', { nativePath: '/different/file.mp4' })), /冲突/)
  assert.deepEqual(project, before)
})

test('明确的目标轨道必须存在、解锁且兼容，失败时工程与目录素材保持不变', () => {
  const project = createProject(), source = video('selected'), before = structuredClone({ project, source })
  assert.throws(() => addEditorAssetToTimeline(project, source, { trackId: 'missing' }), /不存在/)
  assert.throws(() => addEditorAssetToTimeline(project, source, { trackId: project.tracks.find(track => track.kind === 'text').id }), /类型/)
  assert.throws(() => addEditorAssetToTimeline(project, audio('audio'), { trackId: project.tracks.find(track => track.kind === 'video').id }), /类型/)
  assert.throws(() => addEditorAssetToTimeline(project, video('image', { kind: 'image', duration: 0 }), { trackId: project.tracks.find(track => track.kind === 'audio').id }), /类型/)
  const locked = structuredClone(project)
  locked.tracks.find(track => track.kind === 'video').locked = true
  assert.throws(() => addEditorAssetToTimeline(locked, source, { trackId: locked.tracks.find(track => track.kind === 'video').id }), /解锁/)
  assert.deepEqual({ project, source }, before)
  assert.equal(locked.assets.length, 0)
  assert.equal(locked.tracks.find(track => track.kind === 'video').clips.length, 0)
  const soundOnly = addEditorAssetToTimeline(project, source, { trackId: project.tracks.find(track => track.kind === 'audio').id })
  assert.equal(soundOnly.trackId, project.tracks.find(track => track.kind === 'audio').id)
})

test('默认添加不占用水印或背景音乐轨道，没有普通可用轨道时只创建一条', () => {
  const project = createProject()
  project.tracks = [createTrack('video', '水印轨道'), createTrack('audio', '背景音乐轨道')]
  const edit = addEditorAssetToTimeline(project, video('source'))
  assert.equal(edit.project.tracks.length, 3)
  assert.equal(edit.project.tracks.find(track => track.name === '水印轨道').clips.length, 0)
  assert.equal(edit.project.tracks.find(track => track.name === '背景音乐轨道').clips.length, 0)
  assert.equal(edit.project.tracks[0].id, edit.trackId)
  assert.equal(edit.project.tracks[0].kind, 'video')
  assert.equal(edit.project.tracks[0].clips.length, 1)
})

test('时长、媒体参数、项目上限失败都不能留下半注册素材或半创建轨道', () => {
  const source = video('selected')
  const cases = [
    [createProject(), source, { start: -1 }],
    [createProject(), source, { start: NaN }],
    [createProject(), source, { start: MAX_PROJECT_DURATION - 1 }],
    [createProject(), { ...source, duration: 0 }, {}],
    [createProject(), { ...source, width: 0 }, {}],
  ]
  const assetsFull = createProject()
  assetsFull.assets = Array.from({ length: MAX_ASSETS }, (_, index) => video(`asset-${index}`))
  cases.push([assetsFull, source, {}])
  const clipsFull = createProject()
  clipsFull.assets.push(source)
  clipsFull.tracks.find(track => track.kind === 'video').clips = Array.from({ length: MAX_CLIPS }, (_, index) => createClip(source, clipsFull, { id: `clip-${index}` }))
  cases.push([clipsFull, source, {}])
  const tracksFull = createProject()
  tracksFull.tracks = Array.from({ length: MAX_TRACKS }, (_, index) => ({ ...createTrack('video'), id: `track-${index}`, locked: true }))
  cases.push([tracksFull, source, {}])
  for (const [project, asset, options] of cases) {
    const before = structuredClone({ project, asset })
    assert.throws(() => addEditorAssetToTimeline(project, asset, options))
    assert.deepEqual({ project, asset }, before)
  }
  const existingAtLimit = addEditorAssetToTimeline(assetsFull, { ...assetsFull.assets[0], id: 'catalog-new-id' })
  assert.equal(existingAtLimit.addedAsset, false)
  assert.equal(existingAtLimit.project.assets.length, MAX_ASSETS)
})

test('默认图片作为可定位静态叠层后置，等比居中且不放大，重叠图片分轨', () => {
  const project = createProject('叠层图片', { width: 640, height: 360 })
  const image = video('overlay', { kind: 'image', duration: 0, width: 800, height: 800, mime: 'image/png' })
  const first = addEditorAssetToTimeline(project, image, { start: 2 })
  const track = first.project.tracks.at(-1), clip = track.clips[0]
  assert.equal(track.id, first.trackId); assert.equal(track.name, '图片轨道')
  assert.deepEqual([clip.x, clip.y, clip.width, clip.height, clip.start, clip.trimOut, clip.volume], [230, 90, 180, 180, 2, 5, 0])
  assert.equal(first.project.autoSizeFromVideo, project.autoSizeFromVideo)
  const second = addEditorAssetToTimeline(first.project, image, { start: 3 })
  assert.notEqual(second.trackId, first.trackId)
  assert.equal(second.project.tracks.at(-1).id, second.trackId)
  assert.deepEqual(second.project.tracks.find(track => track.id === first.trackId), track)
  const adjacent = addEditorAssetToTimeline(first.project, image, { start: 7 })
  assert.equal(adjacent.trackId, first.trackId)
  assert.equal(adjacent.project.tracks.length, first.project.tracks.length)
  const small = addEditorAssetToTimeline(project, { ...image, width: 40, height: 20 })
  assert.deepEqual([small.project.tracks.at(-1).clips[0].width, small.project.tracks.at(-1).clips[0].height], [40, 20])
  const explicit = addEditorAssetToTimeline(first.project, image, { trackId: project.tracks[0].id, start: 2 })
  assert.equal(explicit.trackId, project.tracks[0].id)
  assert.equal(explicit.project.tracks.length, first.project.tracks.length)
  assert.deepEqual(explicit.project.tracks.map(track => track.id), first.project.tracks.map(track => track.id))
})

test('图片自动复用跳过隐藏和锁定轨道，后续视频仍添加到主画面而非图片轨道', () => {
  const image = video('image', { kind: 'image', duration: 0, mime: 'image/png' })
  for (const property of ['hidden', 'locked']) {
    const first = addEditorAssetToTimeline(createProject(), image)
    first.project.tracks.at(-1)[property] = true
    const next = addEditorAssetToTimeline(first.project, image, { start: 8 })
    assert.notEqual(next.trackId, first.trackId)
    assert.equal(next.project.tracks.at(-1).id, next.trackId)
    const source = addEditorAssetToTimeline(next.project, video('main-video'))
    assert.equal(source.trackId, first.project.tracks[0].id)
  }
})
