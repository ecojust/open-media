import test from 'node:test'
import assert from 'node:assert/strict'
import { createClip, createProject, createSubtitleClip, validateProject } from '../src/core/project.ts'
import { adoptFirstVideoSize, MIN_PROJECT_SIZE, MAX_PROJECT_SIZE, projectSizeError, resizeProject, resizeProjectToVideoClip, videoClipSourceSize } from '../src/core/project-size.ts'
import { addAssets, addClip, commitHistory, createHistory, redoHistory, undoHistory, updateClip } from '../src/core/timeline.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'

const video = (id, width, height) => ({ id, name: `${id}.webm`, kind: 'video', width, height, duration: 1, url: '', size: 0, mime: 'video/webm' })
const portrait = video('portrait', 1080, 1920), landscape = video('landscape', 3840, 2160)
function importAssets(project, assets) { return adoptFirstVideoSize(addAssets(project, assets), assets) }

test('默认项目仅跟随第一次有效视频的原始尺寸，横竖屏与批量导入均保持来源顺序', () => {
  const initial = createProject()
  assert.equal(initial.autoSizeFromVideo, true)
  for (const asset of [portrait, landscape, video('odd-size', 853, 479)]) {
    const next = importAssets(initial, [asset])
    assert.deepEqual([next.width, next.height, next.autoSizeFromVideo], [asset.width, asset.height, false])
    assert.equal(next.assets[0].id, asset.id)
    const later = importAssets(next, [video('later', 1280, 720)])
    assert.deepEqual([later.width, later.height], [asset.width, asset.height])
  }
  const batch = importAssets(initial, [portrait, landscape])
  assert.deepEqual([batch.width, batch.height], [1080, 1920])
  assert.equal(initial.autoSizeFromVideo, true)
  assert.deepEqual([initial.width, initial.height], [1920, 1080])
})

test('图片和音频不抢占源尺寸，无法用于项目尺寸的视频也不消耗首次匹配', () => {
  const initial = createProject()
  const other = [
    { ...portrait, id: 'still', name: 'still.png', kind: 'image', mime: 'image/png', duration: 0 },
    { ...portrait, id: 'sound', name: 'sound.wav', kind: 'audio', mime: 'audio/wav', width: 0, height: 0 },
  ]
  let next = importAssets(initial, other)
  assert.deepEqual([next.width, next.height, next.autoSizeFromVideo], [1920, 1080, true])
  next = importAssets(next, [video('tiny', 8, 8), video('oversized', 20000, 20000)])
  assert.equal(next.autoSizeFromVideo, true)
  next = importAssets(next, [portrait])
  assert.deepEqual([next.width, next.height, next.autoSizeFromVideo], [1080, 1920, false])
  const invalid = [video('unknown', NaN, 1080), video('fractional', 853.5, 479), video('infinite', 1920, Infinity)]
  assert.strictEqual(adoptFirstVideoSize(initial, invalid), initial)
  const validAfterInvalid = adoptFirstVideoSize(initial, [...invalid, portrait])
  assert.deepEqual([validAfterInvalid.width, validAfterInvalid.height, validAfterInvalid.autoSizeFromVideo], [1080, 1920, false])
})

test('手动尺寸、旧项目与再次打开的已有项目均保持原设置，修改帧率不取消匹配', () => {
  for (const options of [{ width: 1280 }, { height: 720 }, { width: 2560, height: 1440 }]) {
    const project = createProject('自定尺寸', options)
    assert.equal(project.autoSizeFromVideo, false)
    const next = importAssets(project, [portrait])
    assert.deepEqual([next.width, next.height], [project.width, project.height])
  }
  const legacy = createProject()
  delete legacy.autoSizeFromVideo
  const reopened = validateProject(JSON.parse(JSON.stringify(legacy)), { trusted: true })
  assert.equal(reopened.autoSizeFromVideo, undefined)
  assert.deepEqual([importAssets(reopened, [portrait]).width, importAssets(reopened, [portrait]).height], [1920, 1080])
  const fps = createProject('高帧率', { fps: 60, background: '#ffffff' })
  assert.equal(importAssets(fps, [portrait]).width, 1080)
  assert.equal(importAssets(fps, [portrait]).fps, 60)
  assert.throws(() => validateProject({ ...fps, autoSizeFromVideo: 'true' }), /开关/)
})

test('首次导入按比例移动现有画面与字幕样式，不改内容、时间或音频几何，输入保持不可变', () => {
  let project = createProject()
  const subtitle = createSubtitleClip(project, { text: '沿用字幕配置', start: 2, color: '#ffcc55', textAlign: 'right' })
  project = addClip(project, project.tracks.find(track => track.kind === 'text').id, subtitle)
  project = updateClip(project, subtitle.id, { x: 240, width: 1200 })
  const audio = { ...portrait, id: 'voice', kind: 'audio', width: 0, height: 0, mime: 'audio/wav' }
  project = addAssets(project, [audio])
  project = addClip(project, project.tracks.find(track => track.kind === 'audio').id, createClip(audio, project))
  const original = structuredClone(project)
  const next = importAssets(project, [portrait]), clip = next.tracks.find(track => track.kind === 'text').clips[0]
  const sx = 1080 / 1920, sy = 1920 / 1080
  for (const item of [clip, next.subtitleStyle]) {
    assert.equal(item.x, 240 * sx); assert.equal(item.y, subtitle.y * sy)
    assert.equal(item.width, 1200 * sx); assert.equal(item.height, subtitle.height * sy)
    assert.equal(item.fontSize, subtitle.fontSize * sx)
    assert.equal(item.color, subtitle.color); assert.equal(item.textAlign, subtitle.textAlign)
  }
  assert.equal(clip.text, subtitle.text); assert.equal(clip.start, subtitle.start)
  assert.equal(clip.generatedAt, subtitle.generatedAt)
  assert.deepEqual(next.tracks.find(track => track.kind === 'audio'), project.tracks.find(track => track.kind === 'audio'))
  assert.deepEqual(project, original)
  const tiny = importAssets(project, [video('small', 16, 16)])
  assert.equal(tiny.tracks.find(track => track.kind === 'text').clips[0].fontSize, 4)
})

test('源尺寸状态与导入一起撤销重做，并在项目文件中持久化', async () => {
  const initial = createProject()
  const next = importAssets(initial, [portrait])
  const history = commitHistory(createHistory(initial), next)
  const undo = undoHistory(history), redo = redoHistory(undo)
  assert.equal(undo.present.autoSizeFromVideo, true)
  assert.deepEqual([undo.present.width, undo.present.height], [1920, 1080])
  assert.equal(redo.present.autoSizeFromVideo, false)
  assert.deepEqual([redo.present.width, redo.present.height], [1080, 1920])
  for (const source of [initial, { ...next, assets: [] }]) {
    const loaded = await importProjectFile(await exportProjectFile(source))
    try {
      assert.equal(loaded.project.autoSizeFromVideo, source.autoSizeFromVideo)
      assert.deepEqual([loaded.project.width, loaded.project.height], [source.width, source.height])
    } finally { loaded.revoke() }
  }
})

test('项目尺寸只接受范围内的有限整数，空值和小数不会被静默转换', () => {
  const initial = createProject()
  for (const value of ['', '1920', null, undefined, NaN, Infinity, -Infinity, 0, -10, 15, 16385, 1280.5]) {
    for (const [width, height] of [[value, 1080], [1920, value]]) {
      assert.match(projectSizeError(width, height), /16.*16384.*整数/)
      assert.throws(() => resizeProject(initial, width, height), /16.*16384.*整数/)
    }
  }
  for (const [width, height] of [[MIN_PROJECT_SIZE, MAX_PROJECT_SIZE], [853, 479]]) {
    assert.equal(projectSizeError(width, height), undefined)
    assert.deepEqual([resizeProject(initial, width, height).width, resizeProject(initial, width, height).height], [width, height])
  }
})

test('手动调整同时缩放视觉片段和默认字幕，保留素材、音轨、时间与项目其他设置', () => {
  let project = createProject('多轨项目', { width: 1920, height: 1080, fps: 60, background: '#123456' })
  const source = { ...landscape, url: 'blob:source-video', nativePath: '/media/source.webm', duration: 20 }
  const sound = { ...video('sound', 0, 0), kind: 'audio', mime: 'audio/wav', duration: 10 }
  project = addAssets(project, [source, sound])
  const visual = createClip(source, project, { start: 3, trimIn: 2, trimOut: 12, speed: 2, x: -120, y: 50, width: 1000, height: 600, rotation: 45, opacity: 0.7, fit: 'cover', fadeIn: 0.2 })
  project = addClip(project, project.tracks.find(track => track.kind === 'video').id, visual)
  project = addClip(project, project.tracks.find(track => track.kind === 'audio').id, createClip(sound, project, { start: 2, trimOut: 16, x: 80, width: 400 }))
  const subtitle = createSubtitleClip(project, { text: '尺寸调整', start: 4, color: '#ffcc55', textVerticalAlign: 'bottom' })
  project = addClip(project, project.tracks.find(track => track.kind === 'text').id, subtitle)
  project = updateClip(project, subtitle.id, { x: 120, y: 640, width: 1400, height: 240, fontSize: 72 })
  project.updatedAt = '2001-01-01T00:00:00.000Z'
  const original = structuredClone(project)
  const next = resizeProject(project, 960, 2160)
  const resized = next.tracks.find(track => track.kind === 'video').clips[0]
  assert.deepEqual([resized.x, resized.y, resized.width, resized.height], [-60, 100, 500, 1200])
  for (const key of ['start', 'trimIn', 'trimOut', 'speed', 'rotation', 'opacity', 'fit', 'fadeIn', 'generatedAt']) assert.equal(resized[key], visual[key])
  for (const style of [next.tracks.find(track => track.kind === 'text').clips[0], next.subtitleStyle]) {
    assert.deepEqual([style.x, style.y, style.width, style.height, style.fontSize], [60, 1280, 700, 480, 36])
    assert.equal(style.color, '#ffcc55')
    assert.equal(style.textVerticalAlign, 'bottom')
  }
  assert.deepEqual(next.assets, original.assets)
  assert.deepEqual(next.tracks.find(track => track.kind === 'audio'), original.tracks.find(track => track.kind === 'audio'))
  for (const key of ['title', 'id', 'createdAt', 'fps', 'background']) assert.equal(next[key], original[key])
  assert.equal(next.autoSizeFromVideo, false)
  assert.ok(Date.parse(next.updatedAt) > Date.parse(original.updatedAt))
  assert.deepEqual(project, original)
})

test('极端尺寸变更保留有效的几何和字号范围', () => {
  let project = createProject('极小画布', { width: 16, height: 16 })
  const subtitle = createSubtitleClip(project, { x: -100, y: 100, width: 100, height: 100, fontSize: 1024 })
  project = addClip(project, project.tracks.find(track => track.kind === 'text').id, subtitle)
  project = updateClip(project, subtitle.id, { fontSize: 2048 })
  const huge = resizeProject(project, 16384, 16384)
  for (const style of [huge.tracks.find(track => track.kind === 'text').clips[0], huge.subtitleStyle]) {
    assert.deepEqual([style.x, style.y, style.width, style.height, style.fontSize], [-65536, 65536, 65536, 65536, 2048])
  }
  const smallClip = createSubtitleClip(huge, { width: 1, height: 1, fontSize: 4 })
  const small = resizeProject(addClip(huge, huge.tracks.find(track => track.kind === 'text').id, smallClip), 16, 16)
  assert.deepEqual([small.tracks.find(track => track.kind === 'text').clips[1].width, small.tracks.find(track => track.kind === 'text').clips[1].height, small.tracks.find(track => track.kind === 'text').clips[1].fontSize], [1, 1, 4])
})

test('重复尺寸不产生新状态，明确确认相同尺寸仍会关闭首次自动匹配', () => {
  const fixed = createProject('固定尺寸', { width: 1920, height: 1080 })
  assert.strictEqual(resizeProject(fixed, 1920, 1080), fixed)
  for (const auto of [true, undefined]) {
    const project = { ...fixed, autoSizeFromVideo: auto }
    if (auto === undefined) delete project.autoSizeFromVideo
    const resized = resizeProject(project, 1920, 1080)
    assert.notStrictEqual(resized, project)
    assert.equal(resized.autoSizeFromVideo, false)
    assert.deepEqual(resized.tracks, project.tracks)
    assert.strictEqual(adoptFirstVideoSize(resized, [portrait]), resized)
  }
})

test('源尺寸取自已校正方向的视频素材，忽略片段的缩放、旋转与适配方式', () => {
  let project = addAssets(createProject('手动项目', { width: 1920, height: 1080 }), [portrait])
  const clip = createClip(portrait, project, { x: 90, y: 50, width: 200, height: 300, rotation: 90, fit: 'fill' })
  project = addClip(project, project.tracks.find(track => track.kind === 'video').id, clip)
  const original = structuredClone(project)
  assert.deepEqual(videoClipSourceSize(project, clip.id), { width: 1080, height: 1920 })
  const result = resizeProjectToVideoClip(project, clip.id)
  assert.deepEqual([result.width, result.height, result.autoSizeFromVideo], [1080, 1920, false])
  assert.equal(result.tracks.find(track => track.kind === 'video').clips[0].rotation, 90)
  assert.deepEqual(result.assets, project.assets)
  assert.deepEqual(project, original)
})

test('匹配源尺寸拒绝锁定、非视频、缺失素材以及非法源尺寸', () => {
  let project = addAssets(createProject(), [portrait, { ...landscape, id: 'still', kind: 'image', mime: 'image/png' }])
  const clip = createClip(portrait, project)
  project = addClip(project, project.tracks.find(track => track.kind === 'video').id, clip)
  const image = createClip(project.assets[1], project)
  project = addClip(project, project.tracks.find(track => track.kind === 'video').id, image)
  const audioTrackVideo = createClip(portrait, project)
  project = addClip(project, project.tracks.find(track => track.kind === 'audio').id, audioTrackVideo)
  const subtitle = createSubtitleClip(project)
  project = addClip(project, project.tracks.find(track => track.kind === 'text').id, subtitle)
  for (const id of ['missing', image.id, audioTrackVideo.id, subtitle.id]) {
    assert.equal(videoClipSourceSize(project, id), undefined)
    assert.throws(() => resizeProjectToVideoClip(project, id), /源视频素材/)
  }
  const missingSource = { ...project, assets: project.assets.filter(asset => asset.id !== portrait.id) }
  assert.equal(videoClipSourceSize(missingSource, clip.id), undefined)
  assert.throws(() => resizeProjectToVideoClip(missingSource, clip.id), /源视频素材/)
  const locked = structuredClone(project)
  locked.tracks.find(track => track.kind === 'video').locked = true
  assert.deepEqual(videoClipSourceSize(locked, clip.id), { width: 1080, height: 1920 })
  assert.throws(() => resizeProjectToVideoClip(locked, clip.id), /解锁/)
  for (const width of [8, 20000, 853.5, NaN]) {
    const invalid = { ...project, assets: project.assets.map(asset => asset.id === portrait.id ? { ...asset, width } : asset) }
    assert.throws(() => resizeProjectToVideoClip(invalid, clip.id), /整数/)
  }
})

test('手动尺寸及视觉位置可整体撤销重做，项目文件往返保持尺寸和字幕默认样式', async () => {
  let initial = createProject()
  const subtitle = createSubtitleClip(initial, { text: '保存尺寸和样式' })
  initial = addClip(initial, initial.tracks.find(track => track.kind === 'text').id, subtitle)
  initial = updateClip(initial, subtitle.id, { color: '#ffeedd', textAlign: 'right' })
  const resized = resizeProject(initial, 853, 479)
  const history = commitHistory(createHistory(initial), resized)
  assert.deepEqual(undoHistory(history).present, initial)
  assert.deepEqual(redoHistory(undoHistory(history)).present, resized)
  const loaded = await importProjectFile(await exportProjectFile(resized))
  try { assert.deepEqual(loaded.project, resized) } finally { loaded.revoke() }
})
